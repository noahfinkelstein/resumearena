// status.json assembly (§3.3, D-18, D-63): budget from the ledger, queue depths, counts, per-category
// statistics and health, plus the alert rules.
import { CATEGORIES, ENGINE_VERSION, isBoardRow, type Category, type CategoryStats, type Settings, type Status } from '@resumearena/shared';
import { addDays, daysBetween, parseIso } from './clock.ts';
import type { Ledger } from './rank/budget.ts';
import type { CatState } from './rank/state.ts';
import type { PromptSet } from './llm/prompts.ts';
import type { JudgeHealth } from './rank/anchors.ts';

export const ALERT_RULES = {
  disagreementHigh: 0.4,
  anchorAccuracyLow: 0.85,
  anchorAccuracyMinN: 40,
  cancelledRunsHigh: 10,
  failedRunsHigh: 5,
  tokenExpiringDays: 14,
} as const;

export function categoryStats(cs: CatState, prev: CategoryStats, health?: JudgeHealth): CategoryStats {
  const board: number[] = [];
  for (const row of cs.rows.values()) if (isBoardRow(row)) board.push(row.r as number);
  const n = board.length;
  const mean = n ? board.reduce((a, b) => a + b, 0) / n : 1500;
  const sd = n > 1 ? Math.sqrt(board.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    rated: n,
    mean: Math.round(mean),
    sd: Math.round(sd),
    anchor_residual_7d: health ? prev.anchor_residual_7d : prev.anchor_residual_7d,
    anchor_n_7d: health ? health.anchor_n_7d : prev.anchor_n_7d,
    anchor_accuracy_7d: health ? health.anchor_accuracy_7d : prev.anchor_accuracy_7d,
    disagreement_rate_7d: health ? health.disagreement_rate_7d : prev.disagreement_rate_7d,
  };
}

export interface StatusInputs {
  prev: Status;
  settings: Settings;
  now: string;
  ledger: Ledger;
  cats: Record<Category, CatState>;
  queue: { placement: number; analysis: number; delete: number; oldest_queued_at: string | null };
  prompts: PromptSet;
  lastRerank?: Status['last_rerank'];
  health?: Partial<Status['health']>;
  counts?: Partial<Status['counts']>;
  perCategoryHealth?: Partial<Record<Category, JudgeHealth>>;
  perCategoryResidual?: Partial<Record<Category, number | null>>;
  lastDeployRequestedAt?: string | null;
  deployPending?: boolean;
  lastSubmissionAt?: string | null;
  extraAlerts?: string[];
}

export function buildStatus(i: StatusInputs): Status {
  const spent = i.ledger.spentToday();
  const perCategory = {} as Status['per_category'];
  let rated = 0;
  let placing = 0;
  let anchors = 0;
  for (const cat of CATEGORIES) {
    const cs = i.cats[cat];
    const stats = categoryStats(cs, i.prev.per_category[cat], i.perCategoryHealth?.[cat]);
    if (i.perCategoryResidual && cat in i.perCategoryResidual) stats.anchor_residual_7d = i.perCategoryResidual[cat] ?? null;
    perCategory[cat] = stats;
    rated += stats.rated;
    for (const row of cs.rows.values()) {
      if (row.kind === 'anchor') anchors++;
      else if (row.elig && !row.placed && row.round >= 0 && cat === 'general') placing++;
    }
  }
  let matches = 0;
  for (const cat of CATEGORIES) for (const n of Object.values(i.cats[cat].cursor)) matches += n;

  const health: Status['health'] = { ...i.prev.health, ...i.health, alerts: [] };
  const status: Status = {
    schema: 1,
    updated_at: i.now,
    paused: i.settings.paused,
    budget: {
      day: i.ledger.day,
      daily_usd: i.settings.daily_budget_usd,
      spent_usd: spent,
      analysis_usd: i.ledger.analysisToday(),
      refine_spent_usd: i.ledger.refineToday(),
      exhausted: !i.ledger.placementAllowed(),
      hard_stopped: i.ledger.hardStop(),
    },
    queue: i.queue,
    last_rerank: i.lastRerank === undefined ? i.prev.last_rerank : i.lastRerank,
    last_submission_at: i.lastSubmissionAt === undefined ? i.prev.last_submission_at : i.lastSubmissionAt,
    last_deploy_requested_at: i.lastDeployRequestedAt === undefined ? i.prev.last_deploy_requested_at : i.lastDeployRequestedAt,
    deploy_pending: i.deployPending === undefined ? i.prev.deploy_pending : i.deployPending,
    counts: { ...i.prev.counts, ...i.counts, rated, placing, matches, anchors, queued: i.counts?.queued ?? i.queue.analysis },
    per_category: perCategory,
    health,
    versions: {
      engine: ENGINE_VERSION,
      gate_prompt: i.prompts.gate.version,
      analyst_prompt: i.prompts.analyst.version,
      judge_prompt: i.prompts.judge.version,
      schema: i.settings.prompts.schema,
      taxonomy: i.settings.prompts.taxonomy,
    },
  };
  status.health.alerts = computeAlerts(status, { now: i.now, extra: i.extraAlerts ?? [] });
  return status;
}

