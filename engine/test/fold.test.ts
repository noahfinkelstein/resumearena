// The fold accumulates a shared opponent's games within one wave (F04); a wave materializes its history
// docs in a batch (F09); a resubmission materializes only the superseded entry's dedupe shards (F10).
import { describe, expect, it } from 'vitest';
import { glickoUpdate, type MatchLine, type Verdict } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { applyLines } from '../src/rank/fold.ts';
import { loadState, newGeneralRow } from '../src/rank/state.ts';
import { loadSettings, loadStatus } from '../src/settings.ts';
import { submitPaths } from '../src/submit/writes.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

const verdict = (winner: 'first' | 'second'): Verdict => ({ winner, confidence: 0.7, factors: [`${winner}: stronger`], reasoning: 'scripted' });

describe('fold: one opponent in several periods of one wave', () => {
  it('chains the opponent through all three games instead of keeping only the last', async () => {
    const h = await createHarness({ anchors: false });
    const now = h.clock.iso();
    const settings = await loadSettings(h.store);
    const state = await loadState(h.store, { settings, status: await loadStatus(h.store, now, settings), runId: 'test-1', now });
    const cs = state.cats.general;
    const opp = newGeneralRow('oppoppoppo', 'f'.repeat(64), 60, settings, now);
    opp.r = 1500;
    opp.rd = 60;
    opp.placed = true;
    opp.round = 3;
    cs.rows.set(opp.id, opp);
    const subjects = ['subjaaaaaa', 'subjbbbbbb', 'subjcccccc'].map((id, i) => {
      const row = newGeneralRow(id, ownerFor(i + 1), 75, settings, now);
      row.r = 1400;
      row.rd = 250;
      cs.rows.set(id, row);
      return row;
    });
    // Three placement periods planned together: every line carries the opponent's plan-time 1500/60.
    const lines: MatchLine[] = subjects.map((s, i) => ({
      v: 1, id: `m${i}`.padEnd(16, '0'), run: 'run-x', wave: 1, seq: i, at: now, cat: 'general', kind: 'placement', period: `${s.id}:general:r0`, subj: s.id,
      a: opp.id, b: s.id, pre: { ar: 1500, ard: 60, br: 1400, brd: 250 }, p1: verdict('first'), p2: verdict('second'), o: 1, agree: true,
      model: 'claude-sonnet-5-5', pv: 'judge.v1+test', tok: { in: 1, cr: 0, cw: 0, out: 1 }, usd: 0.001,
    }));
    await applyLines(state, lines);

    let chained = { r: 1500, rd: 60 };
    for (let i = 0; i < 3; i++) chained = glickoUpdate(chained.r, chained.rd, [{ oppR: 1400, oppRd: 250, score: 1 }], settings.rating.rd_floor);
    const overwrite = glickoUpdate(1500, 60, [{ oppR: 1400, oppRd: 250, score: 1 }], settings.rating.rd_floor);
    expect(opp.r).toBeCloseTo(chained.r, 2);
    expect(opp.rd).toBeCloseTo(chained.rd, 2);
    expect(opp.r).not.toBeCloseTo(overwrite.r, 1);
    expect(opp.g).toBe(3);
    expect(opp.w).toBe(3);
    // Each subject's own period still starts from the line's pre values.
    for (const s of subjects) {
      const expected = glickoUpdate(1400, 250, [{ oppR: 1500, oppRd: 60, score: 0 }], settings.rating.rd_floor);
      expect(s.r).toBeCloseTo(expected.r, 2);
      expect(s.round).toBe(1);
    }
  });
});

describe('sparse materialization', () => {
  it('a placement run adds history docs in batches, not one git call per document', async () => {
    const h = await createHarness({ settings: { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100 } } });
    await seedResumes(h.store, Array.from({ length: 12 }, (_, i) => ({ id: idFor(i, 'mat'), ownerHash: ownerFor(i), scores: { general: 40 + i * 4, tech: 55 + i }, queuedAt: FROZEN_NOW })));
    const calls: string[][] = [];
    const orig = h.store.materialize;
    h.store.materialize = async (patterns) => {
      calls.push([...patterns]);
      return orig.call(h.store, patterns);
    };
    const judge = createSyntheticJudge({ strength: strengthFromId('mat'), seed: 'mat' });
    const r = await runRerank(h.ctx, { judge, trigger: 't' });
    expect(r.matches).toBeGreaterThan(50);
    const historyCalls = calls.filter((c) => c.some((p) => p.includes('history/')));
    const docsTouched = new Set(historyCalls.flatMap((c) => c.filter((p) => p.includes('history/')))).size;
    expect(docsTouched).toBeGreaterThan(12);
    // At most one batch per category per wave (5 waves + refinement), far below one call per doc.
    expect(historyCalls.length).toBeLessThanOrEqual(24);
    expect(historyCalls.length).toBeLessThan(docsTouched);
  });

  it('a resubmission names the superseded entry\'s dedupe shards instead of the whole dedupe tree', () => {
    const input = {
      action: 'submit' as const, id: 'abcdefghij', handle: 'someone', owner_hash: 'a'.repeat(64), owner_key: 'b'.repeat(52), visibility: 'anonymous' as const,
      text: 'x', text_sha256: 'cd'.padEnd(64, '0'), metrics: { source: 'paste' as const, pages: 0, columns_detected: 0 as const, font_count: 0, image_count: 0, char_count: 0, word_count: 0, extraction_quality: 0, redactions: { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 } },
      ladder_hint: 'general' as const, source: { kind: 'dispatch' as const, run_id: 1, issue_number: null, client_version: '' },
    };
    const paths = submitPaths(input, { day: '2026-10-03', cardSha256: 'ef'.padEnd(64, '0'), supersedes: 'oldoldoldo', oldDoc: { text_sha256: '12'.padEnd(64, '0'), card_sha256: '34'.padEnd(64, '0') } });
    expect(paths).toContain('/dedupe/text/12/');
    expect(paths).toContain('/dedupe/card/34/');
    expect(paths).toContain('/dedupe/text/cd/');
    expect(paths).toContain('/dedupe/card/ef/');
    expect(paths).toContain('/resumes/ol/oldoldoldo.json');
    expect(paths).not.toContain('/dedupe/');
    expect(paths.some((p) => p === '/dedupe/text/' || p === '/dedupe/card/')).toBe(false);
  });
});
