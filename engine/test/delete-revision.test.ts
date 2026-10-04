// A delete request removes every engine-side reference; a revision ticket inherits the lineage (D-42).
import { describe, expect, it } from 'vitest';
import { CATEGORIES, RatingsFileZ, ResumeDocZ, UserDocZ, buildPayload, seedRating, type ArenaPool, type CardsShard, type HistoryDoc, type ResumeDoc, type RowsShard } from '@resumearena/shared';
import { runRerank } from '../src/commands/rerank.ts';
import { MS_PER_HOUR } from '../src/clock.ts';
import { cardsPath, deleteRequestPath, historyPath, placementTicketPath, ratingsPath, resumePath, rowsPath, userPath } from '../src/store/paths.ts';
import { createSyntheticJudge, strengthFromId } from '../sim/judge.ts';
import { idFor, ownerFor, seedResumes } from '../sim/seed.ts';
import { createHarness, FROZEN_NOW } from './helpers/harness.ts';

const SETTINGS = { daily_budget_usd: 10_000, rating: { max_placements_per_run: 100 } } as const;

describe('delete request', () => {
  it('removes the row from every ratings file, its history docs, arena pairs and queue entries', async () => {
    const h = await createHarness({ settings: SETTINGS });
    const specs = Array.from({ length: 8 }, (_, i) => ({ id: idFor(i, 'del'), ownerHash: ownerFor(i), scores: { general: 50 + i * 3, tech: 55 + i }, queuedAt: FROZEN_NOW }));
    await seedResumes(h.store, specs);
    const judge = createSyntheticJudge({ strength: strengthFromId('del'), seed: 'del' });
    await runRerank(h.ctx, { judge });
    h.clock.advance(7 * MS_PER_HOUR);
    await runRerank(h.fork({ runId: 'test-2' }), { judge }); // refinement fills the arena
    const victim = specs[3]!.id;
    const before = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    const victimRow = before.rows[victim]!;
    expect(victimRow.g).toBeGreaterThan(0);
    const opponentId = victimRow.opp[0]!;
    const opponentGames = before.rows[opponentId]!.g;
    // What submit's delete writes (D-27): doc tombstone is not needed by the engine; rows/cards go, the request appears.
    const rows = (await h.store.readJson<RowsShard>(rowsPath(victim)))!;
    delete rows[victim];
    await h.store.writeJson(rowsPath(victim), rows);
    const cards = (await h.store.readJson<CardsShard>(cardsPath(victim)))!;
    delete cards[victim];
    await h.store.writeJson(cardsPath(victim), cards);
    await h.store.writeJson(deleteRequestPath(victim), { schema: 1, id: victim, requested_at: h.clock.iso(), handle: `h-${victim}` });
    await h.store.writeJson(placementTicketPath(victim), { schema: 1, id: victim, handle: `h-${victim}`, owner_hash: ownerFor(3), primary: 'general', supersedes: null, queued_at: FROZEN_NOW });

    const r = await runRerank(h.fork({ runId: 'test-3' }), { judge });
    expect(r.deleted).toBe(1);
    for (const cat of CATEGORIES) {
      const file = RatingsFileZ.parse(await h.store.readJson(ratingsPath(cat)));
      expect(file.rows[victim]).toBeUndefined();
      expect(await h.store.exists(historyPath(cat, victim))).toBe(false);
      const arena = (await h.store.readJson<ArenaPool>(`arena/${cat}.json`))!;
      expect(arena.pairs.some((p) => p.a.id === victim || p.b.id === victim)).toBe(false);
    }
    expect(await h.store.exists(deleteRequestPath(victim))).toBe(false);
    expect(await h.store.exists(placementTicketPath(victim))).toBe(false);
    const after = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    expect(after.rows[opponentId]!.g).toBeGreaterThanOrEqual(opponentGames);
    // Opponents keep their results: the match log still carries the games against the deleted id.
    const log = (await h.store.readLines('matches/general/2026-10.jsonl')).map((l) => JSON.parse(l) as { a: string; b: string });
    expect(log.some((l) => l.a === victim || l.b === victim)).toBe(true);
    expect(await h.store.exists(historyPath('general', opponentId))).toBe(true);
  });
});