/** D-63 alert list, deterministic order. */
export function computeAlerts(status: Status, opts: { now: string; extra?: string[] }): string[] {
  const alerts: string[] = [];
  if (!status.health.judge_healthy) alerts.push('judge_unavailable');
  for (const cat of CATEGORIES) {
    const s = status.per_category[cat];
    if (s.disagreement_rate_7d !== null && s.disagreement_rate_7d > ALERT_RULES.disagreementHigh) alerts.push(`disagreement_high:${cat}`);
    if (s.anchor_accuracy_7d !== null && s.anchor_n_7d >= ALERT_RULES.anchorAccuracyMinN && s.anchor_accuracy_7d < ALERT_RULES.anchorAccuracyLow) alerts.push(`anchor_accuracy_low:${cat}`);
  }
  for (const a of opts.extra ?? []) if (!alerts.includes(a)) alerts.push(a);
  if (status.health.cancelled_runs_24h > ALERT_RULES.cancelledRunsHigh) alerts.push('cancelled_runs_high');
  if (status.health.failed_runs_24h > ALERT_RULES.failedRunsHigh) alerts.push('failed_runs_high');
  if (status.health.token_expires) {
    const days = (parseIso(`${status.health.token_expires}T00:00:00Z`).getTime() - parseIso(opts.now).getTime()) / 86_400_000;
    if (days <= ALERT_RULES.tokenExpiringDays) alerts.push('token_expiring');
  }
  if (!status.health.schedule_enabled) alerts.push('schedule_disabled');
  if (status.budget.hard_stopped) alerts.push('budget_hard_stop');
  return alerts;
}

/** D-20: deploy now when the interval passed (or a deploy is owed); otherwise mark it pending. */
export function deployDecision(prev: Status, changed: boolean, now: string, minIntervalMinutes: number): { deploy: boolean; last_deploy_requested_at: string | null; deploy_pending: boolean } {
  if (!changed && !prev.deploy_pending) return { deploy: false, last_deploy_requested_at: prev.last_deploy_requested_at, deploy_pending: false };
  const last = prev.last_deploy_requested_at ? parseIso(prev.last_deploy_requested_at) : null;
  const elapsedMin = last ? daysBetween(last, parseIso(now)) * 1440 : Infinity;
  if (prev.deploy_pending || elapsedMin >= minIntervalMinutes) return { deploy: true, last_deploy_requested_at: now, deploy_pending: false };
  return { deploy: false, last_deploy_requested_at: prev.last_deploy_requested_at, deploy_pending: true };
}

export const tokenExpiryWithin = (expires: string | null, today: string, days: number): boolean => expires !== null && expires <= addDays(today, days);
