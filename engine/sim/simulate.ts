// Simulation harness (§13.3, ranking-engine.md §7.2): an in-memory store, a synthetic judge with position
// bias and per-pass noise, and the real rerank. Reports Spearman ρ against latent strength at the
// milestones the acceptance table names, RD, disagreement, anchor residual, bias cancellation and cost.
import { CATEGORIES, DEFAULT_SETTINGS, PRICES_FALLBACK, anchorId, costOf, isAnchorId, type AnchorsFile, type Category, type MatchLine, type RatingRow, type Settings } from '@resumearena/shared';
import { createClock } from '../src/clock.ts';
import { createContext, type Context } from '../src/context.ts';
import { readEnv, repoRootFromHere } from '../src/env.ts';
import { loadPrompts } from '../src/llm/prompts.ts';
import { dataInit } from '../src/commands/data.ts';
import { runRerank } from '../src/commands/rerank.ts';
import { driftReport } from '../src/rank/anchors.ts';
import { parseUsageLines } from '../src/rank/budget.ts';
import { anchorsPath, ratingsPath } from '../src/store/paths.ts';
import { openMemoryStore } from '../src/store/store.ts';
import { createRng, gaussian } from '../src/rng.ts';
import { silentLogger } from '../src/summary.ts';
import { createSyntheticJudge, FIXED_USAGE, SIM_MODEL } from './judge.ts';
import { idFor, minimalCard, ownerFor, seedResumes, type SeedSpec } from './seed.ts';
import { join } from 'node:path';

export interface SimConfig {
  n: number;
  domainsPerResume: number;
  truthSigma: number;
  rubricNoise: number;
  judgeNoise: number;
  positionBias: number;
  runs: number;
  seed: number;
  /** Tickets ingested per run; the default spreads placement over five runs so later entrants meet placed opponents. */
  placementsPerRun?: number;
  refinePerRun?: number;
  hoursBetweenRuns?: number;
}

