// Pairwise judge (§9.4, §9.6, D-06): two orderings per match fired together, forced choice,
// disagreement = draw. Adaptive semaphore, typed retries, circuit breaker, per-call pricing.
import {
  JUDGE_SCHEMA, canonicalJson, outcomeFromPasses, parsePairwiseVerdict, sweepCard,
  type Card, type Category, type MatchKind, type ModelPrices, type Outcome, type PairwiseVerdict, type Settings, type TokenCounts, type Verdict,
} from '@resumearena/shared';
import { classifyApiError, priceResponse, type LlmRequest, type LlmTransport } from './client.ts';
import { interpret, type UsageEvent } from './calls.ts';
import type { PromptSet } from './prompts.ts';
import type { Rng } from '../rng.ts';
import type { Logger } from '../summary.ts';

export const JUDGE_MAX_TOKENS = 1536;
export const JUDGE_RETRY_MAX_TOKENS = 3072;
export const JUDGE_API_RETRIES = 5;
export const BREAKER_THRESHOLD = 10;

export interface MatchRequest {
  cat: Category;
  kind: MatchKind;
  period: string;
  subj: string;
  /** a < b lexicographically. */
  a: string;
  b: string;
  cardA: Card;
  cardB: Card;
  pre: { ar: number; ard: number; br: number; brd: number };
}

export type MatchFailureReason = 'refusal' | 'max_tokens' | 'invalid_output' | 'api_error' | 'stopped';

export type MatchResult =
  | { ok: true; req: MatchRequest; p1: Verdict; p2: Verdict; o: Outcome; agree: boolean; model: string; tok: TokenCounts; usd: number; usage: UsageEvent[] }
  | { ok: false; req: MatchRequest; reason: MatchFailureReason; detail: string; usage: UsageEvent[] };

export class JudgeFatal extends Error {
  readonly code: 'judge_unavailable' | 'config';
  /** Verdicts decided before the breaker tripped (§9.4: "finalize what exists"); empty for config errors. */
  readonly partial: MatchResult[];
  constructor(code: 'judge_unavailable' | 'config', message: string, partial: MatchResult[] = []) {
    super(message);
    this.name = 'JudgeFatal';
    this.code = code;
    this.partial = partial;
  }
}

export interface JudgeOptions {
  transport: LlmTransport;
  settings: Settings;
  prompts: PromptSet;
  prices: Record<string, ModelPrices>;
  rng: Rng;
  /** Budget / wall-clock gate consulted before each call. */
  shouldStop?: () => boolean;
  onUsage?: (purpose: 'judge_place' | 'judge_refine' | 'judge_anchor', event: UsageEvent, req: MatchRequest) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  /** Validation runs bill as judge_anchor. */
  purposeOverride?: 'judge_anchor';
}

export interface JudgeStats {
  calls: number;
  retries: number;
  failures: number;
  consecutiveFailures: number;
  concurrencyNow: number;
  rateLimited: number;
}

export interface Judge {
  judgeMany(reqs: MatchRequest[]): Promise<MatchResult[]>;
  stats(): JudgeStats;
  /** True after the first successful call of this process. */
  healthy(): boolean;
}

/**
 * A counting semaphore whose limit can shrink while permits are out (adaptive concurrency). A release
 * hands its permit to exactly one waiter and counts it in-flight synchronously, so admission is always
 * gated by `limit`; resolving the waiter later (microtask) must not reopen the gate for the others.
 */
export class Semaphore {
  limit: number;
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  constructor(limit: number) {
    this.limit = limit;
  }
  get active(): number {
    return this.inFlight;
  }
  acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    this.inFlight--;
    if (this.inFlight < this.limit && this.waiters.length) {
      this.inFlight++;
      (this.waiters.shift() as () => void)();
    }
  }
}

export const purposeFor = (kind: MatchKind): 'judge_place' | 'judge_refine' => (kind === 'placement' || kind === 'revision' ? 'judge_place' : 'judge_refine');

export function judgeUserMessage(cat: Category, first: Card, second: Card): string {
  return canonicalJson({ category: cat, first: sweepCard(first).card, second: sweepCard(second).card });
}

const toVerdict = (v: PairwiseVerdict, model: string, matchModel: string): Verdict => ({
  winner: v.winner,
  confidence: v.confidence,
  factors: v.decisive_factors,
  reasoning: v.reasoning,
  ...(model !== matchModel ? { model } : {}),
});

