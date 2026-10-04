import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_WEIGHTS, isAnchorId, type Category, type HistoryDoc, type LadderMeta, type LadderPage, type RankShard, type ResumeDoc, type UserDoc } from '@resumearena/shared';
import type { RankLookup } from '../src/lib/data.ts';
import { busyWindowMinutes, clampPage, displayedOpponentIds, EMPTY_LOOKUP, focusLink, historyEvents, ladderRows, matchViews, opponentLabel, pageForRank, profileView, ratingViews, resultView, stagePartition } from '../src/lib/views.ts';

const root = path.resolve(__dirname, '..', 'mock-data');
const load = <T,>(rel: string): T => JSON.parse(readFileSync(path.join(root, rel), 'utf8')) as T;

const doc = load<ResumeDoc>('raw/resumes/k7/k7q2m3xw5a.json');
const shard = load<RankShard>('pages/rank/k7.json');
const entry = shard['k7q2m3xw5a'] ?? null;
const history = load<HistoryDoc>('raw/history/tech/k7/k7q2m3xw5a.json');
const user = load<UserDoc>('raw/users/pr/priya-n.json');
const meta = load<LadderMeta>('pages/ladder/tech/meta.json');

describe('resultView from the mock dataset', () => {
  it('composes identity, ratings (primary first), breakdown weights and medians, matches and text', () => {
    const v = resultView({ doc, entry, histories: { tech: history }, medians: meta.medians });
    expect(v.identity).toEqual({ kind: 'handle', value: 'priya-n' });
    expect(v.primary).toBe('tech');
    expect(v.ratings[0]?.category).toBe('tech');
    expect(v.ratings.map((r) => r.category)).toEqual(['tech', 'general', 'finance', 'academia']);
    const tech = v.primaryRating;
    expect(tech).not.toBeNull();
    expect(tech?.rated).toBe(true);
    expect(tech?.pm).toBe(Math.round(1.96 * (entry?.t?.[3] ?? 0)));
    expect(tech?.rank).toBe(entry?.t?.[0]);
    expect(v.breakdown.map((r) => r.key)).toEqual(['pedigree', 'trajectory', 'impact', 'selectivity', 'breadth']);
    expect(v.breakdown[0]?.weight).toBe(CATEGORY_WEIGHTS.tech.pedigree);
    expect(v.breakdown[0]?.median).toBe(meta.medians?.pedigree);
    // One rationale per category (schema), rendered once; no factor row pretends to own it.
    expect(v.rationale).toBe(doc.analysis?.scores.tech.rationale);
    expect(v.breakdown.every((r) => r.note === undefined)).toBe(true);
    expect(v.ats?.factors.every((f) => typeof f.note === 'string')).toBe(true);
    expect(v.stageRelative?.score).toBe(doc.analysis?.scores.tech.stage_relative_score);
    expect(v.headline.find((h) => h.category === 'tech')?.score).toBe(doc.scores?.tech);
    expect(v.headline.find((h) => h.category === 'finance')?.score).toBeNull();
    expect(v.matches.length).toBeGreaterThan(0);
    expect(v.matches.length).toBeLessThanOrEqual(10);
    expect(v.text).toContain('[name]');
    expect(v.redFlags.every((f) => f.severity !== 'low')).toBe(true);
    expect(v.spark.length).toBeGreaterThanOrEqual(3);
  });

  it('marks excluded categories and unplaced tuples', () => {
    const views = ratingViews({ primary: 'tech', scores: { general: 70, tech: 75 } }, { h: null, v: 'anonymous', st: 'mid', sig: '', p: 'tech', g: [null, 10, 1500, 200, 2, 1, 1, 0, null, 0, null, null] });
    expect(views.find((r) => r.category === 'general')?.provisional).toBe(true);
    expect(views.find((r) => r.category === 'tech')).toMatchObject({ included: true, rated: false });
    expect(views.find((r) => r.category === 'finance')).toMatchObject({ included: false, rated: false });
  });

  it('resolves opponents: handle, anon, reference resume, deleted entry, shard not read', () => {
    const entries = new Map<string, RankShard[string]>();
    entries.set('x6ppa2a7mq', { h: null, v: 'anonymous', st: 'mid', sig: '', p: 'general' });
    entries.set('k7v2m4syfl', { h: 'marco-wu', v: 'handle', st: 'mid', sig: '', p: 'general' });
    const opp: RankLookup = { entries, fetched: new Set(['x6', 'k7', 'zz']) };
    expect(opponentLabel('x6ppa2a7mq', opp)).toEqual({ label: 'anon-x6ppa2a', href: '/r/x6ppa2a7mq' });
    expect(opponentLabel('k7v2m4syfl', opp)).toEqual({ label: 'marco-wu', href: '/r/k7v2m4syfl' });
    expect(opponentLabel('anchrtgaaa', opp)).toEqual({ label: 'reference resume', href: null });
    expect(opponentLabel('anchrtgaaa', EMPTY_LOOKUP)).toEqual({ label: 'reference resume', href: null });
    // Shard zz was read and holds no such id: the entry is gone.
    expect(opponentLabel('zzzzzzzzzz', opp)).toEqual({ label: 'deleted entry', href: null });
    // Shard qq was never read (over the cap, or the request failed): a neutral label and no link, not "deleted".
    expect(opponentLabel('qqqqqqqqqq', opp)).toEqual({ label: 'entry', href: null });
    expect(opponentLabel('x6ppa2a7mq', EMPTY_LOOKUP)).toEqual({ label: 'entry', href: null });
    const ms = matchViews({ tech: history }, opp, 10);
    expect(ms.some((m) => m.opponentIdentity === 'reference resume')).toBe(true);
    expect(ms.map((m) => m.at)).toEqual([...ms.map((m) => m.at)].sort().reverse());
  });

  it('asks for the rank shards of the displayed rows only', () => {
    // Four ladders, ten recent matches each, every opponent in a different shard: forty ids, ten rows shown.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const oppId = (n: number): string => `${alphabet[Math.floor(n / 32) % 32]}${alphabet[n % 32]}${'a'.repeat(8)}`;
    const cats: Category[] = ['general', 'finance', 'tech', 'academia'];
    const histories: Partial<Record<Category, HistoryDoc>> = {};
    cats.forEach((cat, c) => {
      const base = history.recent[0];
      if (!base) throw new Error('fixture history has no recent matches');
      histories[cat] = {
        ...history,
        cat,
        recent: Array.from({ length: 10 }, (_, i) => {
          const n = c * 10 + i;
          // One reference resume among the newest rows: it must not ask for a shard.
          const opp = n === 27 ? 'anchrtgaaa' : oppId(n);
          return { ...base, m: `m${n}`, opp, at: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00Z` };
        }),
      };
    });
    const shown = matchViews(histories, EMPTY_LOOKUP, 10);
    expect(shown).toHaveLength(10);
    const ids = displayedOpponentIds(histories);
    expect(ids).toEqual([...new Set(shown.map((m) => m.opponentId).filter((o) => !isAnchorId(o)))]);
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some(isAnchorId)).toBe(false);
    // Nothing from the thirty rows that are not shown.
    const hidden = new Set(cats.flatMap((cat) => histories[cat]?.recent.map((m) => m.opp) ?? []).filter((o) => !shown.some((m) => m.opponentId === o)));
    expect(ids.some((id) => hidden.has(id))).toBe(false);
    // With exactly those shards read, no displayed opponent is called deleted or left neutral by mistake.
    const lookup: RankLookup = { entries: new Map(ids.map((id) => [id, { h: null, v: 'anonymous' as const, st: 'mid' as const, sig: '', p: 'general' as const }])), fetched: new Set(ids.map((id) => id.slice(0, 2))) };
    const labelled = matchViews(histories, lookup, 10);
    expect(labelled.filter((m) => !isAnchorId(m.opponentId)).every((m) => m.opponentHref === `/r/${m.opponentId}`)).toBe(true);
  });

  it('profileView carries versions, current id and ratings; historyEvents are newest first with labels', () => {
    const p = profileView(user, doc, entry);
    expect(p.currentId).toBe('k7q2m3xw5a');
    expect(p.versions).toBe(1);
    expect(p.visibility).toBe('handle');
    expect(p.ratings[0]?.category).toBe('tech');
    const ev = historyEvents(history);
    expect((ev[0]?.date ?? '') >= (ev[ev.length - 1]?.date ?? '')).toBe(true);
    expect(ev.map((e) => e.label)).toContain('placement');
  });
});

describe('ladder paging', () => {
  const page1 = load<LadderPage>('pages/ladder/general/all/1.json');
  const page2 = load<LadderPage>('pages/ladder/general/all/2.json');

  it('turns page tuples into rows with identities, and pages are contiguous and dense', () => {
    const rows = ladderRows(page1);
    expect(rows).toHaveLength(100);
    expect(rows[0]?.rank).toBe(1);
    expect(rows[99]?.rank).toBe(100);
    expect(ladderRows(page2)[0]?.rank).toBe(101);
    expect(rows.every((r) => (r.identity.kind === 'anon') === r.identity.value.startsWith('anon-'))).toBe(true);
    expect(rows.map((r) => r.r)).toEqual([...rows.map((r) => r.r)].sort((a, b) => b - a));
  });

  it('computes the page for a rank, clamps pages and builds focus links', () => {
    expect(pageForRank(1)).toBe(1);
    expect(pageForRank(100)).toBe(1);
    expect(pageForRank(101)).toBe(2);
    expect(pageForRank(1204)).toBe(13);
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(Number.NaN, 5)).toBe(1);
    expect(stagePartition(null)).toBe('all');
    expect(stagePartition('new_grad')).toBe('stage-new_grad');
    expect(focusLink('k7q2m3xw5a', 'tech', 412)).toBe('/leaderboard/tech?page=5&focus=k7q2m3xw5a');
    expect(focusLink('k7q2m3xw5a', 'tech', null)).toBe('/leaderboard/tech?page=1&focus=k7q2m3xw5a');
  });
});

describe('busy warning window (§7.2)', () => {
  const status = (n: number, updatedAt: string) => ({ health: { submissions_last_hour: n }, updated_at: updatedAt }) as Parameters<typeof busyWindowMinutes>[0];
  it('fires only at the published cap, not a hardcoded 20', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(busyWindowMinutes(status(19, '2026-10-03T12:00:00Z'), 20, now)).toBeNull();
    expect(busyWindowMinutes(status(20, '2026-10-03T12:00:00Z'), 20, now)).toBe(60);
    expect(busyWindowMinutes(status(5, '2026-10-03T12:00:00Z'), 5, now)).toBe(60);
    expect(busyWindowMinutes(status(20, '2026-10-03T12:00:00Z'), 40, now)).toBeNull();
  });
  it('shrinks as the measured window ages and never drops below a minute', () => {
    const measured = '2026-10-03T12:00:00Z';
    expect(busyWindowMinutes(status(20, measured), 20, Date.parse('2026-10-03T12:25:00Z'))).toBe(35);
    expect(busyWindowMinutes(status(20, measured), 20, Date.parse('2026-10-03T13:30:00Z'))).toBe(1);
    expect(busyWindowMinutes(status(20, 'garbage'), 20, Date.parse('2026-10-03T13:30:00Z'))).toBe(60);
  });
});
