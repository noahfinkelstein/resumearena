// The wire contract (§7.1): identical validation in the browser and the engine.
import type { Category, LayoutMetrics, RejectCode, SubmissionInput, SubmissionPayload, SubmissionSource, SubmitAction, Visibility } from './types.ts';
import { CLIENT_VERSION_RE, MAX_METRICS_JSON_CHARS, MAX_TEXT_CHARS, MIN_TEXT_CHARS } from './constants.ts';
import { ID_RE, isAnchorId } from './ids.ts';
import { validateHandle, type HandleVerdict } from './handles.ts';
import { OWNER_HASH_RE, parseOwnerKey } from './owner-key.ts';
import { scrubPii } from './scrub.ts';
import { sha256Hex } from './hash.ts';
import { LayoutMetricsZ } from './schemas/data.ts';

export const ACTIONS = ['submit', 'delete', 'set_visibility'] as const satisfies readonly SubmitAction[];
export const VISIBILITIES = ['handle', 'anonymous'] as const satisfies readonly Visibility[];
const CATEGORY_SET = new Set<string>(['general', 'finance', 'tech', 'academia']);

export type PayloadField = keyof SubmissionPayload;

export interface PayloadError {
  ok: false;
  code: Extract<RejectCode, 'bad_payload' | 'too_short' | 'too_long' | 'text_not_scrubbed' | 'handle_taken'>;
  field: PayloadField;
  /** For handles: which check failed, so the SPA can word the hint. */
  reason?: HandleVerdict | string;
  message: string;
}

/** Everything normalizePayload produces except the text hash, which needs an await. */
export interface CheckedPayload {
  action: SubmitAction;
  id: string;
  handle: string;
  /** '' only when owner_key is present and the hash was not sent; normalizePayload fills it in. */
  owner_hash: string;
  owner_key: string | null;
  visibility: Visibility;
  text: string;
  metrics: LayoutMetrics;
  ladder_hint: Category;
  client_version: string;
}

export type CheckResult = { ok: true; value: CheckedPayload } | PayloadError;
export type NormalizeResult = { ok: true; input: SubmissionInput } | PayloadError;

const fail = (code: PayloadError['code'], field: PayloadField, message: string, reason?: string): PayloadError =>
  reason === undefined ? { ok: false, code, field, message } : { ok: false, code, field, reason, message };

// C0/C1 controls except \n and \t, plus zero-width and bidi characters that hide text from readers.
const CONTROL_RE = new RegExp(
  ['\u0000-\u0008', '\u000B\u000C', '\u000E-\u001F', '\u007F-\u009F', '\u200B-\u200F', '\u2028-\u202E', '\u2060-\u2064', '\uFEFF'].map((r) => `[${r}]`).join('|'),
  'gu',
);

/** NFC, `\r\n`→`\n`, control characters stripped, trimmed. The SPA shows exactly this text. */
export function normalizeText(raw: string): string {
  return raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim();
}

function str(payload: Record<string, unknown>, field: PayloadField): string | null {
  const v = payload[field];
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : null;
}

