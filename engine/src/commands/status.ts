// `status`: print status.json plus today's budget arithmetic.
import { runsLeft } from '@resumearena/shared';
import type { Context } from '../context.ts';
import { openLedger } from '../rank/budget.ts';
import { loadSettings, loadStatus } from '../settings.ts';

export async function statusCommand(ctx: Context): Promise<string> {
  const settings = await loadSettings(ctx.store);
  const status = await loadStatus(ctx.store, ctx.clock.iso(), settings);
  const ledger = await openLedger(ctx.store, settings, ctx.clock.day());
  const now = ctx.clock.now();
  const budget = {
    day: ledger.day,
    spent_usd: ledger.spentToday(),
    analysis_usd: ledger.analysisToday(),
    refine_spent_usd: ledger.refineToday(),
    daily_budget_usd: settings.daily_budget_usd,
    runs_left: runsLeft(now),
    refine_allowance: ledger.allowance(now),
    placement_allowed: ledger.placementAllowed(),
    hard_stop: ledger.hardStop(),
  };
  return `${JSON.stringify({ status, budget }, null, 2)}\n`;
}
