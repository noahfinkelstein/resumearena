// rank/<ab>.json (§10.2 step 4, D-40): one entry per analyzed rows/ id with a RankTuple per rated category.
import { CATEGORIES, RANK_KEY, delta7, isBoardRow, rankDelta1d, type Category, type RankEntry, type RankShard, type RankTuple, type RatingRow, type RowEntry } from '@resumearena/shared';

export function rankTuple(row: RatingRow, total: number, today: string): RankTuple {
  const placed = row.placed;
  const r = row.r as number;
  return [placed ? row.rank : null, total, Math.round(r), Math.round(row.rd * 10) / 10, row.g, row.w, row.l, row.d, placed ? delta7(row.days, r, today) : null, placed ? 1 : 0, placed ? row.top : null, placed ? rankDelta1d(row.days, row.rank) : null];
}

export function boardTotals(rowsByCat: Record<Category, Map<string, RatingRow>>, analyzed: Set<string>): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const cat of CATEGORIES) {
    let n = 0;
    for (const row of rowsByCat[cat].values()) if (isBoardRow(row) && analyzed.has(row.id)) n++;
    out[cat] = n;
  }
  return out;
}

/** Shards keyed by the two-char prefix; a shard without ids is absent (404 = empty). */
export function buildRankShards(rows: Map<string, RowEntry>, rowsByCat: Record<Category, Map<string, RatingRow>>, today: string): Map<string, RankShard> {
  const analyzed = new Set<string>();
  for (const [id, row] of rows) if (row.s === 'analyzed') analyzed.add(id);
  const totals = boardTotals(rowsByCat, analyzed);
  const shards = new Map<string, RankShard>();
  for (const id of [...analyzed].sort()) {
    const row = rows.get(id) as RowEntry;
    const entry: RankEntry = { h: row.v === 'handle' ? row.h : null, v: row.v, st: row.st, sig: row.sig, p: row.p };
    for (const cat of CATEGORIES) {
      const rating = rowsByCat[cat].get(id);
      if (!rating || rating.r === null || !rating.elig) continue;
      entry[RANK_KEY[cat]] = rankTuple(rating, totals[cat], today);
    }
    const ab = id.slice(0, 2);
    const shard = shards.get(ab) ?? {};
    shard[id] = entry;
    shards.set(ab, shard);
  }
  return shards;
}
