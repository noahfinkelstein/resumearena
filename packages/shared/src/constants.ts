// Limits, versions, price fallbacks and the default settings document.
// `settings.json` on the data branch overrides everything here at runtime (§3.3); these are the
// values `data init` writes and the browser falls back to before Pages `settings.json` loads.
import type { Category, ModelPrices, Settings, RedactionKind } from './types.ts';

export const REPO = 'noahfinkelstein/resumearena';
export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/data`;
export const PAGES_BASE = 'https://noahfinkelstein.github.io/resumearena';
export const PAGES_DATA_BASE = `${PAGES_BASE}/data`;

export const ENGINE_VERSION = '0.1.0';
export const SCHEMA_VERSION = '1.1';
export const CARD_VERSION = '1.0';
export const TAXONOMY_VERSION = '2026-10';

export const DOMAINS = ['finance', 'tech', 'academia'] as const satisfies readonly Category[];

// Text and payload limits (§7.1). Shared by the SPA counter and the engine's normalizePayload.
export const MIN_TEXT_CHARS = 400;
export const MAX_TEXT_CHARS = 15_000;
export const MAX_METRICS_JSON_CHARS = 2_000;
export const MAX_HANDLE_CHARS = 20;
export const MIN_HANDLE_CHARS = 3;
export const MAX_CLIENT_VERSION_CHARS = 24;
export const CLIENT_VERSION_RE = /^[a-z0-9.-]{0,24}$/;
/** Browser-side file size cap; the spec leaves the number open, 10 MiB covers any real résumé PDF. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Characters per page assumed for docx/paste sources (LayoutMetrics.pages). */
export const CHARS_PER_PAGE = 3000;

export const PAGE_SIZE = 100;
export const ARENA_MIN_PAIRS = 20;

export const PLACEHOLDER_TOKENS = {
  name: '[name]',
  email: '[email]',
  phone: '[phone]',
  url: '[url]',
  address: '[address]',
  manual: '[redacted]',
} as const satisfies Record<RedactionKind, string>;
export const REMOVED_TOKEN = '[removed]';

export const MODELS = {
  gate: 'claude-haiku-4-5',
  analyst: 'claude-opus-5-5',
  judge: 'claude-sonnet-5-5',
  analyst_effort: 'high',
  judge_effort: 'low',
} as const satisfies Settings['models'];

/** USD per million tokens, §3.3. `claude-opus-4-8` is the server-side fallback model. */
export const PRICES_FALLBACK: Record<string, ModelPrices> = {
  'claude-haiku-4-5': { input: 1.0, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2.0, output: 5.0 },
  'claude-sonnet-5-5': { input: 2.0, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4.0, output: 10.0 },
  'claude-opus-5-5': { input: 4.0, cache_read: 0.2, cache_write_5m: 5.0, cache_write_1h: 8.0, output: 20.0 },
  'claude-opus-4-8': { input: 5.0, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10.0, output: 25.0 },
};

export const DEFAULT_SETTINGS: Settings = {
  schema: 1,
  paused: false,
  pause_message: '',
  daily_budget_usd: 25,
  refine_budget_share: 0.4,
  hard_stop_multiplier: 1.15,
  est_submission_cost_usd: 0.2,
  max_submissions_per_hour: 20,
  max_text_chars: MAX_TEXT_CHARS,
  min_text_chars: MIN_TEXT_CHARS,
  models: { ...MODELS },
  prompts: { gate: 'gate.v1', analyst: 'analyst.v1', judge: 'judge.v1', schema: SCHEMA_VERSION, taxonomy: TAXONOMY_VERSION },
  prices_usd_per_mtok: structuredClonePrices(PRICES_FALLBACK),
  rating: {
    rd_initial: 350,
    rd_initial_with_prior: 250,
    rd_initial_domain: 220,
    rd_floor: 50,
    rd_ceiling: 350,
    rd_inflation_c: 6,
    rd_revision_min: 180,
    placement_rounds_general: [3, 3, 2],
    placement_rounds_domain: [3, 3],
    revision_rounds_general: [3, 2],
    revision_rounds_domain: [3],
    category_relevance_min: 0.35,
    opponent_mix: { local: 0.7, crosscheck: 0.2, anchor: 0.1 },
    drift_mode: 'anchors',
    drift_max_shift: 10,
    drift_alert_residual: 0.08,
    drift_min_games: 150,
    max_placements_per_run: 25,
    max_refine_matches_per_run: 120,
    min_refine_batch: 12,
    max_deferred_analyses_per_run: 6,
    refine_cooldown_hours: 6,
    judge_concurrency: 8,
    soft_wall_clock_minutes: 35,
    priority_weights: { U: 3.0, S: 1.0, T: 1.5, A: 0.0, V: 0.75, J: 0.25 },
    est_cost_per_match_usd: 0.0165,
  },
  retention: { arena_pool_size: 80, history_points: 60, history_recent: 10, min_deploy_interval_minutes: 6 },
};

function structuredClonePrices(p: Record<string, ModelPrices>): Record<string, ModelPrices> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v }]));
}
