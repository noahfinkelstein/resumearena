// Gate call (§9.3 step 8, §9.6): Haiku 4.5, no thinking, no effort, no fallbacks. One retry on invalid output.
import { GATE_SCHEMA, parseGateVerdict, type GateVerdict, type LayoutMetrics, type ModelPrices, type Settings } from '@resumearena/shared';
import { priceResponse, type LlmTransport } from './client.ts';
import { buildUserMessage } from './framing.ts';
import { interpret, sumUsd, usageEventOf, type CallResult, type UsageEvent } from './calls.ts';
import type { PromptSet } from './prompts.ts';
import type { Logger } from '../summary.ts';

export const GATE_MAX_TOKENS = 512;

export interface GateDeps {
  transport: LlmTransport;
  settings: Settings;
  prompts: PromptSet;
  prices: Record<string, ModelPrices>;
  log?: Logger;
}

export async function runGate(deps: GateDeps, input: { text: string; metrics: LayoutMetrics }): Promise<CallResult<GateVerdict>> {
  const started = Date.now();
  const usage: UsageEvent[] = [];
  let model = deps.settings.models.gate;
  let detail = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.transport.call({
      purpose: 'gate',
      model: deps.settings.models.gate,
      max_tokens: GATE_MAX_TOKENS,
      system: deps.prompts.gate.text,
      cache_ttl: '5m',
      user: buildUserMessage({ text: input.text, metrics: input.metrics, validationNote: attempt > 0 ? detail : null }),
      schema: GATE_SCHEMA as Record<string, unknown>,
      thinking: false,
      fallbacks: false,
      stream: false,
    });
    usage.push(usageEventOf(res, priceResponse(res, deps.prices, deps.log)));
    model = res.model;
    const out = interpret(res, parseGateVerdict);
    if (out.kind === 'ok') return { ok: true, value: out.value, repairs: out.repairs, model, fell_back: res.fell_back, latency_ms: Date.now() - started, usage, usd: sumUsd(usage) };
    detail = out.detail;
    // A refusal or a truncated gate answer is final; only malformed output earns the retry.
    if (out.reason !== 'invalid_output') return { ok: false, reason: out.reason, detail, model, latency_ms: Date.now() - started, usage, usd: sumUsd(usage) };
  }
  return { ok: false, reason: 'invalid_output', detail, model, latency_ms: Date.now() - started, usage, usd: sumUsd(usage) };
}