/** Parse `metrics_json`: unknown keys dropped, missing numbers → 0, missing source → paste. */
export function parseMetricsJson(json: string): LayoutMetrics | null {
  if (json.length > MAX_METRICS_JSON_CHARS) return null;
  const trimmed = json.trim();
  let parsed: unknown;
  try {
    parsed = trimmed === '' ? {} : JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = LayoutMetricsZ.safeParse(parsed);
  return r.success ? r.data : null;
}

/** Synchronous validation of the ten inputs. The engine and the SPA both call this (through normalizePayload). */
export function checkPayload(raw: unknown): CheckResult {
  if (!raw || typeof raw !== 'object') return fail('bad_payload', 'action', 'payload is not an object');
  const p = raw as Record<string, unknown>;
  const fields: Record<PayloadField, string> = {} as Record<PayloadField, string>;
  for (const f of ['action', 'submission_id', 'handle', 'owner_hash', 'visibility', 'text', 'metrics_json', 'ladder_hint', 'client_version', 'owner_key'] as const) {
    const v = str(p, f);
    if (v === null) return fail('bad_payload', f, `${f} must be a string`);
    fields[f] = v;
  }

  const action = fields.action.trim();
  if (!(ACTIONS as readonly string[]).includes(action)) return fail('bad_payload', 'action', 'unknown action');

  const id = fields.submission_id.trim();
  if (!ID_RE.test(id) || isAnchorId(id)) return fail('bad_payload', 'submission_id', 'invalid submission id');

  const handle = fields.handle.trim();
  const hv = validateHandle(handle);
  if (hv !== 'ok') return fail('handle_taken', 'handle', 'handle not available', hv);

  const ownerHash = fields.owner_hash.trim();
  const keyPresent = fields.owner_key.trim() !== '';
  // The delete Issue Form carries no owner_hash; with a key present the hash is derived from it in normalizePayload.
  if (!OWNER_HASH_RE.test(ownerHash) && !(ownerHash === '' && keyPresent)) return fail('bad_payload', 'owner_hash', 'owner_hash must be 64 lowercase hex characters');

  const ladderRaw = fields.ladder_hint.trim();
  if (ladderRaw !== '' && !CATEGORY_SET.has(ladderRaw)) return fail('bad_payload', 'ladder_hint', 'unknown ladder');
  const ladder_hint = (ladderRaw === '' ? 'general' : ladderRaw) as Category;

  const client_version = fields.client_version.trim();
  if (!CLIENT_VERSION_RE.test(client_version)) return fail('bad_payload', 'client_version', 'invalid client_version');

  const keyRaw = fields.owner_key.trim();
  let owner_key: string | null = null;
  if (keyRaw !== '') {
    owner_key = parseOwnerKey(keyRaw);
    if (owner_key === null) return fail('bad_payload', 'owner_key', 'owner_key is not a key');
  } else if (action !== 'submit') {
    return fail('bad_payload', 'owner_key', `${action} requires owner_key`);
  }

  const visRaw = fields.visibility.trim();
  let visibility: Visibility = 'anonymous';
  if (action === 'delete') {
    if (visRaw !== '' && !(VISIBILITIES as readonly string[]).includes(visRaw)) return fail('bad_payload', 'visibility', 'unknown visibility');
    if (visRaw !== '') visibility = visRaw as Visibility;
  } else {
    if (!(VISIBILITIES as readonly string[]).includes(visRaw)) return fail('bad_payload', 'visibility', 'visibility must be handle or anonymous');
    visibility = visRaw as Visibility;
  }

  let text = '';
  let metrics: LayoutMetrics;
  if (action === 'submit') {
    text = normalizeText(fields.text);
    if (text.length < MIN_TEXT_CHARS) return fail('too_short', 'text', `text must be at least ${MIN_TEXT_CHARS} characters`);
    if (text.length > MAX_TEXT_CHARS) return fail('too_long', 'text', `text must be at most ${MAX_TEXT_CHARS} characters`);
    if (scrubPii(text).text !== text) return fail('text_not_scrubbed', 'text', 'text still contains personal data');
    const parsed = parseMetricsJson(fields.metrics_json);
    if (!parsed) return fail('bad_payload', 'metrics_json', 'metrics_json is not a LayoutMetrics object');
    metrics = parsed;
  } else {
    const parsed = parseMetricsJson(fields.metrics_json === '' ? '{}' : fields.metrics_json);
    metrics = parsed ?? (parseMetricsJson('{}') as LayoutMetrics);
  }

  return {
    ok: true,
    value: { action: action as SubmitAction, id, handle, owner_hash: ownerHash, owner_key, visibility, text, metrics, ladder_hint, client_version },
  };
}

/** checkPayload plus the text hash. The engine passes the run's source; the SPA can pass a dispatch stub. */
export async function normalizePayload(raw: unknown, source: SubmissionSource): Promise<NormalizeResult> {
  const checked = checkPayload(raw);
  if (!checked.ok) return checked;
  const v = checked.value;
  const text_sha256 = await sha256Hex(v.text);
  let ownerHash = v.owner_hash;
  if (v.owner_key !== null) {
    const fromKey = await sha256Hex(v.owner_key);
    if (ownerHash === '') ownerHash = fromKey;
    else if (ownerHash !== fromKey) return fail('bad_payload', 'owner_hash', 'owner_hash does not match owner_key');
  }
  return {
    ok: true,
    input: {
      action: v.action,
      id: v.id,
      handle: v.handle,
      owner_hash: ownerHash,
      owner_key: v.owner_key,
      visibility: v.visibility,
      text: v.text,
      text_sha256,
      metrics: v.metrics,
      ladder_hint: v.ladder_hint,
      source,
    },
  };
}

/** The dispatch inputs for a submission, with every field a string (§7.1). */
export function buildPayload(input: {
  action: SubmitAction;
  id: string;
  handle: string;
  owner_hash: string;
  visibility?: Visibility | '';
  text?: string;
  metrics?: LayoutMetrics | null;
  ladder_hint?: Category | '';
  client_version?: string;
  owner_key?: string;
}): SubmissionPayload {
  return {
    action: input.action,
    submission_id: input.id,
    handle: input.handle,
    owner_hash: input.owner_hash,
    visibility: input.visibility ?? (input.action === 'delete' ? '' : 'anonymous'),
    text: input.text ?? '',
    metrics_json: input.metrics ? JSON.stringify(input.metrics) : '{}',
    ladder_hint: input.ladder_hint ?? '',
    client_version: input.client_version ?? '',
    owner_key: input.owner_key ?? '',
  };
}
