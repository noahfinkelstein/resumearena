// Ladder pages and meta (§10.2 steps 2–3): board rows partitioned into `all` and one per stage,
// dense rank within the partition, 100 rows per page, medians from rows/ sub-scores.
import { PAGE_SIZE, STAGES, anonIdOf, delta7, plusMinus, tierFor, type CareerStage, type Category, type LadderMeta, type LadderPage, type LadderRowTuple, type RatingRow, type RowEntry, LADDER_COLS } from '@resumearena/shared';

export interface BoardRow {
  rating: RatingRow;
  row: RowEntry;
}

export const MEDIAN_MIN_ROWS = 20;

export const sortBoard = (rows: BoardRow[]): BoardRow[] =>
  rows.sort((x, y) => (y.rating.r as number) - (x.rating.r as number) || x.rating.rd - y.rating.rd || (x.rating.id < y.rating.id ? -1 : x.rating.id > y.rating.id ? 1 : 0));

export const identityOf = (row: RowEntry, id: string): string => (row.v === 'handle' ? row.h : anonIdOf(id));

export function ladderTuple(b: BoardRow, rank: number, total: number, today: string): LadderRowTuple {
  const r = b.rating;
  return [rank, r.id, identityOf(b.row, r.id), tierFor(r.r as number), Math.round(r.r as number), plusMinus(r.rd), r.w, r.l, r.d, b.row.st, b.row.sig, delta7(r.days, r.r as number, today), Math.round((rank / total) * 1e4) / 1e4];
}

export function paginate(cat: Category, partition: string, rows: BoardRow[], today: string, pageSize = PAGE_SIZE): LadderPage[] {
  const sorted = sortBoard([...rows]);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const out: LadderPage[] = [];
  for (let p = 1; p <= pages; p++) {
    const slice = sorted.slice((p - 1) * pageSize, p * pageSize);
    out.push({ schema: 1, category: cat, partition, page: p, pages, total, cols: LADDER_COLS, rows: slice.map((b, i) => ladderTuple(b, (p - 1) * pageSize + i + 1, total, today)) });
  }
  return out;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

export function medians(cat: Category, rows: BoardRow[]): LadderMeta['medians'] {
  const tuples = rows.map((b) => b.row.ss[cat]).filter((t): t is [number, number, number, number, number, number] => Array.isArray(t));
  if (tuples.length < MEDIAN_MIN_ROWS) return null;
  const col = (i: number): number => Math.round(median(tuples.map((t) => t[i] as number)) * 10) / 10;
  return { pedigree: col(0), trajectory: col(1), impact: col(2), selectivity: col(3), breadth: col(4), stage_relative: col(5) };
}

export interface LadderBuild {
  meta: LadderMeta;
  pages: Map<string, LadderPage[]>; // partition → pages
}

export function buildLadder(cat: Category, rows: BoardRow[], today: string, updatedAt: string, pageSize = PAGE_SIZE): LadderBuild {
  const pages = new Map<string, LadderPage[]>();
  const all = paginate(cat, 'all', rows, today, pageSize);
  pages.set('all', all);
  const stages = {} as Record<CareerStage, { total: number; pages: number }>;
  for (const stage of STAGES) {
    const subset = rows.filter((b) => b.row.st === stage);
    const p = paginate(cat, `stage-${stage}`, subset, today, pageSize);
    pages.set(`stage-${stage}`, p);
    stages[stage] = { total: subset.length, pages: subset.length ? p.length : 0 };
  }
  const meta: LadderMeta = { category: cat, total: rows.length, pages: rows.length ? all.length : 0, page_size: pageSize, updated_at: updatedAt, stages, medians: medians(cat, rows) };
  return { meta, pages };
}
