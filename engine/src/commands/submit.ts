// `submit --event <path> | --payload <json>` (§9.3): adapter → normalize → pipeline → summary → Issue bookkeeping.
import { readFile } from 'node:fs/promises';
import {
  CLIENT_VERSION_RE, ID_RE, isAnchorId, issueFieldsCarryKey, normalizePayload, parseIssueForm, parseOwnerKey, timingSafeEqualString, validateHandle,
  type RejectCode, type SubmissionInput, type SubmissionPayload, type SubmissionSource,
} from '@resumearena/shared';
import type { Context } from '../context.ts';
import { numericRunId } from '../env.ts';
import { readEvent } from '../adapters/normalize.ts';
import { payloadFromInputs } from '../adapters/dispatch.ts';
import { LABEL_DELETE, redactOwnerKeyLine, type IssueEvent } from '../adapters/issue.ts';
import { acknowledgeIssue, editIssueBody, failIssue, finishIssue, resultUrl } from '../github/issues.ts';
import { enableWorkflows, submissionsLastHour } from '../github/runs.ts';
import { sha256Hex } from '../rng.ts';
import { loadSettings } from '../settings.ts';
import { decide } from '../store/commit.ts';
import { resumePath, userPath } from '../store/paths.ts';
import { markdownTable, writeSummary } from '../summary.ts';
import { rejectedStub } from '../submit/docs.ts';
import { IdCollisionError, processManage, processSubmission, type SubmitReport } from '../submit/pipeline.ts';
import { readUserDoc } from '../submit/precheck.ts';

export interface SubmitArgs {
  event?: string;
  payload?: string;
  summary?: string;
}

export type SubmitCommandOutcome = SubmitReport['outcome'] | 'rate_limited' | 'bad_payload' | 'ignored';

export interface SubmitCommandResult {
  outcome: SubmitCommandOutcome;
  report: SubmitReport | null;
  exitCode: 0 | 1;
}

/** `--payload` accepts either a bare SubmissionPayload or `{ payload, source }`. */
async function readPayloadFile(path: string, runId: number): Promise<{ payload: SubmissionPayload; source: SubmissionSource }> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (raw.payload && typeof raw.payload === 'object') {
    const source = (raw.source as SubmissionSource | undefined) ?? { kind: 'dispatch', run_id: runId, issue_number: null, client_version: '' };
    return { payload: payloadFromInputs(raw.payload as Record<string, unknown>), source };
  }
  const payload = payloadFromInputs(raw);
  return { payload, source: { kind: 'dispatch', run_id: runId, issue_number: null, client_version: payload.client_version } };
}

/** Only validated identifiers reach the data branch: a source whose client_version failed the wire regex is blanked. */
function sanitizedSource(source: SubmissionSource): SubmissionSource {
  const v = source.client_version.trim();
  return { ...source, client_version: CLIENT_VERSION_RE.test(v) ? v : '' };
}

/** The rejected stub for a payload that never became a SubmissionInput: nothing unvalidated is copied in (§7.4). */
function stubInputFor(payload: SubmissionPayload, id: string, source: SubmissionSource): SubmissionInput {
  const h = payload.handle.trim();
  return {
    action: 'submit', id, handle: validateHandle(h) === 'ok' ? h : 'invalid',
    owner_hash: /^[0-9a-f]{64}$/.test(payload.owner_hash) ? payload.owner_hash : '0'.repeat(64), owner_key: null,
    visibility: 'anonymous', text: '', text_sha256: '0'.repeat(64), metrics: emptyMetrics(), ladder_hint: 'general', source: sanitizedSource(source),
  };
}

/** Writes `rejected(code)` for the id unless a document already exists there (a re-run must never overwrite). */
async function writeRejected(ctx: Context, input: SubmissionInput, code: RejectCode): Promise<void> {
  const now = ctx.clock.iso();
  await ctx.commit(`submit ${input.id}`, [
    decide([`/${resumePath(input.id)}`], async (store) => {
      if (await store.exists(resumePath(input.id))) return;
      await store.writeJson(resumePath(input.id), rejectedStub(input, now, code));
    }),
  ]);
}

