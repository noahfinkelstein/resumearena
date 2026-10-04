// The in-memory engine state for rerank and nightly maintenance (§9.4 step 1): ratings per category as
// maps, anchors as locked rows, lazily materialized cards/rows shards and the dirty history cache.
import {
  ArenaPoolZ, CATEGORIES, CardsShardZ, RatingsFileZ, RowsShardZ, seedRating,
  type Anchor, type AnchorsFile, type ArenaPool, type Card, type CardsShard, type CareerStage, type Category, type RatingRow, type RatingsFile, type RowsShard, type Settings, type Status,
} from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { arenaPath, cardsShardPath, ratingsPath, rowsShardPath } from '../store/paths.ts';
import { anchorRow, loadAnchorsFile } from './anchors.ts';
import { createHistoryCache, type HistoryCache } from './history.ts';

export interface CatState {
  cat: Category;
  rows: Map<string, RatingRow>;
  cursor: Record<string, number>;
  shift: number;
  anchors: AnchorsFile | null;
  anchorById: Map<string, Anchor>;
  /** Cached `byRating`; null after any rating change. */
  sorted: RatingRow[] | null;
  /** Round-trip of the previous file's metadata for a no-change write check. */
  loadedFrom: RatingsFile | null;
}

export interface ShardCache<T> {
  get(ab: string): Promise<T | null>;
  /** One materialize for every shard not yet loaded, so a batch of ids costs one git call, not one each. */
  prefetch(abs: Iterable<string>): Promise<void>;
  /** Replace a shard in the cache (after a write by this process). */
  put(ab: string, value: T): void;
}

export interface EngineState {
  settings: Settings;
  status: Status;
  runId: string;
  cats: Record<Category, CatState>;
  history: HistoryCache;
  cards: ShardCache<CardsShard>;
  rowsShards: ShardCache<RowsShard>;
  arena: Record<Category, ArenaPool>;
  /** Paths the finalize commit must delete. */
  removed: Set<string>;
  /** `${cat}:${id}` → opponents met in this id's placement/revision periods (in-memory; the opp ring alone is capped at 10). */
  placementOpps: Map<string, Set<string>>;
  /** Free-text audit notes for the summary and the nightly audit. */
  notes: string[];
  /**
   * Rows already updated by an earlier line of the wave being folded (`${run}|${wave}` → `${cat}:${id}`).
   * A row that meets several subjects in one wave chains from its current rating instead of each line's
   * plan-time `pre`, so its games accumulate rather than overwrite (deterministic on replay: a wave is
   * always folded whole, in log order).
   */
  waveMoved: { key: string | null; ids: Set<string> };
  /**
   * Replay hook: a WAL line can name a row the dead run created in memory but never persisted (rows
   * live only in the apply commit). The fold calls this for a missing user id so rerank can ingest
   * that id's ticket on the spot, which reproduces the dead run's state deterministically.
   */
  ensureRow?: (id: string) => Promise<void>;
}

export function emptyRatingsFile(cat: Category, now: string, runId: string): RatingsFile {
  return { schema: 1, category: cat, updated_at: now, run_id: runId, cursor: {}, shift: 0, rows: {} };
}

export function emptyArena(cat: Category, now: string): ArenaPool {
  return { schema: 1, category: cat, updated_at: now, pairs: [] };
}

function shardCache<T>(store: Store, pathOf: (ab: string) => string, parse: (raw: unknown) => T | null): ShardCache<T> {
  const cache = new Map<string, T | null>();
  const materialized = new Set<string>();
  const materialize = async (abs: string[]): Promise<void> => {
    const fresh = abs.filter((ab) => !materialized.has(ab));
    if (fresh.length === 0) return;
    await store.materialize(fresh.map(pathOf));
    for (const ab of fresh) materialized.add(ab);
  };
  return {
    async get(ab) {
      if (cache.has(ab)) return cache.get(ab) as T | null;
      await materialize([ab]);
      const raw = await store.readJson<unknown>(pathOf(ab));
      const value = raw === null ? null : parse(raw);
      cache.set(ab, value);
      return value;
    },
    async prefetch(abs) {
      await materialize([...new Set(abs)].filter((ab) => !cache.has(ab)));
    },
    put: (ab, value) => {
      cache.set(ab, value);
    },
  };
}

