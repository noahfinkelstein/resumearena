// Synthetic judges for the simulation and the engine tests (§13.3). They implement the engine's Judge
// interface, so the real rerank runs unchanged: P(first wins) = σ((s_first + bias − s_second)/400·ln10 + ε).
import { costOf, outcomeFromPasses, PRICES_FALLBACK, type ApiUsage, type ModelPrices, type TokenCounts, type Verdict } from '@resumearena/shared';
import type { Judge, JudgeStats, MatchRequest, MatchResult } from '../src/llm/judge.ts';
import { createRng, gaussian, sha256Hex } from '../src/rng.ts';

export const FIXED_USAGE: ApiUsage = { input_tokens: 1500, output_tokens: 450, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 };
export const SIM_MODEL = 'claude-sonnet-5-5';

export interface SyntheticJudgeOptions {
  /** Latent strength per id (anchors: their rating). */
  strength: (id: string) => number;
  seed: string;
  judgeNoise?: number;
  positionBias?: number;
  prices?: Record<string, ModelPrices>;
  usage?: ApiUsage;
  /** Count passes for the bias audit. */
  onPass?: (firstWon: boolean) => void;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function createSyntheticJudge(o: SyntheticJudgeOptions): Judge {
  const noise = o.judgeNoise ?? 0;
  const bias = o.positionBias ?? 0;
  const usage = o.usage ?? FIXED_USAGE;
  const usd = costOf(usage, SIM_MODEL, o.prices ?? PRICES_FALLBACK);
  const tok: TokenCounts = { in: usage.input_tokens, cr: usage.cache_read_input_tokens ?? 0, cw: usage.cache_creation_input_tokens ?? 0, out: usage.output_tokens };
  let calls = 0;
  const pass = (first: string, second: string, rngKey: string): Verdict => {
    const rng = createRng(rngKey);
    const eps = noise ? gaussian(rng) * noise : 0;
    const p = sigmoid(((o.strength(first) + bias - o.strength(second)) / 400) * Math.LN10 + eps);
    const firstWins = rng.next() < p;
    o.onPass?.(firstWins);
    return { winner: firstWins ? 'first' : 'second', confidence: 0.5 + Math.abs(p - 0.5), factors: [`${firstWins ? 'first' : 'second'}: synthetic`], reasoning: 'synthetic judge' };
  };
  return {
    async judgeMany(reqs: MatchRequest[]): Promise<MatchResult[]> {
      return reqs.map((req): MatchResult => {
        calls += 2;
        // Keyed by the pair, the category and the period so a restarted run gets the same verdicts.
        const key = `${o.seed}|${req.cat}|${req.period}|${req.a}|${req.b}`;
        const p1 = pass(req.a, req.b, `${key}|1`);
        const p2 = pass(req.b, req.a, `${key}|2`);
        const { o: outcome, agree } = outcomeFromPasses(p1.winner, p2.winner);
        const events = [{ model: SIM_MODEL, tok, usd }, { model: SIM_MODEL, tok, usd }];
        return { ok: true, req, p1, p2, o: outcome, agree, model: SIM_MODEL, tok: { in: tok.in * 2, cr: tok.cr * 2, cw: tok.cw * 2, out: tok.out * 2 }, usd: Math.round(usd * 2 * 1e6) / 1e6, usage: events };
      });
    },
    stats: (): JudgeStats => ({ calls, retries: 0, failures: 0, consecutiveFailures: 0, concurrencyNow: 8, rateLimited: 0 }),
    healthy: () => true,
  };
}

/** A judge that fails every match the given way (tests of zero-success rounds and the breaker path). */
export function createFailingJudge(reason: 'api_error' | 'refusal'): Judge {
  return {
    async judgeMany(reqs) {
      return reqs.map((req): MatchResult => ({ ok: false, req, reason, detail: 'scripted failure', usage: [] }));
    },
    stats: () => ({ calls: 0, retries: 0, failures: 0, consecutiveFailures: 0, concurrencyNow: 8, rateLimited: 0 }),
    healthy: () => false,
  };
}

export const strengthFromId = (seed: string) => (id: string): number => 1000 + (parseInt(sha256Hex(`${seed}|${id}`).slice(0, 6), 16) % 1100);
