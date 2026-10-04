// Reading static JSON (§10.3). Pages files are versioned by build id or minute. raw files carry a
// ?r=<bucket> marker, but raw.githubusercontent.com ignores query strings when it keys its own cache
// (about five minutes), so the marker only separates entries in the browser's cache; it does not make
// raw any fresher. The one fresher source is the GitHub contents API, which the submitter's pending
// phase reads for its first ten minutes (`getResumeDoc` with source 'api'). 404 → null, anything else
// → DataError with one retry.
import {
  RANK_KEY,
  RAW_BASE,
  REPO,
  shardOf,
  handleShard,
  type ArenaPool,
  type Category,
  type HistoryDoc,
  type LadderMeta,
  type LadderPage,
  type Manifest,
  type PublicSettings,
  type PublicStatus,
  type RankEntry,
  type RankShard,
  type ResumeDoc,
  type UserDoc,
} from '@resumearena/shared';
import { mockOverlay } from './mock.ts';
import { KEYS, readRaw, writeRaw } from './storage.ts';

export class DataError extends Error {
  readonly status: number;
  constructor(status: number, message = `data fetch failed (${status})`) {
    super(message);
    this.name = 'DataError';
    this.status = status;
  }
}

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';

const baseUrl = (): string => import.meta.env.BASE_URL ?? '/';
export const PAGES_DATA = (): string => `${baseUrl()}data/`;
export const RAW_ROOT = (): string => (IS_MOCK ? `${baseUrl()}__raw/` : `${RAW_BASE}/`);
export const API_ROOT = 'https://api.github.com';
export const repoName = (): string => import.meta.env.VITE_REPO || REPO;

/** Where a raw-tree document is read from: the CDN (raw) or the contents API (api), see `getResumeDoc`. */
export type DocSource = 'api' | 'raw';

export const minuteBucket = (now = Date.now()): number => Math.floor(now / 60_000);
export const fiveMinuteBucket = (now = Date.now()): number => Math.floor(now / 300_000);