/**
 * A key that appeared in a public issue body is burnt whatever the run's outcome: when it verifies
 * against the handle's users doc, `key_exposed` is set so it may only delete from now on (§3.3, §12).
 * writeDelete does this on the success path; this covers every failure after the key was readable.
 */
async function recordKeyExposure(ctx: Context, handleRaw: string, keyRaw: string | null): Promise<void> {
  if (!keyRaw) return;
  const key = parseOwnerKey(keyRaw);
  const handle = handleRaw.trim().toLowerCase();
  if (!key || validateHandle(handle) !== 'ok') return;
  const expected = sha256Hex(key);
  await ctx.store.materialize([`/users/${handle.slice(0, 2)}/`]);
  const user = await readUserDoc(ctx.store, handle).catch(() => null);
  if (!user || user.key_exposed || !timingSafeEqualString(expected, user.owner_hash)) return;
  await ctx.commit(`key exposed ${handle}`, [
    decide([`/${userPath(handle)}`], async (store) => {
      const fresh = await readUserDoc(store, handle).catch(() => null);
      if (!fresh || fresh.key_exposed || !timingSafeEqualString(expected, fresh.owner_hash)) return;
      await store.writeJson(userPath(handle), { ...fresh, key_exposed: true });
    }),
  ]);
  ctx.log.warn(`key for ${handle} was public in an issue body; marked key_exposed`);
}

