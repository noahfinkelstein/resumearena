// history/<cat>/<ab>/<id>.json: points, the recent ring, compaction (D-26) and the lazy dirty cache.
import { type Category, type HistoryDoc, type HistoryPoint, type RecentMatch, HistoryDocZ } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { historyPath } from '../store/paths.ts';
import { addDays } from '../clock.ts';

export const HISTORY_RECENT_DEFAULT = 10;

export interface HistoryCache {
  /** One sparse-checkout add for every doc a wave will touch (§9.2: one batched blob fetch), before the fold reads them. */
  prefetch(cat: Category, ids: Iterable<string>): Promise<void>;
  get(cat: Category, id: string, lin?: string): Promise<HistoryDoc>;
  peek(cat: Category, id: string): HistoryDoc | undefined;
  /** Mark a doc as needing a write. */
  touch(cat: Category, id: string): void;
  /** Revision: the old id's doc continues under the new id (same lineage). */
  rename(cat: Category, oldId: string, newId: string): Promise<void>;
  remove(cat: Category, id: string): void;
  dirty(): { path: string; doc: HistoryDoc }[];
  removed(): string[];
  clear(): void;
}

const key = (cat: Category, id: string): string => `${cat}/${id}`;

export function emptyHistory(cat: Category, id: string, lin: string): HistoryDoc {
  return { id, cat, lin, placed: false, points: [], recent: [] };
}

export function createHistoryCache(store: Store): HistoryCache {
  const docs = new Map<string, HistoryDoc>();
  const dirtyKeys = new Set<string>();
  const removedPaths = new Set<string>();
  // Paths already added to the sparse checkout this process; a per-document `git sparse-checkout add`
  // on a blobless clone costs a network round trip, so each path is materialized at most once.
  const materialized = new Set<string>();
  const materialize = async (paths: string[]): Promise<void> => {
    const fresh = paths.filter((p) => !materialized.has(p));
    if (fresh.length === 0) return;
    await store.materialize(fresh);
    for (const p of fresh) materialized.add(p);
  };
  const load = async (cat: Category, id: string): Promise<HistoryDoc | null> => {
    const path = historyPath(cat, id);
    await materialize([path]);
    const raw = await store.readJson<unknown>(path);
    if (raw === null) return null;
    const r = HistoryDocZ.safeParse(raw);
    return r.success ? r.data : null;
  };
  return {
    async prefetch(cat, ids) {
      const paths: string[] = [];
      for (const id of ids) if (!docs.has(key(cat, id))) paths.push(historyPath(cat, id));
      await materialize(paths);
    },
    async get(cat, id, lin = id) {
      const k = key(cat, id);
      let doc = docs.get(k);
      if (!doc) {
        doc = (await load(cat, id)) ?? emptyHistory(cat, id, lin);
        docs.set(k, doc);
      }
      return doc;
    },
    peek: (cat, id) => docs.get(key(cat, id)),
    touch: (cat, id) => {
      dirtyKeys.add(key(cat, id));
    },
    async rename(cat, oldId, newId) {
      const oldKey = key(cat, oldId);
      let old = docs.get(oldKey);
      if (!old) {
        const loaded = await load(cat, oldId);
        if (!loaded) return;
        old = loaded;
      }
      const moved: HistoryDoc = { ...old, id: newId };
      docs.delete(oldKey);
      dirtyKeys.delete(oldKey);
      docs.set(key(cat, newId), moved);
      dirtyKeys.add(key(cat, newId));
      removedPaths.add(historyPath(cat, oldId));
    },
    remove(cat, id) {
      const k = key(cat, id);
      docs.delete(k);
      dirtyKeys.delete(k);
      removedPaths.add(historyPath(cat, id));
    },
    dirty: () =>
      [...dirtyKeys]
        .map((k) => {
          const doc = docs.get(k) as HistoryDoc;
          return { path: historyPath(doc.cat, doc.id), doc };
        })
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    removed: () => [...removedPaths].sort(),
    clear: () => {
      dirtyKeys.clear();
      removedPaths.clear();
    },
  };
}

export function pushPoint(doc: HistoryDoc, point: HistoryPoint): void {
  doc.points.push(point);
}

export function pushRecent(doc: HistoryDoc, entry: RecentMatch, cap = HISTORY_RECENT_DEFAULT): void {
  doc.recent.unshift(entry);
  if (doc.recent.length > cap) doc.recent.length = cap;
}

/**
 * D-26: every point for 30 days, then one per day (the last of each day, reason `s`), capped at
 * `maxPoints` plus the first placement point. Pure; returns a new array.
 */
export function compactPoints(points: readonly HistoryPoint[], today: string, maxPoints: number): HistoryPoint[] {
  if (points.length === 0) return [];
  const cutoff = addDays(today, -30);
  const first = points[0] as HistoryPoint;
  const older = points.filter((p) => p[0] < cutoff);
  const recent = points.filter((p) => p[0] >= cutoff);
  const perDay = new Map<string, HistoryPoint>();
  for (const p of older) perDay.set(p[0], [p[0], p[1], p[2], 's']);
  let daily = [...perDay.values()];
  let kept = [...daily, ...recent];
  // Trim the oldest daily snapshots first, never the recent window.
  while (kept.length > maxPoints && daily.length > 0) {
    daily = daily.slice(1);
    kept = [...daily, ...recent];
  }
  if (kept.length > maxPoints) kept = kept.slice(kept.length - maxPoints);
  const firstIsPlacement = first[3] === 'p';
  if (firstIsPlacement && !(kept[0] && kept[0][0] === first[0] && kept[0][1] === first[1] && kept[0][3] === 'p')) kept.unshift(first);
  return kept;
}
