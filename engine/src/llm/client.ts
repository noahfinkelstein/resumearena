// The transport boundary (§9.6, §13.2). Callers build an LlmRequest; a transport answers with the raw
// shape every caller checks in the same order: stop_reason refusal → max_tokens → text block → JSON → Zod.
// Live talks to the Anthropic API; mock synthesizes; record wraps live; replay serves recordings.
import Anthropic from '@anthropic-ai/sdk';
import { PRICES_FALLBACK, PriceError, costOf, tokenCountsOf, type ApiUsage, type ModelPrices, type TokenCounts } from '@resumearena/shared';
import type { LlmMode } from '../env.ts';
import type { Logger } from '../summary.ts';

export type LlmPurpose = 'gate' | 'analysis' | 'judge' | 'anchor_gen' | 'fixture_text';

export interface LlmRequest {
  purpose: LlmPurpose;
  model: string;
  max_tokens: number;
  system: string;
  cache_ttl: '5m' | '1h';
  user: string;
  /** JSON schema for structured output; omitted for plain-text generation. */
  schema?: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high';
  thinking: boolean;
  fallbacks: boolean;
  stream: boolean;
  /** Free-form hints for the mock (category, pair ids); never sent to the API. */
  meta?: Record<string, unknown>;
}

export interface LlmResponse {
  stop_reason: string | null;
  text: string | null;
  model: string;
  usage: ApiUsage;
  fell_back: boolean;
  refusal_category: string | null;
}

export interface LlmTransport {
  readonly mode: LlmMode;
  call(req: LlmRequest): Promise<LlmResponse>;
}

/** Thrown when the API cannot be used at all: bad key, bad request, missing model. Exit 1 territory. */
export class LlmConfigError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmConfigError';
    this.status = status;
  }
}

export type ApiErrorClass = { kind: 'rate_limit' | 'server' | 'connection'; retryAfterMs: number | null } | { kind: 'config'; status: number | undefined } | { kind: 'other' };

/** Most specific class first; never string-matches messages. */
export function classifyApiError(e: unknown): ApiErrorClass {
  if (e instanceof Anthropic.RateLimitError) return { kind: 'rate_limit', retryAfterMs: retryAfterMs(e.headers) };
  if (e instanceof Anthropic.InternalServerError) return { kind: 'server', retryAfterMs: retryAfterMs(e.headers) };
  if (e instanceof Anthropic.APIConnectionError) return { kind: 'connection', retryAfterMs: null };
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) {
    return { kind: 'config', status: e.status };
  }
  if (e instanceof LlmConfigError) return { kind: 'config', status: e.status };
  if (e instanceof Anthropic.APIError) return { kind: 'other' };
  return { kind: 'other' };
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const v = headers?.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export interface Priced {
  tok: TokenCounts;
  usd: number;
}

/** Price by the served model; an unknown model falls back to the code table with a warning rather than billing zero. */
export function priceResponse(res: LlmResponse, prices: Record<string, ModelPrices>, log?: Logger): Priced {
  const tok = tokenCountsOf(res.usage);
  try {
    return { tok, usd: costOf(res.usage, res.model, prices) };
  } catch (e) {
    if (!(e instanceof PriceError)) throw e;
    log?.warn(`no price for model ${res.model} in settings.json; using the built-in table`);
    return { tok, usd: costOf(res.usage, res.model, PRICES_FALLBACK) };
  }
}

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// ---- live -------------------------------------------------------------------------------------------

type BetaParams = Parameters<Anthropic['beta']['messages']['create']>[0];

function toParams(req: LlmRequest): BetaParams {
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    system: [{ type: 'text', text: req.system, cache_control: req.cache_ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.user }],
  };
  if (req.fallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  if (req.thinking) params.thinking = { type: 'adaptive' };
  const outputConfig: Record<string, unknown> = {};
  if (req.effort) outputConfig.effort = req.effort;
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  return params as unknown as BetaParams;
}

function fromMessage(msg: Anthropic.Beta.Messages.BetaMessage): LlmResponse {
  const textBlock = msg.content.find((b) => b.type === 'text');
  const usage = msg.usage as unknown as ApiUsage & { iterations?: { type: string }[] | null };
  const fellBack = Array.isArray(usage.iterations) && usage.iterations.some((i) => i.type === 'fallback_message');
  const details = (msg as unknown as { stop_details?: { category?: string | null } | null }).stop_details;
  return {
    stop_reason: msg.stop_reason,
    text: textBlock && textBlock.type === 'text' ? textBlock.text : null,
    model: msg.model,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_creation: usage.cache_creation ?? null,
    },
    fell_back: fellBack,
    refusal_category: msg.stop_reason === 'refusal' ? (details?.category ?? null) : null,
  };
}

export function createLiveTransport(opts: { apiKey: string | null }): LlmTransport {
  if (!opts.apiKey) throw new LlmConfigError('ANTHROPIC_API_KEY is not set (required for --llm live|record)');
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: 600_000, maxRetries: 2 });
  return {
    mode: 'live',
    async call(req) {
      const params = toParams(req);
      if (req.stream) {
        const msg = await client.beta.messages.stream(params as Parameters<Anthropic['beta']['messages']['stream']>[0]).finalMessage();
        return fromMessage(msg);
      }
      const msg = await client.beta.messages.create({ ...(params as object), stream: false } as BetaParams & { stream: false });
      return fromMessage(msg as Anthropic.Beta.Messages.BetaMessage);
    },
  };
}