describe('revision inheritance', () => {
  it('the new id inherits rating, record and lineage; the old rows go ineligible; history is renamed', async () => {
    const h = await createHarness({ settings: SETTINGS });
    const specs = Array.from({ length: 6 }, (_, i) => ({ id: idFor(i, 'rev'), ownerHash: ownerFor(i), scores: { general: 50 + i * 4, tech: 60 }, queuedAt: FROZEN_NOW }));
    await seedResumes(h.store, specs);
    const judge = createSyntheticJudge({ strength: strengthFromId('rev'), seed: 'rev' });
    await runRerank(h.ctx, { judge });
    const oldId = specs[2]!.id;
    const oldGeneral = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general'))).rows[oldId]!;
    const oldTech = RatingsFileZ.parse(await h.store.readJson(ratingsPath('tech'))).rows[oldId]!;
    expect(oldGeneral.placed).toBe(true);
    const oldHistory = (await h.store.readJson<HistoryDoc>(historyPath('general', oldId)))!;
    const newId = idFor(42, 'rev');
    // Submit's resubmission: new rows/cards entry, old ones removed, ticket with supersedes.
    const rows = (await h.store.readJson<RowsShard>(rowsPath(oldId)))!;
    delete rows[oldId];
    await h.store.writeJson(rowsPath(oldId), rows);
    await seedResumes(h.store, [{ id: newId, ownerHash: ownerFor(2), scores: { general: 70, finance: 60 }, queuedAt: h.clock.iso(), supersedes: oldId }]);
    h.clock.advance(MS_PER_HOUR);
    const r = await runRerank(h.fork({ runId: 'test-2' }), { judge });
    expect(r.state).toBe('ok');
    const general = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    const tech = RatingsFileZ.parse(await h.store.readJson(ratingsPath('tech')));
    const finance = RatingsFileZ.parse(await h.store.readJson(ratingsPath('finance')));
    const fresh = general.rows[newId]!;
    expect(general.rows[oldId]!.elig).toBe(false);
    expect(tech.rows[oldId]!.elig).toBe(false);
    expect(tech.rows[newId]).toBeUndefined(); // dropped domain: no new row
    expect(fresh.lin).toBe(oldId);
    expect(fresh.score).toBe(70);
    expect(fresh.placed).toBe(true);
    // Revision rounds [3, 2]: five more games on top of the inherited record.
    expect(fresh.g).toBe(oldGeneral.g + 5);
    expect(fresh.w + fresh.l + fresh.d).toBe(fresh.g);
    expect(fresh.round).toBe(2);
    expect(fresh.peak).toBeGreaterThanOrEqual(oldGeneral.peak);
    // Newly qualifying domain gets a fresh placement row ([3, 3]).
    const fin = finance.rows[newId]!;
    expect(fin.lin).toBe(newId);
    expect(fin.g).toBe(6);
    expect(fin.placed).toBe(true);
    // History continued under the new id and the old doc is gone.
    const newHistory = (await h.store.readJson<HistoryDoc>(historyPath('general', newId)))!;
    expect(newHistory.lin).toBe(oldId);
    expect(newHistory.points.slice(0, oldHistory.points.length)).toEqual(oldHistory.points);
    expect(newHistory.points.some((p) => p[3] === 'v')).toBe(true);
    expect(await h.store.exists(historyPath('general', oldId))).toBe(false);
    const lines = (await h.store.readLines('matches/general/2026-10.jsonl')).map((l) => JSON.parse(l) as { subj: string; kind: string });
    expect(lines.filter((l) => l.subj === newId).every((l) => l.kind === 'revision')).toBe(true);
    expect(lines.filter((l) => l.subj === newId).length).toBe(5);
    expect(oldTech.r).not.toBeNull();
  });
});

