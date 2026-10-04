// Cost of one API response (§9.6). Priced by `response.model`, because the server-side refusal
// fallback may answer from a different model than the one requested.
import type { ModelPrices } from './types.ts';
import { PRICES_FALLBACK } from './constants.ts';

/** The subset of the SDK's `usage` object that costs money; every field but the first two may be absent. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null | undefined; ephemeral_5m_input_tokens?: number | null | undefined } | null | undefined;
}

/** The four counters a UsageLine / MatchLine carries; `cw` is every cache write regardless of TTL. */
export interface TokenCounts {
  in: number;
  cr: number;
  cw: number;
  out: number;
}

export class PriceError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`no price entry for model "${model}"`);
    this.name = 'PriceError';
    this.model = model;
  }
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function tokenCountsOf(u: ApiUsage): TokenCounts {
  return { in: n(u.input_tokens), cr: n(u.cache_read_input_tokens), cw: n(u.cache_creation_input_tokens), out: n(u.output_tokens) };
}

/**
 * Exact key first; then the longest table key that is a prefix of the served model id (dated
 * snapshots like `claude-opus-5-5-20260601`). Unknown models throw so a misconfigured price table
 * fails loudly instead of billing at zero.
 */
export function resolvePrices(model: string, prices: Record<string, ModelPrices> = PRICES_FALLBACK): ModelPrices {
  const exact = prices[model];
  if (exact) return exact;
  let best: ModelPrices | undefined;
  let bestLen = 0;
  for (const [key, p] of Object.entries(prices)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = p;
      bestLen = key.length;
    }
  }
  if (best) return best;
  throw new PriceError(model);
}

/** Round to the 6 decimal places every money figure on disk carries. */
export const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * USD for one response. Cache writes are priced by TTL when the breakdown is present; any
 * `cache_creation_input_tokens` not accounted for by the breakdown is billed at the 5-minute rate,
 * which is also what an SDK without the breakdown field implies.
 */
export function costOf(usage: ApiUsage, model: string, prices: Record<string, ModelPrices> = PRICES_FALLBACK): number {
  const p = resolvePrices(model, prices);
  const t = tokenCountsOf(usage);
  const w1h = Math.min(t.cw, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  const w5m = Math.min(t.cw - w1h, n(usage.cache_creation?.ephemeral_5m_input_tokens));
  const wRest = t.cw - w1h - w5m;
  const usd = (t.in * p.input + t.cr * p.cache_read + w1h * p.cache_write_1h + (w5m + wRest) * p.cache_write_5m + t.out * p.output) / 1e6;
  return roundUsd(usd);
}
