// Anchors (D-25, D-54): loading, their locked rating rows, nearest-anchor lookup, drift and judge-health
// statistics over match lines, and the validate-anchors plan.
import {
  ANCHOR_RATINGS, AnchorsFileZ, anchorId, driftDecision, driftStats, expected, isAnchorId,
  type Anchor, type AnchorsFile, type Category, type DriftSample, type MatchLine, type RatingRow,
} from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { anchorsPath } from '../store/paths.ts';

export async function loadAnchorsFile(store: Store, cat: Category): Promise<AnchorsFile | null> {
  const path = anchorsPath(cat);
  await store.materialize([path]);
  const raw = await store.readJson<unknown>(path);
  if (raw === null) return null;
  const r = AnchorsFileZ.safeParse(raw);
  if (!r.success) throw new Error(`anchors/${cat}.json is malformed: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  return r.data;
}

export function anchorRow(anchor: Anchor, created: string): RatingRow {
  return {
    id: anchor.id, own: 'anchor', lin: anchor.id, r: anchor.rating, rd: 30, vol: 0.06, seed: anchor.rating, score: 0,
    g: 0, w: 0, d: 0, l: 0, round: 0, placed: true, kind: 'anchor', locked: true, elig: true, rank: null, top: null,
    peak: anchor.rating, peak_at: created.slice(0, 10), last: null, days: [], opp: [], mv: 0, created,
  };
}

export function nearestAnchor(anchors: readonly Anchor[], rating: number, exclude: ReadonlySet<string> = new Set()): Anchor | null {
  let best: Anchor | null = null;
  for (const a of anchors) {
    if (exclude.has(a.id)) continue;
    if (!best || Math.abs(a.rating - rating) < Math.abs(best.rating - rating)) best = a;
  }
  return best;
}

/** Sanity for a hand-edited anchors file: 12 ids at 1000…2100 with the D-25 ids. */
export function anchorsFileProblems(file: AnchorsFile): string[] {
  const problems: string[] = [];
  if (file.anchors.length !== 12) problems.push(`expected 12 anchors, found ${file.anchors.length}`);
  const seen = new Set<number>();
  for (const a of file.anchors) {
    if (!(ANCHOR_RATINGS as readonly number[]).includes(a.rating)) problems.push(`${a.id}: rating ${a.rating} off the ladder`);
    else if (anchorId(file.category, a.rating) !== a.id) problems.push(`${a.id}: id does not match ${file.category} ${a.rating}`);
    if (seen.has(a.rating)) problems.push(`duplicate rating ${a.rating}`);
    seen.add(a.rating);
  }
  return problems;
}

/** Population-side (s − E) samples over lines where exactly one side is an anchor. */
export function driftSamples(lines: Iterable<MatchLine>): DriftSample[] {
  const out: DriftSample[] = [];
  for (const l of lines) {
    const aAnchor = isAnchorId(l.a);
    const bAnchor = isAnchorId(l.b);
    if (aAnchor === bAnchor) continue;
    const popIsA = !aAnchor;
    const s = popIsA ? l.o : 1 - l.o;
    const e = popIsA ? expected(l.pre.ar, l.pre.br, l.pre.brd) : expected(l.pre.br, l.pre.ar, l.pre.ard);
    out.push({ s, e });
  }
  return out;
}

export interface DriftReport {
  n: number;
  res: number;
  se: number;
  shift: number;
}

export function driftReport(lines: Iterable<MatchLine>, opts: { minGames: number; maxShift: number }): DriftReport {
  const stats = driftStats(driftSamples(lines));
  return { n: stats.n, res: round4(stats.res), se: round4(stats.se), shift: driftDecision(stats, opts) };
}

export interface JudgeHealth {
  disagreement_rate_7d: number | null;
  anchor_accuracy_7d: number | null;
  anchor_n_7d: number;
}

/** Disagreement over all lines; anchor accuracy over anchor-vs-user lines ≥ 200 apart (§9.5 nightly). */
export function judgeHealth(lines: readonly MatchLine[]): JudgeHealth {
  const total = lines.length;
  const disagreements = lines.filter((l) => !l.agree).length;
  let n = 0;
  let correct = 0;
  let anchorN = 0;
  for (const l of lines) {
    const aAnchor = isAnchorId(l.a);
    const bAnchor = isAnchorId(l.b);
    if (aAnchor === bAnchor) continue;
    anchorN++;
    if (Math.abs(l.pre.ar - l.pre.br) < 200) continue;
    n++;
    const strongerIsA = l.pre.ar > l.pre.br;
    if ((strongerIsA && l.o === 1) || (!strongerIsA && l.o === 0)) correct++;
  }
  return { disagreement_rate_7d: total ? round4(disagreements / total) : null, anchor_accuracy_7d: n ? round4(correct / n) : null, anchor_n_7d: anchorN };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** validate-anchors: adjacent pairs 5× each ordering (the judge fires both orderings per match, so 5 matches). */
export function adjacentAnchorPairs(file: AnchorsFile): { lower: Anchor; higher: Anchor }[] {
  const sorted = [...file.anchors].sort((a, b) => a.rating - b.rating);
  const out: { lower: Anchor; higher: Anchor }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) out.push({ lower: sorted[i] as Anchor, higher: sorted[i + 1] as Anchor });
  return out;
}

/** Pairs ≥ 300 apart must never lose (one match each). */
export function farAnchorPairs(file: AnchorsFile): { lower: Anchor; higher: Anchor }[] {
  const sorted = [...file.anchors].sort((a, b) => a.rating - b.rating);
  const out: { lower: Anchor; higher: Anchor }[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) if ((sorted[j] as Anchor).rating - (sorted[i] as Anchor).rating >= 300) out.push({ lower: sorted[i] as Anchor, higher: sorted[j] as Anchor });
  return out;
}
