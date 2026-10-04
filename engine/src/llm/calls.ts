// What every LLM caller returns: a validated value or a typed failure, plus the usage events to ledger.
import type { ParseResult, TokenCounts } from '@resumearena/shared';
import type { LlmResponse, Priced } from './client.ts';

export type CallFailureReason = 'refusal' | 'max_tokens' | 'invalid_output' | 'api_error';

export interface UsageEvent {
  model: string;
  tok: TokenCounts;
  usd: number;
}

export interface CallOk<T> {
  ok: true;
  value: T;
  repairs: number;
  model: string;
  fell_back: boolean;
  latency_ms: number;
  usage: UsageEvent[];
  usd: number;
}

export interface CallFail {
  ok: false;
  reason: CallFailureReason;
  detail: string;
  model: string;
  latency_ms: number;
  usage: UsageEvent[];
  usd: number;
}

export type CallResult<T> = CallOk<T> | CallFail;

export const sumUsd = (events: readonly UsageEvent[]): number => Math.round(events.reduce((a, e) => a + e.usd, 0) * 1e6) / 1e6;

export const usageEventOf = (res: LlmResponse, priced: Priced): UsageEvent => ({ model: res.model, tok: priced.tok, usd: priced.usd });

/** The common check order (§9.6): refusal → max_tokens → text block → JSON.parse → Zod. */
export function interpret<T>(res: LlmResponse, parse: (raw: unknown) => ParseResult<T>): { kind: 'ok'; value: T; repairs: number } | { kind: 'fail'; reason: CallFailureReason; detail: string } {
  if (res.stop_reason === 'refusal') return { kind: 'fail', reason: 'refusal', detail: res.refusal_category ? `refusal:${res.refusal_category}` : 'refusal' };
  if (res.stop_reason === 'max_tokens') return { kind: 'fail', reason: 'max_tokens', detail: 'max_tokens' };
  if (res.text === null || res.text.trim() === '') return { kind: 'fail', reason: 'invalid_output', detail: 'no text block' };
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch (e) {
    return { kind: 'fail', reason: 'invalid_output', detail: `JSON.parse: ${(e as Error).message}` };
  }
  const parsed = parse(raw);
  if (!parsed.ok) return { kind: 'fail', reason: 'invalid_output', detail: parsed.message };
  return { kind: 'ok', value: parsed.value, repairs: parsed.repairs };
}
