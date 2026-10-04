// Analyst call (§5.5 step 7, §9.6): Opus 5.5 with explicit effort, 16k non-streaming, 24k streamed on a
// max_tokens retry, one retry with a validation_note on a Zod failure, server-side refusal fallback.
import { ANALYSIS_SCHEMA, parseResumeAnalysis, type LayoutMetrics, type ModelPrices, type ResumeAnalysis, type Settings } from '@resumearena/shared';
import { priceResponse, type LlmRequest, type LlmTransport } from './client.ts';
import { buildUserMessage } from './framing.ts';
import { interpret, sumUsd, usageEventOf, type CallResult, type UsageEvent } from './calls.ts';
import type { PromptSet } from './prompts.ts';
import type { Logger } from '../summary.ts';

export const ANALYST_MAX_TOKENS = 16_000;
export const ANALYST_RETRY_MAX_TOKENS = 24_000;

export interface AnalystDeps {
  transport: LlmTransport;
  settings: Settings;
  prompts: PromptSet;
  prices: Record<string, ModelPrices>;
  log?: Logger;
}

export async function runAnalysis(deps: AnalystDeps, input: { text: string; metrics: LayoutMetrics }): Promise<CallResult<ResumeAnalysis>> {
  const started = Date.now();
  const usage: UsageEvent[] = [];
  const request = (opts: { maxTokens: number; stream: boolean; validationNote: string | null }): LlmRequest => ({
    purpose: 'analysis',
    model: deps.settings.models.analyst,
    max_tokens: opts.maxTokens,
    system: deps.prompts.analyst.text,
    cache_ttl: '1h',
    user: buildUserMessage({ text: input.text, metrics: input.metrics, validationNote: opts.validationNote }),
    schema: ANALYSIS_SCHEMA as Record<string, unknown>,
    effort: deps.settings.models.analyst_effort,
    thinking: true,
    fallbacks: true,
    stream: opts.stream,
  });

  let maxTokens = ANALYST_MAX_TOKENS;
  let stream = false;
  let validationNote: string | null = null;
  let retriedMaxTokens = false;
  let retriedValidation = false;
  let model = deps.settings.models.analyst;
  let lastDetail = '';
  let lastReason: 'refusal' | 'max_tokens' | 'invalid_output' = 'invalid_output';

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await deps.transport.call(request({ maxTokens, stream, validationNote }));
    usage.push(usageEventOf(res, priceResponse(res, deps.prices, deps.log)));
    model = res.model;
    const out = interpret(res, parseResumeAnalysis);
    if (out.kind === 'ok') return { ok: true, value: out.value, repairs: out.repairs, model, fell_back: res.fell_back, latency_ms: Date.now() - started, usage, usd: sumUsd(usage) };
    lastDetail = out.detail;
    lastReason = out.reason === 'api_error' ? 'invalid_output' : out.reason;
    if (out.reason === 'refusal') break;
    if (out.reason === 'max_tokens' && !retriedMaxTokens) {
      retriedMaxTokens = true;
      maxTokens = ANALYST_RETRY_MAX_TOKENS;
      stream = true;
      continue;
    }
    if (out.reason === 'invalid_output' && !retriedValidation) {
      retriedValidation = true;
      validationNote = out.detail;
      continue;
    }
    break;
  }
  return { ok: false, reason: lastReason, detail: lastDetail, model, latency_ms: Date.now() - started, usage, usd: sumUsd(usage) };
}
