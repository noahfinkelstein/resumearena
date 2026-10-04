// D-54: no shift below 150 anchor games or within 2 SE; a shift writes `d` points and an audit line.
import { describe, expect, it } from 'vitest';
import { RatingsFileZ, expected, type HistoryDoc, type MatchLine } from '@resumearena/shared';
import { driftReport } from '../src/rank/anchors.ts';
import { maintenanceCommand, type AuditDoc } from '../src/commands/maintenance.ts';
import { runRerank } from '../src/commands/rerank.ts';
import { historyPath, ratingsPath } from '../src/store/paths.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

function anchorLines(n: number, popWinRate: number, at: string): MatchLine[] {
  const out: MatchLine[] = [];
  for (let i = 0; i < n; i++) {
    const popWins = i / n < popWinRate;
    const user = idFor(i % 50, 'drift');
    out.push({
      v: 1, id: `id${String(i).padStart(14, '0')}`, run: 'x', wave: 1, seq: i, at, cat: 'general', kind: 'anchor', period: `p${i}`, subj: user,
      a: user < 'anchrggaaa' ? user : 'anchrggaaa', b: user < 'anchrggaaa' ? 'anchrggaaa' : user,
      pre: user < 'anchrggaaa' ? { ar: 1500, ard: 100, br: 1500, brd: 30 } : { ar: 1500, ard: 30, br: 1500, brd: 100 },
      p1: { winner: 'first', confidence: 0.7, factors: ['x'], reasoning: 'x' }, p2: { winner: 'second', confidence: 0.7, factors: ['x'], reasoning: 'x' },
      o: (user < 'anchrggaaa') === popWins ? 1 : 0, agree: true, model: 'm', pv: 'judge.v1+00000000', tok: { in: 1, cr: 0, cw: 0, out: 1 }, usd: 0.001,
    });
  }
  return out;
}

describe('drift guard', () => {
  it('needs 150 games and a residual beyond two standard errors; shift is clamped to ±10', () => {
    const opts = { minGames: 150, maxShift: 10 };
    const few = driftReport(anchorLines(100, 0.9, FROZEN_NOW), opts);
    expect(few.n).toBe(100);
    expect(few.shift).toBe(0);
    const e = expected(1500, 1500, 30);
    const balanced = driftReport(anchorLines(200, e, FROZEN_NOW), opts);
    expect(Math.abs(balanced.res)).toBeLessThan(2 * balanced.se + 1e-9);
    expect(balanced.shift).toBe(0);
    const skewed = driftReport(anchorLines(200, 0.9, FROZEN_NOW), opts);
    expect(skewed.res).toBeGreaterThan(0.3);
    expect(skewed.shift).toBe(10);
    const slight = driftReport(anchorLines(200, 0.52, FROZEN_NOW), opts);
    expect(slight.shift).toBe(0);
  });

  it('nightly applies the shift to every unlocked row with a d history point and records the audit', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100 } } });
    await seedResumes(h.store, Array.from({ length: 4 }, (_, i) => ({ id: idFor(i, 'drift'), ownerHash: ownerFor(i), scores: { general: 60 + i }, queuedAt: FROZEN_NOW })));
    await runRerank(h.ctx, { judge: createSyntheticJudge({ strength: strengthFromId('d'), seed: 'd' }) });
    const before = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    // Append 200 anchor lines where the population side keeps winning; they are already past the cursor.
    const lines = anchorLines(200, 0.95, h.clock.iso());
    await h.store.appendLines('matches/general/2026-10.jsonl', lines.map((l) => JSON.stringify(l)));
    const file = { ...before, cursor: { ...before.cursor, 'matches/general/2026-10.jsonl': (before.cursor['matches/general/2026-10.jsonl'] ?? 0) + lines.length } };
    await h.store.writeJson(ratingsPath('general'), file);
    h.clock.set('2026-10-04T04:17:00Z');
    const r = await maintenanceCommand(h.fork({ runId: 'nightly-1' }), 'nightly', {});
    const drift = (r.report.drift as Record<string, { shift: number; n: number }>).general!;
    expect(drift.n).toBeGreaterThanOrEqual(200);
    expect(drift.shift).toBe(10);
    const after = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    expect(after.shift).toBe(10);
    for (const id of Object.keys(before.rows)) {
      const was = before.rows[id]!;
      const now = after.rows[id]!;
      if (was.kind === 'anchor') expect(now.r).toBe(was.r);
      else expect(now.r).toBeCloseTo((was.r as number) + 10, 6);
    }
    const userId = idFor(0, 'drift');
    const hist = (await h.store.readJson<HistoryDoc>(historyPath('general', userId)))!;
    expect(hist.points[hist.points.length - 1]?.[3]).toBe('d');
    const audit = (await h.store.readJson<AuditDoc>('audits/2026-10-04.json'))!;
    expect(audit.drift.general?.shift).toBe(10);
    expect(after.rows[userId]!.days.length).toBe(1);
  });
});
