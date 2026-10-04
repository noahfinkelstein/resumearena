// `build-indexes --out <dir>` (§10): deterministic Pages tree from settings, status, rows/, ratings/, arena/.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ArenaPoolZ, CATEGORIES, RatingsFileZ, RowsShardZ, isBoardRow, type ArenaPool, type Category, type RatingRow, type RowEntry } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { openStore } from '../store/store.ts';
import { arenaPath, ratingsPath } from '../store/paths.ts';
import { headSha } from '../store/git.ts';
import { writeJsonAtomic } from '../store/json.ts';
import { loadSettings, loadStatus } from '../settings.ts';
import { buildLadder, type BoardRow } from '../index/ladder.ts';
import { buildRankShards } from '../index/rank-shards.ts';
import { buildManifest } from '../index/manifest.ts';
import { publicSettings, publicStatus } from '../index/settings-public.ts';
import { updateArena } from '../rank/arena.ts';
import { emptyArena } from '../rank/state.ts';

export interface BuildIndexesOptions {
  store: Store;
  outDir: string;
  buildId: string;
  commit: string;
  now: string;
}

export interface BuildIndexesReport {
  files: number;
  rated: Record<Category, number>;
  resumes: number;
}

export interface IndexInputs {
  rows: Map<string, RowEntry>;
  ratings: Record<Category, Map<string, RatingRow>>;
  arena: Record<Category, ArenaPool>;
}

export async function loadIndexInputs(store: Store, now: string): Promise<IndexInputs> {
  await store.materialize(['/rows/', '/ratings/', '/arena/']);
  const rows = new Map<string, RowEntry>();
  for (const file of await store.listFiles('rows')) {
    if (!file.endsWith('.json')) continue;
    const parsed = RowsShardZ.safeParse(await store.readJson(file));
    if (!parsed.success) throw new Error(`${file}: malformed rows shard`);
    for (const [id, entry] of Object.entries(parsed.data)) rows.set(id, entry as RowEntry);
  }
  const ratings = {} as Record<Category, Map<string, RatingRow>>;
  const arena = {} as Record<Category, ArenaPool>;
  for (const cat of CATEGORIES) {
    const raw = await store.readJson<unknown>(ratingsPath(cat));
    const file = raw === null ? null : RatingsFileZ.parse(raw);
    ratings[cat] = new Map(file ? Object.entries(file.rows) : []);
    const rawArena = await store.readJson<unknown>(arenaPath(cat));
    const parsedArena = rawArena === null ? null : ArenaPoolZ.safeParse(rawArena);
    arena[cat] = parsedArena && parsedArena.success ? parsedArena.data : emptyArena(cat, now);
  }
  return { rows, ratings, arena };
}

/** Pure build: every output file keyed by its relative path, in deterministic order. */
export function buildIndexFiles(inputs: IndexInputs, settings: Awaited<ReturnType<typeof loadSettings>>, status: Awaited<ReturnType<typeof loadStatus>>, opts: { buildId: string; commit: string; dataSha: string; now: string }): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const today = opts.now.slice(0, 10);
  const analyzedIds = new Set([...inputs.rows].filter(([, r]) => r.s === 'analyzed').map(([id]) => id));
  const rated = {} as Record<Category, number>;
  const pages = {} as Record<Category, number>;
  for (const cat of CATEGORIES) {
    const board: BoardRow[] = [];
    for (const rating of inputs.ratings[cat].values()) {
      if (!isBoardRow(rating) || !analyzedIds.has(rating.id)) continue;
      board.push({ rating, row: inputs.rows.get(rating.id) as RowEntry });
    }
    const ladder = buildLadder(cat, board, today, status.updated_at);
    rated[cat] = board.length;
    pages[cat] = ladder.meta.pages;
    out.set(`ladder/${cat}/meta.json`, ladder.meta);
    for (const [partition, list] of ladder.pages) for (const page of list) if (page.total > 0 || partition === 'all') out.set(`ladder/${cat}/${partition}/${page.page}.json`, page);
  }
  const shards = buildRankShards(inputs.rows, inputs.ratings, today);
  for (const [ab, shard] of [...shards].sort(([a], [b]) => (a < b ? -1 : 1))) out.set(`rank/${ab}.json`, shard);
  for (const cat of CATEGORIES) {
    const hasEntry = (id: string): boolean => shards.get(id.slice(0, 2))?.[id] !== undefined;
    out.set(`arena/${cat}.json`, updateArena(inputs.arena[cat], [], hasEntry, settings.retention.arena_pool_size, inputs.arena[cat].updated_at));
  }
  out.set('status.json', publicStatus(status, opts.now, opts.buildId));
  out.set('settings.json', publicSettings(settings, status));
  out.set('manifest.json', buildManifest({ buildId: opts.buildId, builtAt: opts.now, dataSha: opts.dataSha, commit: opts.commit, resumes: analyzedIds.size, rated, matches: status.counts.matches, users: status.counts.users, pages }));
  return out;
}

export async function buildIndexes(opts: BuildIndexesOptions): Promise<BuildIndexesReport> {
  const settings = await loadSettings(opts.store);
  const status = await loadStatus(opts.store, opts.now, settings);
  const inputs = await loadIndexInputs(opts.store, opts.now);
  const dataSha = opts.store.kind === 'fs' ? ((await headSha(opts.store.root)) ?? '') : '';
  const files = buildIndexFiles(inputs, settings, status, { buildId: opts.buildId, commit: opts.commit, dataSha, now: opts.now });
  await mkdir(opts.outDir, { recursive: true });
  // manifest.json is written last by construction (Map insertion order).
  for (const [rel, value] of files) await writeJsonAtomic(join(opts.outDir, rel), value);
  const manifest = files.get('manifest.json') as ReturnType<typeof buildManifest>;
  return { files: files.size, rated: manifest.counts.rated, resumes: manifest.counts.resumes };
}

export const openDataStore = openStore;
