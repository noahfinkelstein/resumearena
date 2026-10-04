// Glicko math, seeds, placement geometry, priority, drift and budget arithmetic (§6.1–§6.2).
// Everything here is pure and total: no I/O, no Date.now(), no randomness (jitter is passed in).
import type { Outcome, RatingSettings } from './types.ts';

export const Q = Math.LN10 / 400;

export interface GlickoConstants {
  rdFloor: number;
  rdCeiling: number;
  rdInflationC: number;
  rdInitial: number;
  rdInitialWithPrior: number;
  rdInitialDomain: number;
  rdRevisionMin: number;
}

export const DEFAULT_GLICKO: Readonly<GlickoConstants> = {
  rdFloor: 50,
  rdCeiling: 350,
  rdInflationC: 6,
  rdInitial: 350,
  rdInitialWithPrior: 250,
  rdInitialDomain: 220,
  rdRevisionMin: 180,
};

export function glickoConstantsFrom(s: RatingSettings): GlickoConstants {
  return {
    rdFloor: s.rd_floor,
    rdCeiling: s.rd_ceiling,
    rdInflationC: s.rd_inflation_c,
    rdInitial: s.rd_initial,
    rdInitialWithPrior: s.rd_initial_with_prior,
    rdInitialDomain: s.rd_initial_domain,
    rdRevisionMin: s.rd_revision_min,
  };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** g(RD) = 1 / sqrt(1 + 3 q² RD² / π²) */
export function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

/** E = 1 / (1 + 10^(−g(RD_j)(r − r_j)/400)) */
export function expected(r: number, oppR: number, oppRd: number): number {
  return 1 / (1 + Math.pow(10, (-g(oppRd) * (r - oppR)) / 400));
}

export interface Game {
  oppR: number;
  oppRd: number;
  score: Outcome | number;
  /** 1 for the judge; reserved for community votes. */
  weight?: number;
}
export interface GlickoResult {
  r: number;
  rd: number;
}

/** One rating period. Empty games → unchanged input. Both outputs rounded to 2 dp like the plpgsql original. */
export function glickoUpdate(r: number, rd: number, games: readonly Game[], rdFloor = DEFAULT_GLICKO.rdFloor): GlickoResult {
  let sumD2 = 0;
  let sumNum = 0;
  for (const game of games) {
    const w = game.weight ?? 1;
    const gj = g(game.oppRd);
    const e = expected(r, game.oppR, game.oppRd);
    sumD2 += w * gj * gj * e * (1 - e);
    sumNum += w * gj * (game.score - e);
  }
  if (sumD2 === 0) return { r, rd };
  const d2 = 1 / (Q * Q * sumD2);
  const inv = 1 / (rd * rd) + 1 / d2;
  return { r: round2(r + (Q / inv) * sumNum), rd: round2(Math.max(Math.sqrt(1 / inv), rdFloor)) };
}

export interface PreMatch {
  ar: number;
  ard: number;
  br: number;
  brd: number;
}

/** Two-sided single match from pre-match values; both sides computed from `pre`, never sequentially. */
export function applyMatch(pre: PreMatch, outcomeA: Outcome, rdFloor = DEFAULT_GLICKO.rdFloor): { a: GlickoResult; b: GlickoResult } {
  return {
    a: glickoUpdate(pre.ar, pre.ard, [{ oppR: pre.br, oppRd: pre.brd, score: outcomeA }], rdFloor),
    b: glickoUpdate(pre.br, pre.brd, [{ oppR: pre.ar, oppRd: pre.ard, score: 1 - outcomeA }], rdFloor),
  };
}

export interface PeriodGame extends Game {
  oppId: string;
  /** Anchors: never updated. */
  locked?: boolean;
}

/** Placement round: the subject gets one m-game period; each opponent a 1-game period against the subject's pre-round values. */
export function applyPeriod(
  subject: GlickoResult,
  games: readonly PeriodGame[],
  rdFloor = DEFAULT_GLICKO.rdFloor,
): { subject: GlickoResult; opponents: Map<string, GlickoResult> } {
  const opponents = new Map<string, GlickoResult>();
  for (const game of games) {
    if (game.locked) continue;
    opponents.set(game.oppId, glickoUpdate(game.oppR, game.oppRd, [{ oppR: subject.r, oppRd: subject.rd, score: 1 - game.score, ...(game.weight === undefined ? {} : { weight: game.weight }) }], rdFloor));
  }
  return { subject: glickoUpdate(subject.r, subject.rd, games, rdFloor), opponents };
}

/** One nightly inflation step: min(sqrt(rd² + c²), ceiling). */
export function inflateRd(rd: number, c = DEFAULT_GLICKO.rdInflationC, ceiling = DEFAULT_GLICKO.rdCeiling): number {
  return round2(Math.min(Math.sqrt(rd * rd + c * c), ceiling));
}

/** Closed form of applying inflateRd once per idle day beyond the seventh. */
export function inflateRdForIdle(rd: number, idleDays: number, c = DEFAULT_GLICKO.rdInflationC, ceiling = DEFAULT_GLICKO.rdCeiling): number {
  const steps = Math.max(0, Math.floor(idleDays) - 7);
  if (steps === 0) return rd;
  return round2(Math.min(Math.sqrt(rd * rd + steps * c * c), ceiling));
}

/** seed(score) = clamp(1200 + 8 (score − 50), 800, 1600) (D-24). */
export function seedRating(score: number): number {
  return clamp(1200 + 8 * (score - 50), 800, 1600);
}

/** Domain rows start halfway between the general rating and the domain rubric seed. */
export function seedDomain(generalRating: number, domainScore: number): number {
  return round2(0.5 * generalRating + 0.5 * seedRating(domainScore));
}

/** 3 games → [−0.7, 0, +0.7] × RD; 2 → [−0.5, +0.5] × RD; anything else spread evenly across ±0.7 RD. */
export function placementOffsets(games: number, rd: number): number[] {
  if (games <= 0) return [];
  if (games === 1) return [0];
  if (games === 3) return [-0.7 * rd, 0, 0.7 * rd];
  if (games === 2) return [-0.5 * rd, 0.5 * rd];
  const out: number[] = [];
  for (let i = 0; i < games; i++) out.push((-0.7 + (1.4 * i) / (games - 1)) * rd);
  return out;
}

/** Opponent search half-width: max(60, 0.35 RD). */
export const placementWindow = (rd: number): number => Math.max(60, 0.35 * rd);

/** p1 saw (first = a, second = b); p2 saw (first = b, second = a). Agreement decides, disagreement draws. */
export function outcomeFromPasses(p1: 'first' | 'second', p2: 'first' | 'second'): { o: Outcome; agree: boolean } {
  const winner1 = p1 === 'first' ? 'a' : 'b';
  const winner2 = p2 === 'first' ? 'b' : 'a';
  if (winner1 !== winner2) return { o: 0.5, agree: false };
  return { o: winner1 === 'a' ? 1 : 0, agree: true };
}

export interface BoardRowLike {
  id: string;
  r: number | null;
  rd: number;
  elig: boolean;
  placed: boolean;
  kind: 'user' | 'anchor';
}
export interface RankInfo {
  rank: number;
  total: number;
  /** rank / total, 4 dp, small = better (D-52). */
  top: number;
  /** 1 − (rank − 1)/(n − 1); 1 for n = 1. Internal to the priority formula. */
  pct: number;
}

export const isBoardRow = (row: BoardRowLike): boolean => row.elig && row.placed && row.kind === 'user' && row.r !== null;

/** Ranks over board rows ordered r desc, rd asc, id asc. Rows that are not on the board are absent from the map. */
export function rankAndPercentile(rows: Iterable<BoardRowLike>): Map<string, RankInfo> {
  const board: BoardRowLike[] = [];
  for (const row of rows) if (isBoardRow(row)) board.push(row);
  board.sort((x, y) => (y.r as number) - (x.r as number) || x.rd - y.rd || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const n = board.length;
  const out = new Map<string, RankInfo>();
  board.forEach((row, i) => {
    const rank = i + 1;
    out.set(row.id, { rank, total: n, top: Math.round((rank / n) * 1e4) / 1e4, pct: n === 1 ? 1 : 1 - (rank - 1) / (n - 1) });
  });
  return out;
}

export type PriorityWeights = RatingSettings['priority_weights'];
export const DEFAULT_PRIORITY_WEIGHTS: Readonly<PriorityWeights> = { U: 3.0, S: 1.0, T: 1.5, A: 0.0, V: 0.75, J: 0.25 };

export interface PriorityInput {
  rd: number;
  daysSinceLast: number;
  /** null while unranked; treated as the median. */
  pct: number | null;
  /** Attention term; weight 0 in v1. */
  views7d?: number;
  /** |r − today's snapshot| > 60. */
  moved: boolean;
  /** 0..1 from the run's PRNG. */
  jitter: number;
}

export function priorityTerms(p: PriorityInput, c: GlickoConstants = DEFAULT_GLICKO): { U: number; S: number; T: number; A: number; V: number } {
  const span = c.rdCeiling - c.rdFloor;
  const u = clamp((p.rd - c.rdFloor) / span, 0, 1);
  return {
    U: u * u,
    S: clamp(p.daysSinceLast / 45, 0, 1),
    T: Math.exp(-8 * (1 - (p.pct ?? 0.5))),
    A: clamp((p.views7d ?? 0) / 200, 0, 1),
    V: p.moved ? 1 : 0,
  };
}

/** priority = 3U + S + 1.5T + 0A + 0.75V + J, J = jitter × wJ. */
export function priority(p: PriorityInput, w: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS, c: GlickoConstants = DEFAULT_GLICKO): number {
  const t = priorityTerms(p, c);
  return w.U * t.U + w.S * t.S + w.T * t.T + w.A * t.A + w.V * t.V + w.J * clamp(p.jitter, 0, 1);
}

export const plusMinus = (rd: number): number => Math.round(1.96 * rd);

// ---- drift (D-54) ---------------------------------------------------------------------------------

export interface DriftSample {
  /** population side's score */
  s: number;
  /** population side's expected score */
  e: number;
}
export interface DriftStats {
  n: number;
  res: number;
  se: number;
}

/** res = mean(s − E); SE = sqrt(mean(E(1 − E)) / n). Zero-sample input yields n = 0, res = 0, se = 0. */
export function driftStats(samples: readonly DriftSample[]): DriftStats {
  const n = samples.length;
  if (n === 0) return { n: 0, res: 0, se: 0 };
  let sumRes = 0;
  let sumVar = 0;
  for (const x of samples) {
    sumRes += x.s - x.e;
    sumVar += x.e * (1 - x.e);
  }
  return { n, res: sumRes / n, se: Math.sqrt(sumVar / n / n) };
}

/** clamp(400/ln10 × res × 0.5, ±maxShift), zeroed below 2 points. */
export function driftShift(res: number, maxShift = 10): number {
  const shift = clamp((400 / Math.LN10) * res * 0.5, -maxShift, maxShift);
  return Math.abs(shift) >= 2 ? Math.round(shift * 100) / 100 : 0;
}

/** The nightly decision: shift only with enough anchor games and a residual beyond two standard errors. */
export function driftDecision(stats: DriftStats, opts: { minGames: number; maxShift: number }): number {
  if (stats.n < opts.minGames) return 0;
  if (Math.abs(stats.res) <= 2 * stats.se) return 0;
  return driftShift(stats.res, opts.maxShift);
}

// ---- budget arithmetic (§6.2, D-49) ---------------------------------------------------------------

export function minutesToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return (next - now.getTime()) / 60_000;
}

export const runsLeft = (now: Date): number => Math.max(1, Math.ceil(minutesToUtcMidnight(now) / 10));

export interface AllowanceInput {
  dailyBudgetUsd: number;
  refineBudgetShare: number;
  refineSpentTodayUsd: number;
  estCostPerMatchUsd: number;
  maxRefineMatchesPerRun: number;
  runsLeft: number;
}

/** min(max_refine_matches_per_run, floor((budget × share − spent) / cost / runs_left)), never negative. */
export function refineAllowance(i: AllowanceInput): number {
  const remaining = i.dailyBudgetUsd * i.refineBudgetShare - i.refineSpentTodayUsd;
  if (remaining <= 0 || i.estCostPerMatchUsd <= 0) return 0;
  const perRun = Math.floor(remaining / i.estCostPerMatchUsd / Math.max(1, i.runsLeft));
  return Math.max(0, Math.min(i.maxRefineMatchesPerRun, perRun));
}

export const placementAllowed = (spentTodayUsd: number, dailyBudgetUsd: number): boolean => spentTodayUsd < dailyBudgetUsd;
export const hardStop = (spentTodayUsd: number, dailyBudgetUsd: number, multiplier = 1.15): boolean => spentTodayUsd >= multiplier * dailyBudgetUsd;

// ---- deltas from the `days` ring (D-19) -----------------------------------------------------------

export type DaySnapshot = [date: string, r: number, rank: number | null];

function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** round(r − days[k].r), k = newest snapshot dated ≤ today − 7 d, else the oldest; null when the ring is empty. */
export function delta7(days: readonly DaySnapshot[], r: number, today: string): number | null {
  if (days.length === 0) return null;
  const cutoff = shiftDate(today, -7);
  let pick: DaySnapshot | undefined;
  for (const snap of days) if (snap[0] <= cutoff && (!pick || snap[0] >= pick[0])) pick = snap;
  if (!pick) pick = days.reduce((oldest, snap) => (snap[0] < oldest[0] ? snap : oldest));
  return Math.round(r - pick[1]);
}

/** days[last].rank − rank (positive = climbed); null when either side is unknown. */
export function rankDelta1d(days: readonly DaySnapshot[], rank: number | null): number | null {
  const last = days[days.length - 1];
  if (!last || last[2] === null || rank === null) return null;
  return last[2] - rank;
}
