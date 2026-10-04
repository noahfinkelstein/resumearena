// §10 snapshot tests: ladder page, rank shard, meta, excluded statuses absent, arena filtering, medians.
import { describe, expect, it } from 'vitest';
import { CATEGORIES, type ArenaPool, type LadderMeta, type LadderPage, type RankShard, type RatingRow, type RowEntry } from '@resumearena/shared';
import { buildIndexFiles, type IndexInputs } from '../src/commands/build-indexes.ts';
import { emptyArena } from '../src/rank/state.ts';
import { emptyStatus } from '../src/settings.ts';
import { DEFAULT_SETTINGS } from '@resumearena/shared';
import { makeCard } from '../../packages/shared/test/helpers/analysis-fixture.ts';

const NOW = '2026-10-10T12:00:00Z';

function row(id: string, over: Partial<RowEntry> = {}): RowEntry {
  return { h: `h-${id.slice(0, 4)}`, v: 'anonymous', p: 'tech', st: 'mid', sig: 'sig', s: 'analyzed', c: { general: 1, tech: 0.8 }, sc: { general: 70, tech: 75 }, ss: { general: [60, 70, 78, 64, 55, 74], tech: [52, 70, 78, 86, 68, 74] }, ch: 'c'.repeat(64), t: 1_759_500_000, ...over };
}

function rating(id: string, r: number, over: Partial<RatingRow> = {}): RatingRow {
  return { id, own: id.slice(0, 12), lin: id, r, rd: 40, vol: 0.06, seed: 1400, score: 70, g: 20, w: 12, d: 3, l: 5, round: 3, placed: true, kind: 'user', locked: false, elig: true, rank: null, top: null, peak: r, peak_at: '2026-10-01', last: '2026-10-09T00:00:00Z', days: [['2026-10-02', r - 20, 3], ['2026-10-09', r - 5, 2]], opp: [], mv: 0, created: '2026-09-30T00:00:00Z', ...over };
}

function inputs(): IndexInputs {
  const rows = new Map<string, RowEntry>();
  rows.set('k7q2m3xw5a', row('k7q2m3xw5a', { v: 'handle', h: 'priya-n' }));
  rows.set('k7aaaaaaaa', row('k7aaaaaaaa', { st: 'early' }));
  rows.set('x91pp2a7mq', row('x91pp2a7mq', { st: 'early', p: 'general' }));
  rows.set('a81hhq2ppz', row('a81hhq2ppz', { st: 'senior' }));
  rows.set('zz2222222b', row('zz2222222b', { s: 'superseded' }));
  rows.set('held000001', row('held000001', { s: 'held' }));
  rows.set('unplaced01', row('unplaced01'));
  const general = new Map<string, RatingRow>();
  const tech = new Map<string, RatingRow>();
  general.set('k7q2m3xw5a', rating('k7q2m3xw5a', 1642.31, { rank: 1, top: 0.25 }));
  general.set('k7aaaaaaaa', rating('k7aaaaaaaa', 1500, { rank: 3, top: 0.75 }));
  general.set('x91pp2a7mq', rating('x91pp2a7mq', 1588, { rank: 2, top: 0.5 }));
  general.set('a81hhq2ppz', rating('a81hhq2ppz', 1400, { rank: 4, top: 1 }));
  general.set('zz2222222b', rating('zz2222222b', 1700, { elig: false }));
  general.set('held000001', rating('held000001', 1800));
  general.set('unplaced01', rating('unplaced01', 1300, { placed: false, round: 1, g: 3 }));
  general.set('anchrggaaa', rating('anchrggaaa', 1500, { kind: 'anchor', locked: true, own: 'anchor' }));
  tech.set('k7q2m3xw5a', rating('k7q2m3xw5a', 1650, { rank: 1, top: 0.5 }));
  tech.set('k7aaaaaaaa', rating('k7aaaaaaaa', 1450, { rank: 2, top: 1 }));
  const arena: ArenaPool = { schema: 1, category: 'tech', updated_at: NOW, pairs: [pair('m1', 'k7q2m3xw5a', 'k7aaaaaaaa'), pair('m2', 'k7q2m3xw5a', 'zz2222222b'), pair('m3', 'held000001', 'k7aaaaaaaa')] };
  return { rows, ratings: { general, tech, finance: new Map(), academia: new Map() }, arena: { general: emptyArena('general', NOW), tech: arena, finance: emptyArena('finance', NOW), academia: emptyArena('academia', NOW) } };
}

