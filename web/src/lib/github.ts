// The only GitHub API traffic the browser makes (§7.2, D-30): one dispatch and one cached probe. The
// Issue Form URL is a navigation, not a fetch.
import { REPO, type SubmissionPayload } from '@resumearena/shared';
import { readProbe, writeProbe } from './storage.ts';
import { mockDispatch, mockProbe } from './mock.ts';

export type DispatchResult =
  | { ok: true }
  | { ok: false; kind: 'token_dead' | 'rate_limited' | 'invalid' | 'network'; retryAfterS?: number; status?: number };

export type ProbeResult = 'ok' | 'dead' | 'limited' | 'unknown';

const IS_MOCK = import.meta.env.VITE_MOCK === '1';
export const repo = (): string => import.meta.env.VITE_REPO || REPO;
export const token = (): string => import.meta.env.VITE_SUBMIT_TOKEN ?? '';
export const hasToken = (): boolean => token().trim().length > 0;
export const manageEnabled = (): boolean => (import.meta.env.VITE_MANAGE ?? '1') !== '0';

const API = 'https://api.github.com';
const workflowUrl = (): string => `${API}/repos/${repo()}/actions/workflows/submit.yml`;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** Status → result mapping from §7.2. Exported for tests; `dispatch` applies it to the real response. */
export function mapDispatchResponse(status: number, h: Pick<Headers, 'get'>): DispatchResult {
  if (status === 204) return { ok: true };
  if (status === 401 || status === 404) return { ok: false, kind: 'token_dead', status };
  if (status === 403) {
    const remaining = h.get('x-ratelimit-remaining');
    const retryAfter = h.get('retry-after');
    if (remaining === '0' || retryAfter !== null) {
      const r: DispatchResult = { ok: false, kind: 'rate_limited', status };
      const secs = retryAfterSeconds(retryAfter, h.get('x-ratelimit-reset'));
      if (secs !== undefined) r.retryAfterS = secs;
      return r;
    }
    return { ok: false, kind: 'token_dead', status };
  }
  if (status === 429) {
    const r: DispatchResult = { ok: false, kind: 'rate_limited', status };
    const secs = retryAfterSeconds(h.get('retry-after'), h.get('x-ratelimit-reset'));
    if (secs !== undefined) r.retryAfterS = secs;
    return r;
  }
  if (status === 422) return { ok: false, kind: 'invalid', status };
  return { ok: false, kind: 'network', status };
}

function retryAfterSeconds(retryAfter: string | null, reset: string | null): number | undefined {
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
  return undefined;
}

/** POST the ten inputs. 204 means accepted, nothing more. Never throws. */
export async function dispatch(payload: SubmissionPayload, fetchImpl: typeof fetch = globalThis.fetch): Promise<DispatchResult> {
  if (IS_MOCK) return mockDispatch(payload);
  if (!hasToken()) return { ok: false, kind: 'token_dead' };
  try {
    const res = await fetchImpl(`${workflowUrl()}/dispatches`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ref: 'main', inputs: payload }),
    });
    return mapDispatchResponse(res.status, res.headers);
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export interface RetryOptions {
  /** Backoff schedule in ms; §7.2 says four retries at 2/4/8/16 s. */
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  onAttempt?: (n: number) => void;
}

/** dispatch with the network-error retry schedule. Non-network failures return immediately. */
export async function dispatchWithRetry(payload: SubmissionPayload, opts: RetryOptions = {}): Promise<DispatchResult> {
  const delays = opts.delays ?? [2000, 4000, 8000, 16000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: DispatchResult = { ok: false, kind: 'network' };
  for (let i = 0; i <= delays.length; i++) {
    opts.onAttempt?.(i);
    last = await dispatch(payload, opts.fetchImpl ?? globalThis.fetch);
    if (last.ok || last.kind !== 'network') return last;
    const d = delays[i];
    if (d === undefined) break;
    await sleep(d);
  }
  return last;
}

const PROBE_TTL_MS = 10 * 60_000;

/** GET the workflow with the embedded token, cached 10 min in sessionStorage['resumearena.probe']. */
export async function probeToken(opts: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<ProbeResult> {
  if (IS_MOCK) return mockProbe();
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const cached = readProbe();
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.v;
  }
  if (!hasToken()) {
    writeProbe({ at: now, v: 'dead' });
    return 'dead';
  }
  let v: ProbeResult = 'unknown';
  try {
    const res = await (opts.fetchImpl ?? globalThis.fetch)(workflowUrl(), { headers: headers() });
    if (res.status === 200) v = 'ok';
    else if (res.status === 401 || res.status === 404) v = 'dead';
    else if (res.status === 403 || res.status === 429) v = res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429 ? 'limited' : 'dead';
  } catch {
    v = 'unknown';
  }
  if (v !== 'unknown') writeProbe({ at: now, v });
  return v;
}

/** Remember a dead token for the session after a dispatch says so. */
export function markProbeDead(): void {
  writeProbe({ at: Date.now(), v: 'dead' });
}

/** §7.3 prefill. The text is pasted by the person; it never fits in a URL. */
export function issueFormUrl(p: SubmissionPayload): string {
  const u = new URL(`https://github.com/${repo()}/issues/new`);
  if (p.action === 'delete') {
    u.searchParams.set('template', 'delete.yml');
    u.searchParams.set('title', `delete: ${p.submission_id}`);
    u.searchParams.set('submission_id', p.submission_id);
    u.searchParams.set('handle', p.handle);
    // The key is deliberately not prefilled: the person pastes it so the URL never carries it.
    return u.toString();
  }
  u.searchParams.set('template', 'submission.yml');
  u.searchParams.set('title', `submission: ${p.submission_id}`);
  u.searchParams.set('submission_id', p.submission_id);
  u.searchParams.set('handle', p.handle);
  u.searchParams.set('owner_hash', p.owner_hash);
  u.searchParams.set('visibility', p.visibility || 'anonymous');
  u.searchParams.set('ladder_hint', p.ladder_hint || 'general');
  u.searchParams.set('metrics_json', p.metrics_json);
  if (p.client_version) u.searchParams.set('client_version', p.client_version);
  return u.toString();
}

/** The contact mailbox is a build variable (VITE_CONTACT_EMAIL from vars.CONTACT_EMAIL); unset means none is published. */
export const contactEmail = (): string | null => {
  const v = (import.meta.env.VITE_CONTACT_EMAIL ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

export const clientVersion = (): string => (import.meta.env.VITE_BUILD_ID ?? 'dev').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 24);
export const repoUrl = (): string => `https://github.com/${repo()}`;