describe('delete after a revision (F05)', () => {
  it('A → B supersedes A → delete B → C starts fresh: the superseded stub is never promoted or inherited', async () => {
    const h = await createHarness({ settings: SETTINGS });
    const slug = 'anchor-tech-1000-student-regional-cs-retail';
    const judge = createSyntheticJudge({ strength: strengthFromId('f05'), seed: 'f05' });
    const a = await h.submitSlug(slug, { handle: 'revisor' });
    expect(a.report.outcome).toBe('analyzed');
    await runRerank(h.ctx, { judge });
    const placedA = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general'))).rows[a.input.id]!;
    expect(placedA.placed).toBe(true);
    expect(placedA.g).toBe(8);

    const b = await h.submitSlug(slug, { handle: 'revisor', id: 'bbbbbbbbb2', text: `${a.input.text}\n\nSecond version.` });
    expect(b.report.outcome).toBe('analyzed');
    expect(b.report.supersedes).toBe(a.input.id);
    expect((ResumeDocZ.parse(await h.store.readJson(resumePath(a.input.id))) as ResumeDoc).status).toBe('superseded');

    const del = await h.manage(buildPayload({ action: 'delete', id: 'bbbbbbbbb2', handle: 'revisor', owner_hash: b.input.owner_hash, owner_key: b.ownerKey }));
    expect(del.outcome).toBe('deleted');
    const user = UserDocZ.parse(await h.store.readJson(userPath('revisor')));
    // The superseded stub stays listed but is not current: the person deleted their rating.
    expect(user.state).toBe('active');
    expect(user.resumes.map((r) => [r.id, r.current])).toEqual([[a.input.id, false]]);

    const c = await h.submitSlug(slug, { handle: 'revisor', id: 'cccccccccc', text: `${a.input.text}\n\nThird version.` });
    expect(c.report.outcome).toBe('analyzed');
    expect(c.report.supersedes).toBeNull();
    const ticket = await h.store.readJson<{ supersedes: string | null }>(placementTicketPath('cccccccccc'));
    expect(ticket?.supersedes).toBeNull();
    expect(UserDocZ.parse(await h.store.readJson(userPath('revisor'))).resumes.map((r) => [r.id, r.current])).toEqual([[a.input.id, false], ['cccccccccc', true]]);

    h.clock.advance(MS_PER_HOUR);
    const r = await runRerank(h.fork({ runId: 'test-2' }), { judge });
    expect(r.state).toBe('ok');
    const general = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    const fresh = general.rows['cccccccccc']!;
    expect(fresh.lin).toBe('cccccccccc');
    expect(fresh.seed).toBe(seedRating(fresh.score));
    expect(fresh.placed).toBe(true);
    // A full placement ([3, 3, 2]), not the five-game revision on top of A's eight.
    expect(fresh.g).toBe(8);
  });

  it('a ticket whose supersedes names a retired row does not inherit it', async () => {
    const h = await createHarness({ settings: SETTINGS });
    const specs = Array.from({ length: 5 }, (_, i) => ({ id: idFor(i, 'ret'), ownerHash: ownerFor(i), scores: { general: 50 + i * 4 }, queuedAt: FROZEN_NOW }));
    await seedResumes(h.store, specs);
    const judge = createSyntheticJudge({ strength: strengthFromId('ret'), seed: 'ret' });
    await runRerank(h.ctx, { judge });
    const oldId = specs[1]!.id;
    const file = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general')));
    file.rows[oldId]!.elig = false;
    await h.store.writeJson(ratingsPath('general'), file);
    const newId = idFor(77, 'ret');
    await seedResumes(h.store, [{ id: newId, ownerHash: ownerFor(1), scores: { general: 70 }, queuedAt: h.clock.iso(), supersedes: oldId }]);
    h.clock.advance(MS_PER_HOUR);
    await runRerank(h.fork({ runId: 'test-2' }), { judge });
    const fresh = RatingsFileZ.parse(await h.store.readJson(ratingsPath('general'))).rows[newId]!;
    expect(fresh.lin).toBe(newId);
    expect(fresh.g).toBe(8);
  });
});
