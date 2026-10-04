// ranking-engine.md §7.4: 100 tickets, fixed judge usage; exact match count, exact ledger, one anchor per
// resume per category, no pair repeats inside a placement.
import { describe, expect, it } from 'vitest';
import { PRICES_FALLBACK, costOf, type MatchLine } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { parseUsageLines } from '../src/rank/budget.ts';
import { createSyntheticJudge, FIXED_USAGE, SIM_MODEL, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes, type SeedSpec } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

describe('placement-cost', () => {
  it('100 tickets: matches = 100 × 8 + Σ domains × 6, ledger exact, one anchor each, no repeats', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100, max_refine_matches_per_run: 0 } } });
    const specs: SeedSpec[] = [];
    let domains = 0;
    for (let i = 0; i < 100; i++) {
      const scores: SeedSpec['scores'] = { general: 30 + (i % 60) };
      const first = (['tech', 'finance', 'academia'] as const)[i % 3]!;
      scores[first] = 40 + (i % 50);
      domains++;
      if (i % 10 < 3) {
        const second = (['finance', 'academia', 'tech'] as const)[i % 3]!;
        scores[second] = 45 + (i % 40);
        domains++;
      }
      specs.push({ id: idFor(i, 'cost'), ownerHash: ownerFor(i), scores, queuedAt: FROZEN_NOW, stage: (['student', 'early', 'mid', 'senior'] as const)[i % 4]! });
    }
    await seedResumes(h.store, specs);
    const judge = createSyntheticJudge({ strength: strengthFromId('cost'), seed: 'cost' });
    const r = await runRerank(h.ctx, { judge });
    expect(r.state).toBe('ok');
    expect(r.ingested).toBe(100);
    const expectedMatches = 100 * 8 + domains * 6;
    expect(r.matches).toBe(expectedMatches);

    const usage = parseUsageLines(await h.store.readLines('usage/2026-10-03.jsonl'));
    const judgePlace = usage.filter((l) => l.purpose === 'judge_place').reduce((a, l) => a + l.usd, 0);
    expect(usage.every((l) => l.purpose === 'judge_place')).toBe(true);
    expect(Math.abs(judgePlace - expectedMatches * 2 * costOf(FIXED_USAGE, SIM_MODEL, PRICES_FALLBACK))).toBeLessThan(1e-9);

    const lines: MatchLine[] = [];
    for (const cat of ['general', 'tech', 'finance', 'academia'] as const) for (const l of await h.store.readLines(`matches/${cat}/2026-10.jsonl`)) lines.push(JSON.parse(l) as MatchLine);
    expect(lines.length).toBe(expectedMatches);
    for (const s of specs) {
      for (const cat of Object.keys(s.scores) as (keyof typeof s.scores)[]) {
        const own = lines.filter((l) => l.cat === cat && l.subj === s.id);
        expect(own.length).toBe(cat === 'general' ? 8 : 6);
        expect(own.filter((l) => l.a.startsWith('anchr') || l.b.startsWith('anchr')).length).toBe(1);
        const opps = own.map((l) => (l.a === s.id ? l.b : l.a));
        expect(new Set(opps).size).toBe(opps.length);
      }
    }
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  }, 120_000);
});