export async function submitCommand(ctx: Context, args: SubmitArgs): Promise<SubmitCommandResult> {
  const started = Date.now();
  const runId = numericRunId(ctx.runId);
  let payload: SubmissionPayload;
  let source: SubmissionSource;
  let issue: IssueEvent['issue'] | null = null;
  if (args.payload) ({ payload, source } = await readPayloadFile(args.payload, runId));
  else if (args.event) {
    const ev = await readEvent(args.event, runId);
    if (ev.kind === 'ignored') {
      ctx.log.info(`submit: ignored event (${ev.reason})`);
      return { outcome: 'ignored', report: null, exitCode: 0 };
    }
    ({ payload, source, issue } = ev);
  } else throw new Error('submit needs --event <path> or --payload <json>');

  const settings = await loadSettings(ctx.store);

  // Issue path: the body is public. Any owner_key value is redacted before validation can fail, whatever
  // the template (§7.4, D-45); its raw text is kept only to burn the key if the request then fails.
  const isDeleteIssue = issue !== null && issue.labels.some((l) => l.name === LABEL_DELETE);
  let issueKey: string | null = null;
  if (issue) {
    const fields = parseIssueForm(issue.body ?? '');
    if (issueFieldsCarryKey(fields)) {
      issueKey = (fields.owner_key ?? '').trim();
      await editIssueBody(ctx.github, issue.number, redactOwnerKeyLine(issue.body ?? ''));
    }
  }

  const normalized = await normalizePayload(payload, source);
  if (!normalized.ok) {
    const id = payload.submission_id.trim();
    if (issue) await recordKeyExposure(ctx, payload.handle, issueKey);
    if (!ID_RE.test(id) || isAnchorId(id)) {
      ctx.log.info(`submit: bad_payload (${normalized.field}: ${normalized.message}); invalid submission_id, nothing to write`);
      if (issue) await failIssue(ctx.github, issue.number, 'bad_payload');
      return { outcome: 'bad_payload', report: null, exitCode: 0 };
    }
    // Enough shape to name the record; write the rejected stub unless the id already has a document.
    const stubInput = stubInputFor(payload, id, source);
    if (payload.action.trim() === 'submit') await writeRejected(ctx, stubInput, normalized.code);
    await writeSummary(args.summary, markdownTable(['id', 'outcome', 'code', 'field'], [[id, 'rejected', normalized.code, normalized.field]]));
    if (issue) await failIssue(ctx.github, issue.number, normalized.code);
    return { outcome: 'rejected', report: null, exitCode: 0 };
  }
  const input = normalized.input;

  // D-11, §7.3: the Issue path cannot resubmit. A submission body that carried a key is handle_taken, and the
  // key it exposed is burnt.
  if (issue && !isDeleteIssue && issueKey !== null) {
    await recordKeyExposure(ctx, input.handle, issueKey);
    if (input.action === 'submit') await writeRejected(ctx, input, 'handle_taken');
    await writeSummary(args.summary, markdownTable(['id', 'outcome', 'code', 'field'], [[input.id, 'rejected', 'handle_taken', 'owner_key']]));
    await failIssue(ctx.github, issue.number, 'handle_taken');
    return { outcome: 'rejected', report: null, exitCode: 0 };
  }
  if (issue && input.action === 'submit') await acknowledgeIssue(ctx.github, issue.number, input.id);

  // 2. Hourly cap (submit only): write nothing, exit 0 (D-43).
  if (input.action === 'submit' && !settings.paused) {
    const count = await submissionsLastHour(ctx.github, ctx.clock.now());
    if (count !== null && count > settings.max_submissions_per_hour) {
      ctx.log.info(`submit: rate_limited (${count} runs in the last hour > ${settings.max_submissions_per_hour})`);
      await writeSummary(args.summary, markdownTable(['id', 'outcome'], [[input.id, 'rate_limited']]));
      if (issue) await failIssue(ctx.github, issue.number, 'rate_limited');
      return { outcome: 'rate_limited', report: null, exitCode: 0 };
    }
  }

  let report: SubmitReport;
  try {
    report =
      input.action === 'submit'
        ? await processSubmission({ ctx, settings, wf: 'submit' }, input, payload)
        : await processManage({ ctx, settings, wf: 'submit' }, input, { exposeKey: issue !== null });
  } catch (e) {
    if (e instanceof IdCollisionError) {
      ctx.log.error(e.message);
      if (issue) await failIssue(ctx.github, issue.number, 'id_collision');
      return { outcome: 'noop', report: null, exitCode: 1 };
    }
    throw e;
  }
  await enableWorkflows(ctx.github);

  const v = report.gate;
  await writeSummary(
    args.summary,
    markdownTable(
      ['id', 'handle', 'source', 'outcome', 'code', 'gate', 'tokens', 'usd', 'wall_ms', 'commit'],
      [[report.id, report.anonymous ? 'anon' : report.handle, report.source, report.outcome, report.code ?? '', v ? `${v.is_resume ? 'resume' : 'not_resume'}/${v.language}${v.prompt_injection_detected ? '/inj' : ''}` : '', report.tok.in + report.tok.cr + report.tok.out, report.usd.toFixed(4), Date.now() - started, report.commit]],
    ),
  );
  if (issue) {
    const line = statusLine(report);
    if (report.outcome === 'key_mismatch') {
      // The key was public and verified for nobody's entry here, but it may still open the handle's users doc.
      await recordKeyExposure(ctx, input.handle, issueKey);
      await failIssue(ctx.github, issue.number, 'key_mismatch');
    } else await finishIssue(ctx.github, issue.number, line, input.action === 'delete');
  }
  return { outcome: report.outcome, report, exitCode: 0 };
}

function statusLine(r: SubmitReport): string {
  switch (r.outcome) {
    case 'analyzed':
      return `analyzed; placement queued (${resultUrl(r.id)})`;
    case 'held':
      return `held: ${r.code}`;
    case 'needs_review':
      return `needs review: ${r.code}`;
    case 'rejected':
      return `rejected: ${r.code}`;
    case 'duplicate':
      return `duplicate (${r.code})`;
    case 'queued':
      return `queued (${r.code})`;
    case 'deleted':
      return 'deleted';
    case 'visibility_set':
      return `visibility set to ${r.code}`;
    case 'noop':
      return 'already recorded';
    case 'key_mismatch':
      return 'key mismatch';
  }
}

const emptyMetrics = () => ({ source: 'paste' as const, pages: 0, columns_detected: 0 as const, font_count: 0, image_count: 0, char_count: 0, word_count: 0, extraction_quality: 0, redactions: { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 } });
