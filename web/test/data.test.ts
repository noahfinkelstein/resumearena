import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RankShard } from '@resumearena/shared';
import { apiContentsUrl, apiDisabled, DataError, fiveMinuteBucket, getJson, getRankEntries, getResumeDoc, minuteBucket, pagesMetaUrl, pagesVersionedUrl, rawUrl, resumePath, userPath } from '../src/lib/data.ts';

const response = (status: number, body: string, type: string): Response => new Response(body, { status, headers: { 'content-type': type } });

describe('getJson', () => {
  it('returns parsed JSON on 200 application/json', async () => {
    const fetchImpl = vi.fn(async () => response(200, '{"a":1}', 'application/json; charset=utf-8'));
    await expect(getJson('/x.json', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ a: 1 });
  });

  it('treats a 404 as null (Pages serves 404.html with status 404)', async () => {
    const fetchImpl = vi.fn(async () => response(404, '<!doctype html><title>ResumeArena</title>', 'text/html'));
    await expect(getJson('/missing.json', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a raw 404 text body as null', async () => {
    const fetchImpl = vi.fn(async () => response(404, '404: Not Found', 'text/plain; charset=utf-8'));
    await expect(getJson('/raw.json', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBeNull();
  });

  it('treats a 200 HTML body as missing (SPA fallback served instead of a data file)', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<!doctype html><html></html>', 'text/html'));
    await expect(getJson('/index-instead.json', { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBeNull();
  });

  it('retries once after 2 s on a 5xx and then throws DataError', async () => {
    const fetchImpl = vi.fn(async () => response(503, 'nope', 'text/plain'));
    const sleep = vi.fn(async () => undefined);
    await expect(getJson('/x.json', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep })).rejects.toBeInstanceOf(DataError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('succeeds when the retry succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (n++ === 0 ? response(500, '', 'text/plain') : response(200, '[1]', 'application/json')));
    await expect(getJson('/x.json', { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined })).resolves.toEqual([1]);
  });

  it('does not retry when told not to', async () => {
    const fetchImpl = vi.fn(async () => response(500, '', 'text/plain'));
    await expect(getJson('/x.json', { fetchImpl: fetchImpl as unknown as typeof fetch, retry: false })).rejects.toBeInstanceOf(DataError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends cache: no-cache for raw fetches', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => response(200, '{}', 'application/json'));
    await getJson('/x.json', { fetchImpl: fetchImpl as unknown as typeof fetch, noCache: true });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).toBe('no-cache');
  });
});

describe('getResumeDoc sources', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ID = 'k7q2m3xw5a';
  const doc = JSON.stringify({ schema: 1, id: ID, status: 'analyzed' });
  const calls = (): { url: string; accept: string | undefined }[] =>
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => {
      const [url, init] = c as [string, RequestInit | undefined];
      return { url, accept: (init?.headers as Record<string, string> | undefined)?.accept };
    });

  it('reads raw by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, doc, 'application/json')));
    await expect(getResumeDoc(ID)).resolves.toMatchObject({ id: ID });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.url).toContain(`/${resumePath(ID)}?r=`);
    expect(calls()[0]?.url).not.toContain('api.github.com');
  });

  it("source 'api' reads the contents API on the data branch, raw media type, no auth", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, doc, 'application/vnd.github.raw+json; charset=utf-8')));
    await expect(getResumeDoc(ID, { source: 'api' })).resolves.toMatchObject({ id: ID });
    const [c] = calls();
    expect(c?.url).toBe(apiContentsUrl(resumePath(ID)));
    expect(c?.url).toMatch(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/resumes\/k7\/k7q2m3xw5a\.json\?ref=data$/);
    expect(c?.accept).toBe('application/vnd.github.raw+json');
    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).toBe('no-cache');
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
    expect(calls()).toHaveLength(1);
  });

  it('an API 404 is a missing doc; raw is not asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, '{"message":"Not Found"}', 'application/json')));
    await expect(getResumeDoc(ID, { source: 'api' })).resolves.toBeNull();
    expect(calls()).toHaveLength(1);
  });

  it('a 403 or 429 from the API turns it off for the session and falls back to raw at once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('https://api.github.com/') ? response(403, '{"message":"rate limited"}', 'application/json') : response(200, doc, 'application/json'))),
    );
    expect(apiDisabled()).toBe(false);
    await expect(getResumeDoc(ID, { source: 'api' })).resolves.toMatchObject({ id: ID });
    expect(calls().map((c) => c.url.includes('api.github.com'))).toEqual([true, false]);
    expect(apiDisabled()).toBe(true);
    expect(sessionStorage.getItem('resumearena.apiOff')).toBe('1');
    // The next pending poll goes straight to raw.
    await expect(getResumeDoc(ID, { source: 'api' })).resolves.toMatchObject({ id: ID });
    expect(calls()).toHaveLength(3);
    expect(calls()[2]?.url).not.toContain('api.github.com');
  });

  it('any other API failure falls back to raw for that read without turning the API off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('https://api.github.com/') ? response(502, 'bad gateway', 'text/plain') : response(200, doc, 'application/json'))),
    );
    await expect(getResumeDoc(ID, { source: 'api' })).resolves.toMatchObject({ id: ID });
    expect(calls().map((c) => c.url.includes('api.github.com'))).toEqual([true, false]);
    expect(apiDisabled()).toBe(false);
  });
});

describe('getRankEntries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports which shards were read: present, 404, failed, and beyond the cap', async () => {
    const k7: RankShard = { k7q2m3xw5a: { h: null, v: 'anonymous', st: 'mid', sig: '', p: 'general' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/rank/k7.json')) return response(200, JSON.stringify(k7), 'application/json');
        if (url.includes('/rank/x6.json')) return response(404, '<!doctype html>', 'text/html');
        return response(500, '', 'text/plain');
      }),
    );
    const r = await getRankEntries(['k7q2m3xw5a', 'k7zzzzzzzz', 'x6ppa2a7mq', 'zzzzzzzzzz', 'qqqqqqqqqq'], 'b1', { max: 3 });
    expect([...r.entries.keys()]).toEqual(['k7q2m3xw5a']);
    // k7 and x6 were read (x6 came back 404); zz failed; qq was beyond the cap.
    expect([...r.fetched].sort()).toEqual(['k7', 'x6']);
  });
});

describe('cache keys (§10.3)', () => {
  it('meta files vary per minute, versioned files per build id, raw per five minutes or per minute while polling', () => {
    const now = 1_759_500_662_000;
    expect(pagesMetaUrl('manifest.json', now)).toMatch(new RegExp(`data/manifest\\.json\\?t=${minuteBucket(now)}$`));
    expect(pagesVersionedUrl('rank/k7.json', '412345678.1')).toMatch(/data\/rank\/k7\.json\?v=412345678\.1$/);
    expect(rawUrl(resumePath('k7q2m3xw5a'), { now })).toMatch(new RegExp(`resumes/k7/k7q2m3xw5a\\.json\\?r=${fiveMinuteBucket(now)}$`));
    expect(rawUrl(userPath('priya-n'), { polling: true, now })).toMatch(new RegExp(`users/pr/priya-n\\.json\\?r=${minuteBucket(now)}$`));
  });
});
