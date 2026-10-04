import { describe, expect, it, vi } from 'vitest';
import { buildPayload } from '@resumearena/shared';
import { dispatch, dispatchWithRetry, issueFormUrl, mapDispatchResponse, probeToken } from '../src/lib/github.ts';
import { readProbe } from '../src/lib/storage.ts';

const h = (map: Record<string, string> = {}): Pick<Headers, 'get'> => ({ get: (k: string) => map[k.toLowerCase()] ?? null });

describe('dispatch status mapping (§7.2)', () => {
  it('maps every documented status', () => {
    expect(mapDispatchResponse(204, h())).toEqual({ ok: true });
    expect(mapDispatchResponse(401, h())).toMatchObject({ ok: false, kind: 'token_dead' });
    expect(mapDispatchResponse(404, h())).toMatchObject({ ok: false, kind: 'token_dead' });
    expect(mapDispatchResponse(403, h())).toMatchObject({ ok: false, kind: 'token_dead' });
    expect(mapDispatchResponse(403, h({ 'x-ratelimit-remaining': '0' }))).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(mapDispatchResponse(403, h({ 'retry-after': '30' }))).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterS: 30 });
    expect(mapDispatchResponse(429, h({ 'retry-after': '12' }))).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterS: 12 });
    expect(mapDispatchResponse(422, h())).toMatchObject({ ok: false, kind: 'invalid' });
    expect(mapDispatchResponse(500, h())).toMatchObject({ ok: false, kind: 'network' });
    expect(mapDispatchResponse(502, h())).toMatchObject({ ok: false, kind: 'network' });
  });
});

const payload = buildPayload({ action: 'submit', id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: 'a'.repeat(64), visibility: 'anonymous', text: 'x'.repeat(400), ladder_hint: 'tech', client_version: 'test' });

describe('dispatch()', () => {
  it('fails as token_dead without a token and never calls fetch', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', '');
    const f = vi.fn();
    expect(await dispatch(payload, f as unknown as typeof fetch)).toEqual({ ok: false, kind: 'token_dead' });
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the ten inputs with ref main and maps the response', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/actions\/workflows\/submit\.yml\/dispatches$/);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer github_pat_test');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
      const body = JSON.parse(init.body as string) as { ref: string; inputs: Record<string, string> };
      expect(body.ref).toBe('main');
      expect(Object.keys(body.inputs).sort()).toEqual(['action', 'client_version', 'handle', 'ladder_hint', 'metrics_json', 'owner_hash', 'owner_key', 'submission_id', 'text', 'visibility']);
      return new Response(null, { status: 204 });
    });
    expect(await dispatch(payload, f as unknown as typeof fetch)).toEqual({ ok: true });
  });

  it('maps a thrown fetch to network', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await dispatch(payload, f as unknown as typeof fetch)).toEqual({ ok: false, kind: 'network' });
  });

  it('retries network failures 2/4/8/16 s and stops on a non-network answer', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error('offline');
      return new Response(null, { status: 429 });
    });
    const sleeps: number[] = [];
    const r = await dispatchWithRetry(payload, { fetchImpl: f as unknown as typeof fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(r).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('gives up after four retries', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    const sleeps: number[] = [];
    const r = await dispatchWithRetry(payload, { fetchImpl: f as unknown as typeof fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(r).toEqual({ ok: false, kind: 'network' });
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
    expect(f).toHaveBeenCalledTimes(5);
  });
});

describe('probeToken()', () => {
  it('caches the verdict for ten minutes in sessionStorage', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await probeToken({ fetchImpl: f as unknown as typeof fetch, now: 1000 })).toBe('ok');
    expect(await probeToken({ fetchImpl: f as unknown as typeof fetch, now: 2000 })).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    expect(readProbe()).toEqual({ at: 1000, v: 'ok' });
    expect(await probeToken({ fetchImpl: f as unknown as typeof fetch, now: 1000 + 11 * 60_000 })).toBe('ok');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('maps 401/404 to dead and a zero rate limit to limited', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', 'github_pat_test');
    expect(await probeToken({ fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch, force: true })).toBe('dead');
    expect(await probeToken({ fetchImpl: (async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as unknown as typeof fetch, force: true })).toBe('limited');
    expect(await probeToken({ fetchImpl: (async () => { throw new Error('x'); }) as unknown as typeof fetch, force: true })).toBe('unknown');
  });

  it('is dead without a token', async () => {
    vi.stubEnv('VITE_SUBMIT_TOKEN', '');
    expect(await probeToken({ force: true })).toBe('dead');
  });
});

describe('issueFormUrl()', () => {
  it('prefills the small fields for a submission and never the text', () => {
    const u = new URL(issueFormUrl(payload));
    expect(u.hostname).toBe('github.com');
    expect(u.pathname).toMatch(/\/issues\/new$/);
    expect(u.searchParams.get('template')).toBe('submission.yml');
    expect(u.searchParams.get('title')).toBe('submission: k7q2m3xw5a');
    expect(u.searchParams.get('submission_id')).toBe('k7q2m3xw5a');
    expect(u.searchParams.get('owner_hash')).toBe('a'.repeat(64));
    expect(u.searchParams.get('ladder_hint')).toBe('tech');
    expect(u.searchParams.has('text')).toBe(false);
  });

  it('uses the delete template without the key', () => {
    const del = buildPayload({ action: 'delete', id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: 'a'.repeat(64), owner_key: 'rak-aaaa' });
    const u = new URL(issueFormUrl(del));
    expect(u.searchParams.get('template')).toBe('delete.yml');
    expect(u.searchParams.has('owner_key')).toBe(false);
    expect(u.searchParams.has('owner_hash')).toBe(false);
  });
});
