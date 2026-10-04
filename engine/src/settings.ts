// settings.json / status.json loading (§3.3). Settings are validated on every load and a bad key fails the run by name.
import { CATEGORIES, DEFAULT_SETTINGS, ENGINE_VERSION, SettingsZ, StatusZ, type CategoryStats, type Settings, type Status } from '@resumearena/shared';
import type { Store } from './store/store.ts';
import { SETTINGS_PATH, STATUS_PATH } from './store/paths.ts';
import type { PromptSet } from './llm/prompts.ts';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export function parseSettings(raw: unknown): Settings {
  const r = SettingsZ.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    const key = first ? first.path.join('.') || '(root)' : '(root)';
    throw new SettingsError(`settings.json invalid at "${key}": ${first?.message ?? 'unknown error'}`);
  }
  return r.data;
}

export async function loadSettings(store: Store): Promise<Settings> {
  const raw = await store.readJson<unknown>(SETTINGS_PATH);
  if (raw === null) throw new SettingsError(`settings.json missing in ${store.root}; run "data init"`);
  return parseSettings(raw);
}

export const emptyCategoryStats = (): CategoryStats => ({ rated: 0, mean: 1500, sd: 0, anchor_residual_7d: null, anchor_n_7d: 0, anchor_accuracy_7d: null, disagreement_rate_7d: null });

export function emptyStatus(now: string, settings: Settings = DEFAULT_SETTINGS, prompts?: PromptSet): Status {
  return {
    schema: 1,
    updated_at: now,
    paused: settings.paused,
    budget: { day: now.slice(0, 10), daily_usd: settings.daily_budget_usd, spent_usd: 0, analysis_usd: 0, refine_spent_usd: 0, exhausted: false, hard_stopped: false },
    queue: { placement: 0, analysis: 0, delete: 0, oldest_queued_at: null },
    last_rerank: null,
    last_submission_at: null,
    last_deploy_requested_at: null,
    deploy_pending: false,
    counts: { resumes: 0, analyzed: 0, rated: 0, placing: 0, queued: 0, held: 0, needs_review: 0, rejected: 0, duplicate: 0, superseded: 0, deleted: 0, users: 0, matches: 0, anchors: 0 },
    per_category: Object.fromEntries(CATEGORIES.map((c) => [c, emptyCategoryStats()])) as Status['per_category'],
    health: { judge_healthy: true, schedule_enabled: true, token_expires: null, submissions_last_hour: 0, failed_runs_24h: 0, cancelled_runs_24h: 0, issue_path_24h: 0, dispatch_path_24h: 0, alerts: [] },
    versions: {
      engine: ENGINE_VERSION,
      gate_prompt: prompts?.gate.version ?? settings.prompts.gate,
      analyst_prompt: prompts?.analyst.version ?? settings.prompts.analyst,
      judge_prompt: prompts?.judge.version ?? settings.prompts.judge,
      schema: settings.prompts.schema,
      taxonomy: settings.prompts.taxonomy,
    },
  };
}

/** A missing or malformed status is replaced by an empty one: it is derived state, never a source of truth. */
export async function loadStatus(store: Store, now: string, settings: Settings): Promise<Status> {
  const raw = await store.readJson<unknown>(STATUS_PATH);
  if (raw === null) return emptyStatus(now, settings);
  const r = StatusZ.safeParse(raw);
  return r.success ? r.data : emptyStatus(now, settings);
}