export interface GetJsonOptions {
  signal?: AbortSignal;
  /** raw fetches bypass the HTTP cache validation step. */
  noCache?: boolean;
  /** Set by tests. */
  fetchImpl?: typeof fetch;
  /** One retry after 2 s on non-404 failures (default true). */
  retry?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the default `accept: application/json`. */
  headers?: Record<string, string>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one JSON document. 404 → null (a missing shard, a pending doc, a free handle). A 2xx whose body
 * is not JSON also reads as missing: the dev server and some CDNs answer unknown paths with index.html.
 */
export async function getJson<T>(url: string, opts: GetJsonOptions = {}): Promise<T | null> {
  const over = mockOverlay.get(url);
  if (over !== undefined) return over as T | null;
  const attempt = async (): Promise<T | null> => {
    const f = opts.fetchImpl ?? globalThis.fetch;
    const init: RequestInit = { signal: opts.signal ?? null, headers: opts.headers ?? { accept: 'application/json' } };
    if (opts.noCache) init.cache = 'no-cache';
    const res = await f(url, init);
    if (res.status === 404) return null;
    if (!res.ok) throw new DataError(res.status);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    return (await res.json()) as T;
  };
  try {
    return await attempt();
  } catch (e) {
    if (opts.signal?.aborted || opts.retry === false) throw e;
    await (opts.sleep ?? defaultSleep)(2000);
    if (opts.signal?.aborted) throw e;
    return attempt();
  }
}

// ---- url builders --------------------------------------------------------------------------------

export const pagesMetaUrl = (name: 'manifest.json' | 'status.json' | 'settings.json', now = Date.now()): string => `${PAGES_DATA()}${name}?t=${minuteBucket(now)}`;
export const pagesVersionedUrl = (path: string, buildId: string): string => `${PAGES_DATA()}${path}?v=${encodeURIComponent(buildId)}`;
/** The ?r= bucket is a browser-cache marker only (see the header); raw's own cache does not key on it. */
export const rawUrl = (path: string, opts: { polling?: boolean; now?: number } = {}): string =>
  `${RAW_ROOT()}${path}?r=${opts.polling ? minuteBucket(opts.now) : fiveMinuteBucket(opts.now)}`;
/** The same file through the contents API, read raw; `ref=data` is the data branch. */
export const apiContentsUrl = (path: string): string => `${API_ROOT}/repos/${repoName()}/contents/${path}?ref=data`;

export const resumePath = (id: string): string => `resumes/${shardOf(id)}/${id}.json`;
export const userPath = (handle: string): string => `users/${handleShard(handle)}/${handle}.json`;
export const historyPath = (cat: Category, id: string): string => `history/${cat}/${shardOf(id)}/${id}.json`;
export const rankShardPath = (id: string): string => `rank/${shardOf(id)}.json`;
export const ladderPagePath = (cat: Category, partition: string, page: number): string => `ladder/${cat}/${partition}/${page}.json`;
export const ladderMetaPath = (cat: Category): string => `ladder/${cat}/meta.json`;
export const arenaPath = (cat: Category): string => `arena/${cat}.json`;

// ---- typed getters -------------------------------------------------------------------------------

type Opt = Pick<GetJsonOptions, 'signal'>;

let manifestMemo: { bucket: number; promise: Promise<Manifest | null> } | null = null;

/** Memoised per minute so a page's fan-out shares one manifest request. */
export function getManifest(opts: Opt & { force?: boolean } = {}): Promise<Manifest | null> {
  const bucket = minuteBucket();
  if (!opts.force && manifestMemo && manifestMemo.bucket === bucket) return manifestMemo.promise;
  const o: GetJsonOptions = opts.signal ? { signal: opts.signal } : {};
  const promise = getJson<Manifest>(pagesMetaUrl('manifest.json'), o).catch((e: unknown) => {
    manifestMemo = null;
    throw e;
  });
  manifestMemo = { bucket, promise };
  return promise;
}

export const getStatus = (opts: Opt = {}): Promise<PublicStatus | null> => getJson<PublicStatus>(pagesMetaUrl('status.json'), opts.signal ? { signal: opts.signal } : {});
export const getSettings = (opts: Opt = {}): Promise<PublicSettings | null> => getJson<PublicSettings>(pagesMetaUrl('settings.json'), opts.signal ? { signal: opts.signal } : {});

export const getLadderMeta = (cat: Category, buildId: string, opts: Opt = {}): Promise<LadderMeta | null> =>
  getJson<LadderMeta>(pagesVersionedUrl(ladderMetaPath(cat), buildId), opts.signal ? { signal: opts.signal } : {});
export const getLadderPage = (cat: Category, partition: string, page: number, buildId: string, opts: Opt = {}): Promise<LadderPage | null> =>
  getJson<LadderPage>(pagesVersionedUrl(ladderPagePath(cat, partition, page), buildId), opts.signal ? { signal: opts.signal } : {});
export const getRankShard = (id: string, buildId: string, opts: Opt = {}): Promise<RankShard | null> =>
  getJson<RankShard>(pagesVersionedUrl(rankShardPath(id), buildId), opts.signal ? { signal: opts.signal } : {});
export const getArenaPool = (cat: Category, buildId: string, opts: Opt = {}): Promise<ArenaPool | null> =>
  getJson<ArenaPool>(pagesVersionedUrl(arenaPath(cat), buildId), opts.signal ? { signal: opts.signal } : {});

export async function getRankEntry(id: string, buildId: string, opts: Opt = {}): Promise<RankEntry | null> {
  const shard = await getRankShard(id, buildId, opts);
  return shard?.[id] ?? null;
}

const rawOpts = (opts: Opt): GetJsonOptions => (opts.signal ? { noCache: true, signal: opts.signal } : { noCache: true });

// ---- the contents API fast path --------------------------------------------------------------------
// Unauthenticated, 60 requests an hour per IP, answers within about a minute of a commit. Only the
// submitter's pending phase asks for it (polling.ts `docSource`), at most seven times per submission.
// A 403 or 429 turns it off for the rest of the session; everything then reads raw as before. Mock
// builds never call it: the overlay and the local __raw/ tree stand in for both sources.

export const apiDisabled = (): boolean => readRaw(KEYS.apiOff, 'session') === '1';
export const disableApi = (): void => {
  writeRaw(KEYS.apiOff, '1', 'session');
};

export async function getResumeDoc(id: string, opts: Opt & { polling?: boolean; source?: DocSource } = {}): Promise<ResumeDoc | null> {
  if (opts.source === 'api' && !IS_MOCK && !apiDisabled()) {
    try {
      return await getJson<ResumeDoc>(apiContentsUrl(resumePath(id)), { ...rawOpts(opts), retry: false, headers: { accept: 'application/vnd.github.raw+json' } });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (e instanceof DataError && (e.status === 403 || e.status === 429)) disableApi();
      // Any other failure: this one read falls back to raw; the next poll tries the API again.
    }
  }
  return getJson<ResumeDoc>(rawUrl(resumePath(id), { polling: opts.polling ?? false }), rawOpts(opts));
}
export const getUserDoc = (handle: string, opts: Opt & { polling?: boolean } = {}): Promise<UserDoc | null> =>
  getJson<UserDoc>(rawUrl(userPath(handle), { polling: opts.polling ?? false }), rawOpts(opts));
export const getHistoryDoc = (cat: Category, id: string, opts: Opt = {}): Promise<HistoryDoc | null> =>
  getJson<HistoryDoc>(rawUrl(historyPath(cat, id)), rawOpts(opts));

/**
 * Rank entries for a set of ids plus the shards that were actually read. `fetched` holds a shard prefix
 * once its file came back (present or 404), so a caller can tell "read and absent" (a deleted entry)
 * from "not read" (over the cap, or the request failed).
 */
export interface RankLookup {
  entries: ReadonlyMap<string, RankEntry>;
  fetched: ReadonlySet<string>;
}

/** Rank shards for a set of opponent ids, one request per shard, failures tolerated (the label stays neutral). */
export async function getRankEntries(ids: readonly string[], buildId: string, opts: Opt & { max?: number } = {}): Promise<RankLookup> {
  const entries = new Map<string, RankEntry>();
  const fetched = new Set<string>();
  const shards = new Map<string, string[]>();
  for (const id of ids) {
    const ab = shardOf(id);
    const list = shards.get(ab) ?? [];
    list.push(id);
    shards.set(ab, list);
  }
  const limited = [...shards.entries()].slice(0, opts.max ?? 10);
  await Promise.all(
    limited.map(async ([ab, list]) => {
      try {
        const shard = await getJson<RankShard>(pagesVersionedUrl(`rank/${ab}.json`, buildId), opts.signal ? { signal: opts.signal, retry: false } : { retry: false });
        fetched.add(ab);
        if (!shard) return;
        for (const id of list) {
          const e = shard[id];
          if (e) entries.set(id, e);
        }
      } catch {
        // the shard stays out of `fetched`; the page still renders with a neutral label
      }
    }),
  );
  return { entries, fetched };
}

export const rankKeyOf = (cat: Category): 'g' | 'f' | 't' | 'a' => RANK_KEY[cat];