export function createJudge(opts: JudgeOptions): Judge {
  const maxConcurrency = opts.settings.rating.judge_concurrency;
  const sem = new Semaphore(maxConcurrency);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats: JudgeStats = { calls: 0, retries: 0, failures: 0, consecutiveFailures: 0, concurrencyNow: maxConcurrency, rateLimited: 0 };
  let consecutiveSuccesses = 0;
  let everSucceeded = false;
  let tripped = false;

  const onRateLimit = (): void => {
    stats.rateLimited++;
    sem.limit = Math.max(2, Math.floor(sem.limit / 2));
    stats.concurrencyNow = sem.limit;
    consecutiveSuccesses = 0;
  };
  const onSuccess = (): void => {
    everSucceeded = true;
    stats.consecutiveFailures = 0;
    consecutiveSuccesses++;
    if (consecutiveSuccesses >= 20 && sem.limit < maxConcurrency) {
      sem.limit++;
      stats.concurrencyNow = sem.limit;
      consecutiveSuccesses = 0;
    }
  };

  type PassOut = { kind: 'ok'; verdict: PairwiseVerdict; model: string } | { kind: 'fail'; reason: MatchFailureReason; detail: string };

  async function onePass(req: MatchRequest, pass: 1 | 2, events: UsageEvent[], seq: number): Promise<PassOut> {
    const [first, second] = pass === 1 ? [req.cardA, req.cardB] : [req.cardB, req.cardA];
    let maxTokens = JUDGE_MAX_TOKENS;
    let retriedMaxTokens = false;
    let apiRetries = 0;
    for (;;) {
      if (opts.shouldStop?.()) return { kind: 'fail', reason: 'stopped', detail: 'stopped before call' };
      if (tripped) return { kind: 'fail', reason: 'api_error', detail: 'judge_unavailable' };
      const request: LlmRequest = {
        purpose: 'judge',
        model: opts.settings.models.judge,
        max_tokens: maxTokens,
        system: opts.prompts.judge.byCategory[req.cat],
        cache_ttl: '1h',
        user: judgeUserMessage(req.cat, first, second),
        schema: JUDGE_SCHEMA as Record<string, unknown>,
        effort: opts.settings.models.judge_effort,
        thinking: true,
        fallbacks: true,
        stream: false,
        meta: { pass, seq, cat: req.cat, a: req.a, b: req.b },
      };
      await sem.acquire();
      let res;
      try {
        stats.calls++;
        res = await opts.transport.call(request);
      } catch (e) {
        const cls = classifyApiError(e);
        if (cls.kind === 'config') throw new JudgeFatal('config', `judge API configuration error: ${(e as Error).message}`);
        if ((cls.kind === 'rate_limit' || cls.kind === 'server' || cls.kind === 'connection') && apiRetries < JUDGE_API_RETRIES) {
          if (cls.kind === 'rate_limit') onRateLimit();
          const backoff = Math.min(60_000, 2_000 * 2 ** apiRetries) + opts.rng.next() * 1_000;
          apiRetries++;
          stats.retries++;
          await sleep(cls.retryAfterMs ?? backoff);
          continue;
        }
        return { kind: 'fail', reason: 'api_error', detail: (e as Error).message };
      } finally {
        sem.release();
      }
      const priced = priceResponse(res, opts.prices, opts.log);
      const event: UsageEvent = { model: res.model, tok: priced.tok, usd: priced.usd };
      events.push(event);
      opts.onUsage?.(opts.purposeOverride ?? purposeFor(req.kind), event, req);
      const out = interpret(res, parsePairwiseVerdict);
      if (out.kind === 'ok') {
        onSuccess();
        return { kind: 'ok', verdict: out.value, model: res.model };
      }
      if (out.reason === 'max_tokens' && !retriedMaxTokens) {
        retriedMaxTokens = true;
        maxTokens = JUDGE_RETRY_MAX_TOKENS;
        continue;
      }
      // A refusal that survived the server-side fallback, or malformed output, fails the match (never one-sided scoring).
      return { kind: 'fail', reason: out.reason === 'api_error' ? 'invalid_output' : out.reason, detail: out.detail };
    }
  }

  async function oneMatch(req: MatchRequest, seq: number): Promise<MatchResult> {
    const events: UsageEvent[] = [];
    const [r1, r2] = await Promise.allSettled([onePass(req, 1, events, seq), onePass(req, 2, events, seq)]);
    for (const r of [r1, r2]) if (r.status === 'rejected') throw r.reason;
    const p1 = (r1 as PromiseFulfilledResult<PassOut>).value;
    const p2 = (r2 as PromiseFulfilledResult<PassOut>).value;
    if (p1.kind !== 'ok' || p2.kind !== 'ok') {
      const failed = p1.kind !== 'ok' ? p1 : (p2 as Extract<PassOut, { kind: 'fail' }>);
      stats.failures++;
      if (failed.reason === 'api_error') {
        stats.consecutiveFailures++;
        if (stats.consecutiveFailures >= BREAKER_THRESHOLD) tripped = true;
      }
      return { ok: false, req, reason: failed.reason, detail: failed.detail, usage: events };
    }
    const { o, agree } = outcomeFromPasses(p1.verdict.winner, p2.verdict.winner);
    const tok = events.reduce<TokenCounts>((acc, e) => ({ in: acc.in + e.tok.in, cr: acc.cr + e.tok.cr, cw: acc.cw + e.tok.cw, out: acc.out + e.tok.out }), { in: 0, cr: 0, cw: 0, out: 0 });
    const usd = Math.round(events.reduce((a, e) => a + e.usd, 0) * 1e6) / 1e6;
    return { ok: true, req, p1: toVerdict(p1.verdict, p1.model, p1.model), p2: toVerdict(p2.verdict, p2.model, p1.model), o, agree, model: p1.model, tok, usd, usage: events };
  }

  return {
    async judgeMany(reqs) {
      // Group by category so each category's cached system prompt is read back to back.
      const order = reqs.map((_r, i) => i).sort((x, y) => (reqs[x]!.cat < reqs[y]!.cat ? -1 : reqs[x]!.cat > reqs[y]!.cat ? 1 : x - y));
      const out: MatchResult[] = new Array(reqs.length);
      await Promise.all(order.map(async (i) => {
        out[i] = await oneMatch(reqs[i] as MatchRequest, i);
      }));
      // The verdicts that succeeded before the breaker tripped travel with the error so the caller can
      // WAL-commit and ledger them before aborting (§9.4: "finalize what exists").
      if (tripped) throw new JudgeFatal('judge_unavailable', `${BREAKER_THRESHOLD} consecutive judge API failures`, out);
      return out;
    },
    stats: () => ({ ...stats }),
    healthy: () => everSucceeded && !tripped,
  };
}
