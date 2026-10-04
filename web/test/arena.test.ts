import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArenaPool } from '@resumearena/shared';
import { agreementPct, applyGuess, markSeen, nextCategory, prepareQueue, shuffle } from '../src/lib/arena.ts';
import { EMPTY_ARENA } from '../src/lib/storage.ts';

const pool = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'mock-data', 'pages', 'arena', 'general.json'), 'utf8')) as ArenaPool;

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('arena queue', () => {
  it('shuffles locally and deterministically under an injected rng', () => {
    const a = prepareQueue(pool.pairs, { seen: [], ownIds: new Set(), rng: seeded(7) });
    const b = prepareQueue(pool.pairs, { seen: [], ownIds: new Set(), rng: seeded(7) });
    expect(a.fresh.map((p) => p.m)).toEqual(b.fresh.map((p) => p.m));
    expect(a.fresh).toHaveLength(pool.pairs.length);
    expect(a.fresh.map((p) => p.m)).not.toEqual(pool.pairs.map((p) => p.m));
    expect(a.exhausted).toBe(false);
  });

  it('skips seen pairs and reports exhaustion when nothing fresh is left', () => {
    const seen = pool.pairs.slice(0, 5).map((p) => p.m);
    const q = prepareQueue(pool.pairs, { seen, ownIds: new Set(), rng: seeded(1) });
    expect(q.fresh).toHaveLength(pool.pairs.length - 5);
    expect(q.fresh.some((p) => seen.includes(p.m))).toBe(false);
    const all = prepareQueue(pool.pairs, { seen: pool.pairs.map((p) => p.m), ownIds: new Set(), rng: seeded(1) });
    expect(all.fresh).toHaveLength(0);
    expect(all.exhausted).toBe(true);
  });

  it('hides pairs that touch an entry this browser submitted', () => {
    const own = pool.pairs[0]?.a.id ?? '';
    const q = prepareQueue(pool.pairs, { seen: [], ownIds: new Set([own]), rng: seeded(3) });
    expect(q.fresh.some((p) => p.a.id === own || p.b.id === own)).toBe(false);
    expect(q.fresh.length).toBeLessThan(pool.pairs.length);
  });

  it('shuffle keeps every element exactly once', () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    expect([...shuffle(arr, seeded(9))].sort((a, b) => a - b)).toEqual(arr);
  });
});

describe('streak logic', () => {
  it('increments the streak on agreement, resets on disagreement, tracks best and agreement percentage after 20', () => {
    const pair = { ...pool.pairs[0]!, w: 'A' as const };
    let s = EMPTY_ARENA;
    ({ state: s } = applyGuess(s, pair, 'A'));
    ({ state: s } = applyGuess(s, pair, 'A'));
    expect(s.streak).toBe(2);
    expect(s.best).toBe(2);
    ({ state: s } = applyGuess(s, pair, 'B'));
    expect(s.streak).toBe(0);
    expect(s.best).toBe(2);
    expect(s.disagreeRun).toBe(1);
    expect(s.guesses).toBe(3);
    expect(s.agreed).toBe(2);
    expect(agreementPct(s)).toBeNull();
    for (let i = 0; i < 17; i++) ({ state: s } = applyGuess(s, pair, 'A'));
    expect(agreementPct(s)).toBeCloseTo(19 / 20);
    expect(s.seen).toContain(pair.m);
  });

  it('a draw guess agrees only with a draw verdict; skip marks seen without counting', () => {
    const draw = { ...pool.pairs[0]!, w: 'draw' as const };
    expect(applyGuess(EMPTY_ARENA, draw, 'draw').agreed).toBe(true);
    expect(applyGuess(EMPTY_ARENA, draw, 'A').agreed).toBe(false);
    const skipped = markSeen(EMPTY_ARENA, 'abc');
    expect(skipped.guesses).toBe(0);
    expect(skipped.seen).toEqual(['abc']);
  });

  it('rotates the default category', () => {
    expect(nextCategory(null)).toBe('general');
    expect(nextCategory('general')).toBe('finance');
    expect(nextCategory('academia')).toBe('general');
  });
});
