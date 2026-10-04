import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, costOf, runsLeft } from '@resumearena/shared';
import { createLedger, usageLine } from '../src/rank/budget.ts';
import { createGithub } from '../src/github/api.ts';
import { submissionsLastHour } from '../src/github/runs.ts';
import { createHarness, testEnv } from './helpers/harness.ts';
import { submitCommand } from '../src/commands/submit.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const line = (purpose: 'gate' | 'analysis' | 'judge_place' | 'judge_refine', usd: number) => usageLine({ at: '2026-10-03T10:00:00Z', run: 'r', wf: 'rerank', purpose, model: 'claude-sonnet-5-5', tok: { in: 1, cr: 0, cw: 0, out: 1 }, usd, ref: 'x' });

describe('budget math', () => {
  it('runs_left follows D-49 regardless of cadence', () => {
    expect(runsLeft(new Date('2026-10-03T23:55:00Z'))).toBe(1);
    expect(runsLeft(new Date('2026-10-03T23:59:59Z'))).toBe(1);
    expect(runsLeft(new Date('2026-10-03T00:00:00Z'))).toBe(144);
    expect(runsLeft(new Date('2026-10-03T12:00:00Z'))).toBe(72);
    expect(runsLeft(new Date('2026-10-03T12:00:01Z'))).toBe(72);
  });

  it('allowance, placement and hard stop read the same ledger', () => {
    const settings = { ...DEFAULT_SETTINGS, daily_budget_usd: 25 };
    const ledger = createLedger(settings, '2026-10-03', [line('analysis', 3.9), line('judge_refine', 1.9), line('judge_place', 1.32)]);
    expect(ledger.spentToday()).toBeCloseTo(7.12, 6);
    expect(ledger.analysisToday()).toBeCloseTo(3.9, 6);
    expect(ledger.refineToday()).toBeCloseTo(1.9, 6);
    // (25 × 0.4 − 1.9) / 0.0165 / 72 = 6.8 → 6, below min_refine_batch
    expect(ledger.allowance(new Date('2026-10-03T12:00:00Z'))).toBe(6);
    expect(ledger.allowance(new Date('2026-10-03T23:50:00Z'))).toBe(120);
    expect(ledger.placementAllowed()).toBe(true);
    expect(ledger.hardStop()).toBe(false);
    ledger.record(line('judge_place', 25));
    expect(ledger.placementAllowed()).toBe(false);
    expect(ledger.hardStop()).toBe(true);
    expect(ledger.pendingUsd()).toBe(25);
  });

  it('cache writes are priced by TTL through costOf', () => {
    const usd = costOf({ input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }, 'claude-sonnet-5-5', DEFAULT_SETTINGS.prices_usd_per_mtok);
    expect(usd).toBeCloseTo((1000 * 2 + 1000 * 4) / 1e6, 9);
  });
});

describe('hourly cap', () => {
  it('counts submit runs through a stubbed runs API and skips the count when disabled', async () => {
    const env = testEnv({ raEnv: 'production', githubToken: 'tok' });
    const calls: string[] = [];
    const gh = createGithub(env, {
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ total_count: 21 }), text: async () => JSON.stringify({ total_count: 21 }) };
      },
    });
    expect(await submissionsLastHour(gh, new Date('2026-10-03T12:00:00Z'))).toBe(21);
    expect(calls[0]).toContain('/actions/workflows/submit.yml/runs?created=');
    expect(calls[0]).toContain(encodeURIComponent('>=2026-10-03T11:00:00Z'));
    const off = createGithub(testEnv(), { fetch: async () => { throw new Error('must not be called'); } });
    expect(await submissionsLastHour(off, new Date())).toBeNull();
  });

  it('submit writes nothing and exits 0 when over the cap', async () => {
    const env = testEnv({ raEnv: 'production', githubToken: 'tok' });
    const gh = createGithub(env, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ total_count: 99 }), text: async () => '{"total_count":99}' }) });
    const h = await createHarness({ context: { github: gh } });
    const before = h.store.snapshot();
    const path = join(tmpdir(), `ra-payload-${Date.now()}.json`);
    const { payload } = await (async () => {
      const entry = h.plan.find((e) => e.slug === 'anchor-tech-1500-mid-senior-eng-b-tier-saas')!;
      const { loadFixture, payloadForFixture } = await import('../src/commands/fixtures.ts');
      const f = await loadFixture(env.fixturesDir, entry);
      return payloadForFixture(f, 'test');
    })();
    await writeFile(path, JSON.stringify(payload));
    const r = await submitCommand(h.ctx, { payload: path });
    expect(r.outcome).toBe('rate_limited');
    expect(r.exitCode).toBe(0);
    expect(h.store.snapshot()).toEqual(before);
  });
});