export async function loadCatState(store: Store, cat: Category, now: string, runId: string): Promise<CatState> {
  const path = ratingsPath(cat);
  await store.materialize([path]);
  const raw = await store.readJson<unknown>(path);
  let file: RatingsFile;
  if (raw === null) file = emptyRatingsFile(cat, now, runId);
  else {
    const r = RatingsFileZ.safeParse(raw);
    if (!r.success) throw new Error(`ratings/${cat}.json is malformed: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
    file = r.data;
  }
  const rows = new Map<string, RatingRow>(Object.entries(file.rows));
  const anchors = await loadAnchorsFile(store, cat);
  const anchorById = new Map<string, Anchor>();
  if (anchors) {
    for (const a of anchors.anchors) {
      anchorById.set(a.id, a);
      const existing = rows.get(a.id);
      if (!existing) rows.set(a.id, anchorRow(a, now));
      else if (existing.r !== a.rating) {
        // A rotated anchor keeps its game counts but takes the new locked rating.
        existing.r = a.rating;
        existing.seed = a.rating;
        existing.peak = a.rating;
      }
    }
  }
  return { cat, rows, cursor: { ...file.cursor }, shift: file.shift, anchors, anchorById, sorted: null, loadedFrom: raw === null ? null : file };
}

export async function loadState(store: Store, opts: { settings: Settings; status: Status; runId: string; now: string }): Promise<EngineState> {
  const cats = {} as Record<Category, CatState>;
  const arena = {} as Record<Category, ArenaPool>;
  for (const cat of CATEGORIES) {
    cats[cat] = await loadCatState(store, cat, opts.now, opts.runId);
    const ap = arenaPath(cat);
    await store.materialize([ap]);
    const rawArena = await store.readJson<unknown>(ap);
    const parsed = rawArena === null ? null : ArenaPoolZ.safeParse(rawArena);
    arena[cat] = parsed && parsed.success ? parsed.data : emptyArena(cat, opts.now);
  }
  return {
    settings: opts.settings,
    status: opts.status,
    runId: opts.runId,
    cats,
    history: createHistoryCache(store),
    cards: shardCache<CardsShard>(store, cardsShardPath, (raw) => {
      const r = CardsShardZ.safeParse(raw);
      return r.success ? r.data : null;
    }),
    rowsShards: shardCache<RowsShard>(store, rowsShardPath, (raw) => {
      const r = RowsShardZ.safeParse(raw);
      return r.success ? r.data : null;
    }),
    arena,
    removed: new Set(),
    placementOpps: new Map(),
    notes: [],
    waveMoved: { key: null, ids: new Set() },
  };
}

/** Rows with a rating, eligible, sorted by r ascending (anchors included, flagged by kind). */
export function sortedRows(cs: CatState): RatingRow[] {
  if (cs.sorted) return cs.sorted;
  const out: RatingRow[] = [];
  for (const row of cs.rows.values()) if (row.r !== null && row.elig) out.push(row);
  out.sort((x, y) => (x.r as number) - (y.r as number) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  cs.sorted = out;
  return out;
}

export const invalidate = (cs: CatState): void => {
  cs.sorted = null;
};

export function serializeRatings(cs: CatState, now: string, runId: string): RatingsFile {
  const rows: Record<string, RatingRow> = {};
  for (const id of [...cs.rows.keys()].sort()) rows[id] = cs.rows.get(id) as RatingRow;
  const cursor: Record<string, number> = {};
  for (const k of Object.keys(cs.cursor).sort()) cursor[k] = cs.cursor[k] as number;
  return { schema: 1, category: cs.cat, updated_at: now, run_id: runId, cursor, shift: cs.shift, rows };
}

export const ownOf = (ownerHash: string): string => ownerHash.slice(0, 12);

export function newGeneralRow(id: string, ownerHash: string, score: number, settings: Settings, created: string): RatingRow {
  const seed = seedRating(score);
  return {
    id, own: ownOf(ownerHash), lin: id, r: seed, rd: settings.rating.rd_initial_with_prior, vol: 0.06, seed, score,
    g: 0, w: 0, d: 0, l: 0, round: 0, placed: false, kind: 'user', locked: false, elig: true, rank: null, top: null,
    peak: seed, peak_at: created.slice(0, 10), last: null, days: [], opp: [], mv: 0, created,
  };
}

/** Waits for general placement: `r: null, round: -1`, seeded by the fold when the general row places. */
export function newDomainRow(id: string, ownerHash: string, score: number, settings: Settings, created: string): RatingRow {
  return {
    id, own: ownOf(ownerHash), lin: id, r: null, rd: settings.rating.rd_initial_domain, vol: 0.06, seed: seedRating(score), score,
    g: 0, w: 0, d: 0, l: 0, round: -1, placed: false, kind: 'user', locked: false, elig: true, rank: null, top: null,
    peak: 0, peak_at: created.slice(0, 10), last: null, days: [], opp: [], mv: 0, created,
  };
}

/** Placement rounds by category and by whether the row inherited a lineage (revision, D-42). */
export function roundsSpecFor(settings: Settings, cat: Category, row: RatingRow): number[] {
  const revision = row.lin !== row.id;
  if (cat === 'general') return revision ? settings.rating.revision_rounds_general : settings.rating.placement_rounds_general;
  return revision ? settings.rating.revision_rounds_domain : settings.rating.placement_rounds_domain;
}

export const matchKindFor = (row: RatingRow): 'placement' | 'revision' => (row.lin !== row.id ? 'revision' : 'placement');

export type CardLookup = (cat: Category, id: string) => Promise<{ card: Card; stage: CareerStage } | null>;

/** User cards come from cards/<ab>.json; anchors from the category's anchors file. */
export function cardLookup(state: EngineState): CardLookup {
  return async (cat, id) => {
    const anchor = state.cats[cat].anchorById.get(id);
    if (anchor) return { card: anchor.card, stage: anchor.stage };
    const shard = await state.cards.get(id.slice(0, 2));
    const entry = shard?.[id];
    return entry ? { card: entry.card, stage: entry.st } : null;
  };
}