export interface SimReport {
  n: number;
  runs: number;
  matches: number;
  placementMatches: number;
  refineMatches: number;
  rhoAfterPlacement: number | null;
  rhoAt25: number | null;
  rhoTopDecileAt40: number | null;
  meanGamesAtEnd: number;
  meanRdAfterPlacement: number | null;
  disagreementRate: number;
  anchorResidualLastWeek: number | null;
  anchorGamesLastWeek: number;
  firstWinRatePerPass: number;
  orderOutcomeSpearman: number;
  totalCostUsd: number;
  expectedCostUsd: number;
  elapsedMs: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Spearman ρ with average ranks for ties. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  const rank = (v: readonly number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

function syntheticAnchors(cat: Category): AnchorsFile {
  return {
    schema: 1,
    category: cat,
    prompt_version: 'judge.v1',
    validated_at: null,
    anchors: Array.from({ length: 12 }, (_, i) => {
      const rating = 1000 + i * 100;
      return { id: anchorId(cat, rating), rating, stage: 'mid' as const, spec: `synthetic ${rating}`, card: minimalCard('mid', `anchor ${cat} ${rating}`) };
    }),
  };
}

export async function simulate(cfg: SimConfig): Promise<SimReport> {
  const started = Date.now();
  const rng = createRng(`sim|${cfg.seed}`);
  const store = openMemoryStore('sim');
  const clock = createClock('2026-10-01T00:00:00Z');
  const placementsPerRun = cfg.placementsPerRun ?? Math.ceil(cfg.n / 5);
  const refinePerRun = cfg.refinePerRun ?? Math.max(120, Math.ceil(cfg.n / 2));
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    daily_budget_usd: 1e9,
    rating: { ...DEFAULT_SETTINGS.rating, max_placements_per_run: placementsPerRun, max_refine_matches_per_run: refinePerRun, min_refine_batch: 1, soft_wall_clock_minutes: 1e9 },
  };
  await dataInit(store, { now: clock.iso(), settings });
  for (const cat of CATEGORIES) await store.writeJson(anchorsPath(cat), syntheticAnchors(cat));

  // Latent strengths and rubric scores: the rubric seed is the truth through the seed map plus noise.
  const truth = new Map<string, number>();
  const specs: SeedSpec[] = [];
  const domains: Category[] = ['tech', 'finance', 'academia'];
  for (let i = 0; i < cfg.n; i++) {
    const id = idFor(i, 'sim');
    const t = 1500 + gaussian(rng) * cfg.truthSigma;
    truth.set(id, t);
    const score = clamp(Math.round(50 + (t - 1200) / 8 + gaussian(rng) * cfg.rubricNoise), 0, 100);
    const scores: SeedSpec['scores'] = { general: score };
    let k = Math.floor(cfg.domainsPerResume);
    if (rng.next() < cfg.domainsPerResume - k) k++;
    const picks = rng.shuffle([...domains]).slice(0, Math.min(3, Math.max(0, k)));
    for (const d of picks) scores[d] = clamp(Math.round(score + gaussian(rng) * cfg.rubricNoise), 0, 100);
    specs.push({ id, ownerHash: ownerFor(i), scores, queuedAt: clock.iso(), stage: 'mid' });
  }
  await seedResumes(store, specs);
  // Anchors are the fixed scale: their truth is their rating.
  const strength = (id: string): number => {
    if (isAnchorId(id)) return 1000 + 'bcdefghijklm'.indexOf(id[6] ?? 'b') * 100;
    return truth.get(id) ?? 1500;
  };
  let passes = 0;
  let firstWins = 0;
  const judge = createSyntheticJudge({
    strength,
    seed: `sim|${cfg.seed}`,
    judgeNoise: cfg.judgeNoise,
    positionBias: cfg.positionBias,
    onPass: (firstWon) => {
      passes++;
      if (firstWon) firstWins++;
    },
  });
  const env = { ...readEnv({ GITHUB_ACTIONS: 'false' }), llmMode: 'mock' as const, raEnv: 'local', githubToken: null, noGit: true, seed: `sim|${cfg.seed}` };
  const prompts = loadPrompts(join(repoRootFromHere(), 'engine', 'prompts'), join(repoRootFromHere(), 'docs', 'prompts'));
  const ctxFor = (run: number): Context => createContext({ env, store, clock, prompts, seed: `sim|${cfg.seed}|${run}`, runId: `sim-${run}`, log: silentLogger, transport: { mode: 'mock', call: async () => { throw new Error('the simulation never calls the LLM transport'); } } });

  const report: SimReport = {
    n: cfg.n, runs: cfg.runs, matches: 0, placementMatches: 0, refineMatches: 0, rhoAfterPlacement: null, rhoAt25: null, rhoTopDecileAt40: null, meanGamesAtEnd: 0,
    meanRdAfterPlacement: null, disagreementRate: 0, anchorResidualLastWeek: null, anchorGamesLastWeek: 0, firstWinRatePerPass: 0, orderOutcomeSpearman: 0, totalCostUsd: 0, expectedCostUsd: 0, elapsedMs: 0,
  };
  const generalRows = async (): Promise<RatingRow[]> => {
    const file = (await store.readJson<{ rows: Record<string, RatingRow> }>(ratingsPath('general')))!;
    return Object.values(file.rows).filter((r) => r.kind === 'user' && r.r !== null);
  };
  const rho = (rows: RatingRow[]): number => spearman(rows.map((r) => truth.get(r.id) as number), rows.map((r) => r.r as number));
  const hours = cfg.hoursBetweenRuns ?? 12;
  const userRows = (rows: RatingRow[]): RatingRow[] => rows.filter((r) => truth.has(r.id));
  // RD "after placement" is each row's RD at the end of the run in which it placed, not its RD once the
  // last row of the population placed (by then early rows have been refined for weeks).
  const rdAtPlacement = new Map<string, number>();

  for (let run = 1; run <= cfg.runs; run++) {
    const r = await runRerank(ctxFor(run), { judge, trigger: 'sim' });
    if (r.state !== 'ok') throw new Error(`sim run ${run}: ${r.state} ${r.error ?? ''}`);
    report.matches += r.matches;
    report.placementMatches += r.placementMatches;
    report.refineMatches += r.refineMatches;
    const rows = userRows(await generalRows());
    const placed = rows.filter((x) => x.placed);
    for (const x of placed) if (!rdAtPlacement.has(x.id)) rdAtPlacement.set(x.id, x.rd);
    if (report.rhoAfterPlacement === null && placed.length === cfg.n) {
      report.rhoAfterPlacement = rho(placed);
      report.meanRdAfterPlacement = [...rdAtPlacement.values()].reduce((a, x) => a + x, 0) / rdAtPlacement.size;
    }
    const meanGames = rows.reduce((a, x) => a + x.g, 0) / Math.max(1, rows.length);
    if (report.rhoAt25 === null && placed.length === cfg.n && meanGames >= 25) report.rhoAt25 = rho(placed);
    if (report.rhoTopDecileAt40 === null && placed.length === cfg.n && meanGames >= 40) {
      const sorted = [...placed].sort((a, b) => (truth.get(b.id) as number) - (truth.get(a.id) as number));
      report.rhoTopDecileAt40 = rho(sorted.slice(0, Math.max(3, Math.floor(sorted.length / 10))));
    }
    report.meanGamesAtEnd = meanGames;
    clock.advance(hours * 3_600_000);
  }

  // Match-log statistics.
  const lines: MatchLine[] = [];
  for (const cat of CATEGORIES) for (const f of await store.listFiles(`matches/${cat}`)) for (const l of await store.readLines(f)) lines.push(JSON.parse(l) as MatchLine);
  report.disagreementRate = lines.length ? lines.filter((l) => !l.agree).length / lines.length : 0;
  const weekAgo = new Date(clock.now().getTime() - 7 * 86_400_000).toISOString();
  const recent = lines.filter((l) => l.at >= weekAgo);
  const drift = driftReport(recent, { minGames: 1, maxShift: 10 });
  report.anchorResidualLastWeek = drift.n ? drift.res : null;
  report.anchorGamesLastWeek = drift.n;
  report.firstWinRatePerPass = passes ? firstWins / passes : 0;
  // Per pass: x = 1 when side a was shown first, y = the match outcome for a. Both orderings always run, so ρ is 0 by construction.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const l of lines) {
    xs.push(1, 0);
    ys.push(l.o, l.o);
  }
  report.orderOutcomeSpearman = lines.length ? spearman(xs, ys) : 0;
  const usage: number[] = [];
  for (const f of await store.listFiles('usage')) for (const l of parseUsageLines(await store.readLines(f))) usage.push(l.usd);
  report.totalCostUsd = usage.reduce((a, b) => a + b, 0);
  report.expectedCostUsd = report.matches * 2 * costOf(FIXED_USAGE, SIM_MODEL, PRICES_FALLBACK);
  report.elapsedMs = Date.now() - started;
  return report;
}
