// The judge's admission control (F03), the breaker's "finalize what exists" contract (F07) and per-call
// ledgering so the hard stop can trip mid-wave (SEC-06).
import { describe, expect, it } from 'vitest';
import { RatingsFileZ, type Status, type UsageLine } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { Semaphore } from '../src/llm/judge.ts';
import type { LlmRequest } from '../src/llm/client.ts';
import { ratingsPath } from '../src/store/paths.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('judge semaphore', () => {
  it('never admits more than the limit under 100 concurrent acquirers', async () => {
    const sem = new Semaphore(8);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        await sem.acquire();
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        sem.release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    expect(sem.active).toBe(0);
  });

  it('shrinking the limit lowers admission for everything still waiting', async () => {
    const sem = new Semaphore(8);
    let active = 0;
    let done = 0;
    let peakAfterShrink = 0;
    let shrunk = false;
    await Promise.all(
      Array.from({ length: 60 }, async () => {
        await sem.acquire();
        active++;
        if (shrunk) peakAfterShrink = Math.max(peakAfterShrink, active);
        await tick();
        active--;
        done++;
        if (done === 8 && !shrunk) {
          shrunk = true;
          sem.limit = 2;
        }
        sem.release();
      }),
    );
    expect(peakAfterShrink).toBeLessThanOrEqual(2);
    expect(peakAfterShrink).toBeGreaterThan(0);
  });
});

describe('circuit breaker', () => {
  it('keeps the verdicts paid for before the trip: WAL lines, usage lines, aborted_judge', async () => {
    // Matches 0–4 succeed; every later match throws from the transport (an api_error with no retry class).
    const script = (req: LlmRequest): null => {
      if (req.purpose === 'judge' && Number(req.meta?.seq ?? 0) >= 5) throw new Error('scripted outage');
      return null;
    };
    const h = await createHarness({ settings: { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100 } }, mock: { script } });
    await seedResumes(h.store, Array.from({ length: 6 }, (_, i) => ({ id: idFor(i, 'brk'), ownerHash: ownerFor(i), scores: { general: 45 + i * 6 }, queuedAt: FROZEN_NOW })));
    const r = await runRerank(h.ctx, { trigger: 't' });
    expect(r.state).toBe('aborted_judge');
    expect(r.matches).toBe(5);
    const wal = (await h.store.readLines('matches/general/2026-10.jsonl')).filter(Boolean);
    expect(wal).toHaveLength(5);
    const usage = (await h.store.readLines('usage/2026-10-03.jsonl')).filter(Boolean).map((l) => JSON.parse(l) as UsageLine);
    expect(usage.filter((l) => l.purpose === 'judge_place')).toHaveLength(10);
    expect(r.usd).toBeCloseTo(usage.reduce((a, l) => a + l.usd, 0), 6);
    const general = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    expect(Object.values(general.rows).filter((row) => row.kind === 'user').reduce((a, row) => a + row.g, 0)).toBeGreaterThan(0);
    const status = (await h.store.readJson<Status>('status.json'))!;
    expect(status.health.judge_healthy).toBe(false);
    expect(status.last_rerank?.state).toBe('aborted_judge');
  });
});
