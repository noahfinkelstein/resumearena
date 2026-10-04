import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@resumearena/shared';
import { computeAlerts, deployDecision } from '../src/status.ts';
import { emptyStatus } from '../src/settings.ts';

const now = '2026-10-03T12:00:00Z';

describe('status alerts (D-63)', () => {
  it('fires each rule at its threshold and not below', () => {
    const s = emptyStatus(now, DEFAULT_SETTINGS);
    expect(computeAlerts(s, { now })).toEqual([]);
    s.health.judge_healthy = false;
    s.per_category.tech.disagreement_rate_7d = 0.41;
    s.per_category.finance.disagreement_rate_7d = 0.4;
    s.per_category.general.anchor_accuracy_7d = 0.84;
    s.per_category.general.anchor_n_7d = 40;
    s.per_category.academia.anchor_accuracy_7d = 0.5;
    s.per_category.academia.anchor_n_7d = 39;
    s.health.cancelled_runs_24h = 11;
    s.health.failed_runs_24h = 6;
    s.health.token_expires = '2026-10-17';
    s.health.schedule_enabled = false;
    s.budget.hard_stopped = true;
    expect(computeAlerts(s, { now, extra: ['drift_persistent:tech'] })).toEqual([
      'judge_unavailable',
      'anchor_accuracy_low:general',
      'disagreement_high:tech',
      'drift_persistent:tech',
      'cancelled_runs_high',
      'failed_runs_high',
      'token_expiring',
      'schedule_disabled',
      'budget_hard_stop',
    ]);
    s.health.token_expires = '2026-10-18';
    s.health.cancelled_runs_24h = 10;
    s.health.failed_runs_24h = 5;
    const alerts = computeAlerts(s, { now });
    expect(alerts).not.toContain('token_expiring');
    expect(alerts).not.toContain('cancelled_runs_high');
    expect(alerts).not.toContain('failed_runs_high');
  });

  it('deploy decision honours the minimum interval and never loses a pending deploy (D-20)', () => {
    const prev = emptyStatus(now, DEFAULT_SETTINGS);
    expect(deployDecision(prev, false, now, 6)).toEqual({ deploy: false, last_deploy_requested_at: null, deploy_pending: false });
    expect(deployDecision(prev, true, now, 6)).toEqual({ deploy: true, last_deploy_requested_at: now, deploy_pending: false });
    const recent = { ...prev, last_deploy_requested_at: '2026-10-03T11:57:00Z' };
    expect(deployDecision(recent, true, now, 6)).toEqual({ deploy: false, last_deploy_requested_at: '2026-10-03T11:57:00Z', deploy_pending: true });
    const pending = { ...recent, deploy_pending: true };
    expect(deployDecision(pending, false, now, 6).deploy).toBe(true);
    const old = { ...prev, last_deploy_requested_at: '2026-10-03T11:50:00Z' };
    expect(deployDecision(old, true, now, 6).deploy).toBe(true);
  });
});
