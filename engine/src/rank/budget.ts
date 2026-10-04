// The spend ledger is usage/<day>.jsonl (D-23); this is the in-memory view of today plus this run's lines.
import { hardStop, placementAllowed, refineAllowance, runsLeft, type Settings, type SpendPurpose, type TokenCounts, type UsageLine } from '@resumearena/shared';
import type { Store } from '../store/store.ts';
import { usagePath } from '../store/paths.ts';

export interface Ledger {
  readonly day: string;
  /** Lines already on disk for today. */
  readonly existing: UsageLine[];
  /** Lines recorded by this run, appended at commit time. */
  readonly pending: UsageLine[];
  /** Lines this run already wrote to disk in an earlier commit (a drained analysis): counted, never re-appended. */
  readonly observed: UsageLine[];
  record(line: UsageLine): void;
  observe(line: UsageLine): void;
  spentToday(): number;
  spentToday(purposes: readonly SpendPurpose[]): number;
  analysisToday(): number;
  refineToday(): number;
  allowance(now: Date): number;
  placementAllowed(): boolean;
  hardStop(): boolean;
  /** Spend of the pending lines only (this run). */
  pendingUsd(): number;
  /** Spend of every line this run produced, pending or already on disk. */
  runUsd(): number;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function parseUsageLines(lines: readonly string[]): UsageLine[] {
  const out: UsageLine[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l) as UsageLine;
      if (typeof v.usd === 'number') out.push(v);
    } catch {
      // A torn line from a union merge is ignored rather than failing the run.
    }
  }
  return out;
}

export function createLedger(settings: Settings, day: string, existing: UsageLine[]): Ledger {
  const pending: UsageLine[] = [];
  const observed: UsageLine[] = [];
  const sum = (lines: readonly UsageLine[], purposes?: readonly SpendPurpose[]): number => round6(lines.reduce((a, l) => (purposes && !purposes.includes(l.purpose) ? a : a + l.usd), 0));
  const spent = (purposes?: readonly SpendPurpose[]): number => round6(sum(existing, purposes) + sum(pending, purposes) + sum(observed, purposes));
  return {
    day,
    existing,
    pending,
    observed,
    record: (line) => {
      pending.push(line);
    },
    observe: (line) => {
      observed.push(line);
    },
    spentToday: ((purposes?: readonly SpendPurpose[]) => spent(purposes)) as Ledger['spentToday'],
    analysisToday: () => spent(['gate', 'analysis', 'reanalysis']),
    refineToday: () => spent(['judge_refine']),
    allowance: (now) =>
      refineAllowance({
        dailyBudgetUsd: settings.daily_budget_usd,
        refineBudgetShare: settings.refine_budget_share,
        refineSpentTodayUsd: spent(['judge_refine']),
        estCostPerMatchUsd: settings.rating.est_cost_per_match_usd,
        maxRefineMatchesPerRun: settings.rating.max_refine_matches_per_run,
        runsLeft: runsLeft(now),
      }),
    placementAllowed: () => placementAllowed(spent(), settings.daily_budget_usd),
    hardStop: () => hardStop(spent(), settings.daily_budget_usd, settings.hard_stop_multiplier),
    pendingUsd: () => sum(pending),
    runUsd: () => round6(sum(pending) + sum(observed)),
  };
}

export async function openLedger(store: Store, settings: Settings, day: string): Promise<Ledger> {
  const path = usagePath(day);
  await store.materialize([path]);
  return createLedger(settings, day, parseUsageLines(await store.readLines(path)));
}

export function usageLine(input: { at: string; run: string; wf: UsageLine['wf']; purpose: SpendPurpose; model: string; tok: TokenCounts; usd: number; ref: string }): UsageLine {
  return { t: input.at, run: input.run, wf: input.wf, purpose: input.purpose, model: input.model, in: input.tok.in, cr: input.tok.cr, cw: input.tok.cw, out: input.tok.out, usd: round6(input.usd), ref: input.ref };
}