function pair(m: string, a: string, b: string): ArenaPool['pairs'][number] {
  return { m, at: NOW, kind: 'refine', a: { id: a, card: makeCard() as never, stage: 'mid', r_before: 1600, delta: 5 }, b: { id: b, card: makeCard() as never, stage: 'mid', r_before: 1500, delta: -5 }, w: 'A', c: 0.7, reason: 'A: more. B: less.' };
}

describe('build-indexes', () => {
  const files = buildIndexFiles(inputs(), DEFAULT_SETTINGS, emptyStatus(NOW, DEFAULT_SETTINGS), { buildId: 'b1', commit: 'c1', dataSha: 'd1', now: NOW });

  it('writes the general ladder page ranked r desc with identity, tier, pm, d7 and top', () => {
    const page = files.get('ladder/general/all/1.json') as LadderPage;
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r[1])).toEqual(['k7q2m3xw5a', 'x91pp2a7mq', 'k7aaaaaaaa', 'a81hhq2ppz']);
    expect(page.rows[0]).toEqual([1, 'k7q2m3xw5a', 'priya-n', 'candidate', 1642, 78, 12, 5, 3, 'mid', 'sig', 20, 0.25]);
    expect(page.rows[1]?.[2]).toBe('anon-x91pp2a');
    const early = files.get('ladder/general/stage-early/1.json') as LadderPage;
    expect(early.rows.map((r) => [r[0], r[1]])).toEqual([[1, 'x91pp2a7mq'], [2, 'k7aaaaaaaa']]);
    expect(files.has('ladder/general/stage-executive/1.json')).toBe(false);
  });

  it('excludes held, superseded, unplaced and anchors from boards; keeps unplaced in rank shards', () => {
    const page = files.get('ladder/general/all/1.json') as LadderPage;
    for (const id of ['held000001', 'zz2222222b', 'unplaced01', 'anchrggaaa']) expect(page.rows.some((r) => r[1] === id)).toBe(false);
    const k7 = files.get('rank/k7.json') as RankShard;
    expect(Object.keys(k7).sort()).toEqual(['k7aaaaaaaa', 'k7q2m3xw5a']);
    expect(k7.k7q2m3xw5a).toEqual({ h: 'priya-n', v: 'handle', st: 'mid', sig: 'sig', p: 'tech', g: [1, 4, 1642, 40, 20, 12, 5, 3, 20, 1, 0.25, 1], t: [1, 2, 1650, 40, 20, 12, 5, 3, 20, 1, 0.5, 1] });
    const un = files.get('rank/un.json') as RankShard;
    expect(un.unplaced01?.g).toEqual([null, 4, 1300, 40, 3, 12, 5, 3, null, 0, null, null]);
    expect(files.has('rank/he.json')).toBe(false);
    expect(files.has('rank/zz.json')).toBe(false);
  });

  it('meta carries totals per stage and medians only with 20+ rows', () => {
    const meta = files.get('ladder/general/meta.json') as LadderMeta;
    expect(meta.total).toBe(4);
    expect(meta.stages.early).toEqual({ total: 2, pages: 1 });
    expect(meta.stages.student).toEqual({ total: 0, pages: 0 });
    expect(meta.medians).toBeNull();
    const big = inputs();
    for (let i = 0; i < 20; i++) {
      const id = `mm${'abcdefghijklmnopqrstuvwxyz'[i]}aaaaaaa`;
      big.rows.set(id, row(id, { ss: { general: [i, 50, 50, 50, 50, 60] } }));
      big.ratings.general.set(id, rating(id, 1300 + i));
    }
    const meta2 = (buildIndexFiles(big, DEFAULT_SETTINGS, emptyStatus(NOW, DEFAULT_SETTINGS), { buildId: 'b', commit: 'c', dataSha: '', now: NOW }).get('ladder/general/meta.json') as LadderMeta).medians;
    expect(meta2).not.toBeNull();
    expect(meta2?.trajectory).toBe(50);
  });

  it('filters arena pairs whose ids lack a rank-shard entry and publishes the manifest last', () => {
    const arena = files.get('arena/tech.json') as ArenaPool;
    expect(arena.pairs.map((p) => p.m)).toEqual(['m1']);
    const keys = [...files.keys()];
    expect(keys[keys.length - 1]).toBe('manifest.json');
    const manifest = files.get('manifest.json') as { counts: { resumes: number; rated: Record<string, number> }; pages: Record<string, number> };
    expect(manifest.counts.resumes).toBe(5);
    expect(manifest.counts.rated).toEqual({ general: 4, tech: 2, finance: 0, academia: 0 });
    for (const cat of CATEGORIES) expect(files.has(`ladder/${cat}/meta.json`)).toBe(true);
    const settings = files.get('settings.json') as { tiers: unknown[]; categories: string[] };
    expect(settings.tiers.length).toBe(8);
  });
});
