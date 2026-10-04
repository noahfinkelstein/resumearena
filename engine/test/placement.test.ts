// Placement planner on a fixture ladder: 8 general games and 6 per domain, with anchors as the fallback.
import { describe, expect, it } from 'vitest';
import { RatingsFileZ, type RatingsFile } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { ratingsPath } from '../src/store/paths.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

const BIG_BUDGET = { daily_budget_usd: 10_000, rating: { max_placements_per_run: 500 } } as const;

async function ratings(h: Awaited<ReturnType<typeof createHarness>>, cat: 'general' | 'tech' | 'finance' | 'academia'): Promise<RatingsFile> {
  return RatingsFileZ.parse(await h.store.readJson(ratingsPath(cat)));
}

describe('placement planner', () => {
  it('places 12 resumes with 8 general and 6 domain games each, one anchor game per category', async () => {
    const h = await createHarness({ settings: BIG_BUDGET });
    const specs = Array.from({ length: 12 }, (_, i) => ({ id: idFor(i), ownerHash: ownerFor(i), scores: { general: 40 + i * 4, tech: 50 + i * 3 }, queuedAt: FROZEN_NOW }));
    await seedResumes(h.store, specs);
    const judge = createSyntheticJudge({ strength: strengthFromId('p'), seed: 'p' });
    const r = await runRerank(h.ctx, { judge });
    expect(r.state).toBe('ok');
    expect(r.ingested).toBe(12);
    const general = await ratings(h, 'general');
    const tech = await ratings(h, 'tech');
    for (const s of specs) {
      const g = general.rows[s.id]!;
      expect(g.placed).toBe(true);
      expect(g.round).toBe(3);
      expect(g.g).toBeGreaterThanOrEqual(8);
      const t = tech.rows[s.id]!;
      expect(t.placed).toBe(true);
      expect(t.round).toBe(2);
      expect(t.g).toBeGreaterThanOrEqual(6);
      expect(t.r).not.toBeNull();
    }
    const lines = (await h.store.readLines('matches/general/2026-10.jsonl')).map((l) => JSON.parse(l) as { subj: string; a: string; b: string; kind: string });
    for (const s of specs) {
      const own = lines.filter((l) => l.subj === s.id && l.kind === 'placement');
      expect(own.length).toBe(8);
      // Game 2 of round 1 is the anchor; in a 12-row ladder D-25's fallback may add more when a subject's pool runs dry.
      const anchorGames = own.filter((l) => l.a.startsWith('anchr') || l.b.startsWith('anchr'));
      expect(anchorGames.length).toBeGreaterThanOrEqual(1);
      const opponents = own.map((l) => (l.a === s.id ? l.b : l.a));
      expect(new Set(opponents).size).toBe(8);
    }
    expect(r.matches).toBe(12 * 8 + 12 * 6);
    expect(r.placed).toBe(24);
  });

  it('falls back to anchors so the first two entrants still get 8 and 6 games (D-25)', async () => {
    const h = await createHarness({ settings: BIG_BUDGET });
    await seedResumes(h.store, [
      { id: idFor(1), ownerHash: ownerFor(1), scores: { general: 60, finance: 55 }, queuedAt: FROZEN_NOW },
      { id: idFor(2), ownerHash: ownerFor(2), scores: { general: 70, finance: 65 }, queuedAt: FROZEN_NOW },
    ]);
    const r = await runRerank(h.ctx, { judge: createSyntheticJudge({ strength: strengthFromId('q'), seed: 'q' }) });
    expect(r.state).toBe('ok');
    const general = await ratings(h, 'general');
    const finance = await ratings(h, 'finance');
    for (const id of [idFor(1), idFor(2)]) {
      expect(general.rows[id]!.g).toBe(8);
      expect(general.rows[id]!.placed).toBe(true);
      expect(finance.rows[id]!.g).toBe(6);
      expect(finance.rows[id]!.placed).toBe(true);
    }
    // Anchors never move but count their games.
    const anchor = Object.values(general.rows).find((x) => x.kind === 'anchor' && x.g > 0)!;
    expect(anchor.r).toBe(anchor.seed);
    expect(anchor.rd).toBe(30);
  });

  it('without an anchors file the anchor slot is an ordinary opponent and placement is still 8 and 6', async () => {
    // No fixed scale to fall back on, so the ladder needs enough rows for six distinct opponents each (D-25 covers tiny ladders).
    const h = await createHarness({ settings: BIG_BUDGET, anchors: false });
    const specs = Array.from({ length: 30 }, (_, i) => ({ id: idFor(i, 'x'), ownerHash: ownerFor(i), scores: { general: 30 + i * 2, academia: 40 + i }, queuedAt: FROZEN_NOW }));
    await seedResumes(h.store, specs);
    const r = await runRerank(h.ctx, { judge: createSyntheticJudge({ strength: strengthFromId('r'), seed: 'r' }) });
    expect(r.state).toBe('ok');
    const general = await ratings(h, 'general');
    const academia = await ratings(h, 'academia');
    for (const s of specs) {
      expect(general.rows[s.id]!.placed).toBe(true);
      expect(academia.rows[s.id]!.placed).toBe(true);
    }
    const lines = (await h.store.readLines('matches/general/2026-10.jsonl')).map((l) => JSON.parse(l) as { subj: string; a: string; b: string });
    for (const s of specs) expect(lines.filter((l) => l.subj === s.id).length).toBe(8);
    expect(lines.some((l) => l.a.startsWith('anchr') || l.b.startsWith('anchr'))).toBe(false);
  });

  it('a half-placed row continues in the next run and leftover rounds never strand it', async () => {
    const h = await createHarness({ settings: BIG_BUDGET });
    await seedResumes(h.store, Array.from({ length: 6 }, (_, i) => ({ id: idFor(i, 'y'), ownerHash: ownerFor(i), scores: { general: 50 + i, tech: 60 }, queuedAt: FROZEN_NOW })));
    const judge = createSyntheticJudge({ strength: strengthFromId('s'), seed: 's' });
    const first = await runRerank(h.ctx, { judge, maxWaves: 2 });
    expect(first.state).toBe('ok');
    const mid = await ratings(h, 'general');
    expect(Object.values(mid.rows).filter((x) => x.kind === 'user').every((x) => x.round === 2 && !x.placed)).toBe(true);
    const second = await runRerank(h.fork({ runId: 'test-2' }), { judge });
    expect(second.state).toBe('ok');
    const done = await ratings(h, 'general');
    expect(Object.values(done.rows).filter((x) => x.kind === 'user').every((x) => x.placed && x.round === 3 && x.g >= 8)).toBe(true);
    expect(Object.values((await ratings(h, 'tech')).rows).filter((x) => x.kind === 'user').every((x) => x.placed && x.round === 2 && x.g >= 6)).toBe(true);
    const lines = (await h.store.readLines('matches/general/2026-10.jsonl')).map((l) => JSON.parse(l) as { subj: string; kind: string });
    for (const row of Object.values(done.rows).filter((x) => x.kind === 'user')) expect(lines.filter((l) => l.subj === row.id && l.kind === 'placement').length).toBe(8);
  });
});
