// Opponent selection (§9.4 `pickOpponent`): binary search on the sorted ladder, widen, relax, fall back
// to anchors when a category has fewer than three eligible user opponents (D-25), weighted sample.
import type { Anchor, Category, RatingRow } from '@resumearena/shared';
import type { Rng } from '../rng.ts';

export interface PairingContext {
  cat: Category;
  rows: Map<string, RatingRow>;
  /** Eligible rows with a rating, r ascending, anchors included. */
  byRating: RatingRow[];
  anchors: readonly Anchor[];
  playedToday: (id: string) => number;
  pendingPairs: Set<string>;
  rng: Rng;
  priorityOf?: Map<string, number>;
}

export interface OpponentQuery {
  subject: RatingRow;
  target: number;
  window: number;
  requirePlaced: boolean;
  exclude: ReadonlySet<string>;
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function lowerBound(rows: readonly RatingRow[], value: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((rows[mid] as RatingRow).r as number < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows whose rating falls inside [lo, hi]. */
export function rowsInRange(rows: readonly RatingRow[], lo: number, hi: number): RatingRow[] {
  const start = lowerBound(rows, lo);
  const out: RatingRow[] = [];
  for (let i = start; i < rows.length && ((rows[i] as RatingRow).r as number) <= hi; i++) out.push(rows[i] as RatingRow);
  return out;
}

export function pickOpponent(ctx: PairingContext, q: OpponentQuery): RatingRow | null {
  const subj = q.subject;
  const base = (row: RatingRow): boolean =>
    row.id !== subj.id && row.own !== subj.own && row.elig && row.r !== null && !q.exclude.has(row.id) && !subj.opp.includes(row.id) && !ctx.pendingPairs.has(pairKey(subj.id, row.id));
  // D-25: with fewer than three admissible user opponents the fixed scale fills in, so the first
  // entrants place against anchors instead of skipping games. `pool` keeps byRating's order.
  const users = ctx.byRating.filter((r) => r.kind === 'user' && base(r));
  const pool = users.length < 3 ? ctx.byRating.filter((r) => base(r) && (r.kind === 'user' || r.kind === 'anchor')) : users;

  let candidates: RatingRow[] = [];
  let window = q.window;
  for (let widen = 0; widen <= 3; widen++) {
    candidates = rowsInRange(pool, q.target - window, q.target + window).filter((r) => !q.requirePlaced || r.placed);
    if (candidates.length >= 5) break;
    window *= 2;
  }
  if (candidates.length < 5 && q.requirePlaced) {
    const relaxed = rowsInRange(pool, q.target - window / 2, q.target + window / 2);
    if (relaxed.length > candidates.length) candidates = relaxed;
  }
  if (candidates.length < 5) {
    const nearest = [...pool].sort((x, y) => Math.abs((x.r as number) - q.target) - Math.abs((y.r as number) - q.target) || (x.id < y.id ? -1 : 1)).slice(0, 5);
    if (nearest.length > candidates.length) candidates = nearest;
  }
  if (candidates.length === 0) return null;
  return ctx.rng.weighted(candidates, (row) => (1 / Math.max(row.rd, 1)) * (1 / (1 + ctx.playedToday(row.id))) * (1 + (ctx.priorityOf?.get(row.id) ?? 0)));
}
