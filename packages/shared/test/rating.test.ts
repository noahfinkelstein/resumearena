import { describe, expect, it } from 'vitest';
import {
  applyMatch, applyPeriod, delta7, driftDecision, driftShift, driftStats, expected, g, glickoUpdate, hardStop, inflateRd, inflateRdForIdle, outcomeFromPasses,
  placementAllowed, placementOffsets, placementWindow, plusMinus, priority, priorityTerms, Q, rankAndPercentile, rankDelta1d, refineAllowance, runsLeft, seedDomain, seedRating,
  type BoardRowLike, type PriorityInput,
} from '../src/rating.ts';

describe('glicko', () => {
  it('q is ln10/400', () => {
    expect(Q).toBeCloseTo(0.0057565, 6);
    expect(g(0)).toBe(1);
    expect(g(30)).toBeCloseTo(0.9955, 4);
    expect(g(100)).toBeCloseTo(0.9531, 4);
    expect(g(300)).toBeCloseTo(0.7242, 4);
    expect(expected(1500, 1400, 30)).toBeCloseTo(0.639, 3);
  });

  it("reproduces Glickman's worked example (1500/200 vs 1400/30 W, 1550/100 L, 1700/300 L)", () => {
    const r = glickoUpdate(1500, 200, [
      { oppR: 1400, oppRd: 30, score: 1 },
      { oppR: 1550, oppRd: 100, score: 0 },
      { oppR: 1700, oppRd: 300, score: 0 },
    ]);
    // Exact formulas: 1464.11 / 151.40 (d² = 53685.74 as in the paper). The spec's check values
    // 1464.06 / 151.52 come from rounded intermediates; both sit inside the tolerance below.
    expect(r.r).toBe(1464.11);
    expect(r.rd).toBe(151.4);
    expect(Math.abs(r.r - 1464.06)).toBeLessThan(0.1);
    expect(Math.abs(r.rd - 151.52)).toBeLessThan(0.15);
  });

  it('matches the RD table after n even games from 250 against RD-100 opponents', () => {
    for (const [n, want] of [[4, 147], [8, 115], [20, 78], [40, 56]] as const) {
      const games = Array.from({ length: n }, (_, i) => ({ oppR: 1500, oppRd: 100, score: i % 2 === 0 ? 1 : 0 }));
      const { r, rd } = glickoUpdate(1500, 250, games);
      expect(r).toBe(1500);
      expect(Math.abs(rd - want)).toBeLessThanOrEqual(1);
    }
  });

  it('is a no-op on an empty period and respects the floor', () => {
    expect(glickoUpdate(1500, 200, [])).toEqual({ r: 1500, rd: 200 });
    const games = Array.from({ length: 400 }, (_, i) => ({ oppR: 1500, oppRd: 30, score: i % 2 === 0 ? 1 : 0 }));
    expect(glickoUpdate(1500, 50, games).rd).toBe(50);
    expect(glickoUpdate(1500, 50, games, 40).rd).toBeLessThan(50);
  });

  it('applies both sides of a match from pre values', () => {
    const pre = { ar: 1600, ard: 100, br: 1500, brd: 200 };
    const win = applyMatch(pre, 1);
    const loss = applyMatch(pre, 0);
    const draw = applyMatch(pre, 0.5);
    expect(win.a.r).toBeGreaterThan(1600);
    expect(win.b.r).toBeLessThan(1500);
    expect(loss.a.r).toBeLessThan(1600);
    expect(loss.b.r).toBeGreaterThan(1500);
    expect(draw.a.r).toBeLessThan(1600);
    expect(draw.b.r).toBeGreaterThan(1500);
    expect(win.a.rd).toBeLessThan(100);
    expect(win.b.rd).toBeLessThan(200);
  });

  it('applyPeriod updates the subject once and each unlocked opponent once', () => {
    const res = applyPeriod({ r: 1400, rd: 250 }, [
      { oppId: 'x', oppR: 1300, oppRd: 80, score: 1 },
      { oppId: 'anchrgfaaa', oppR: 1400, oppRd: 30, score: 0.5, locked: true },
      { oppId: 'y', oppR: 1550, oppRd: 120, score: 0 },
    ]);
    expect(res.subject.rd).toBeLessThan(250);
    expect(res.opponents.has('anchrgfaaa')).toBe(false);
    expect(res.opponents.get('x')?.r).toBeLessThan(1300);
    expect(res.opponents.get('y')?.r).toBeGreaterThan(1550);
  });

  it('inflates RD once per idle day beyond seven, capped at the ceiling', () => {
    expect(inflateRd(50)).toBe(50.36);
    expect(inflateRd(349.99)).toBe(350);
    expect(inflateRdForIdle(50, 7)).toBe(50);
    expect(inflateRdForIdle(50, 8)).toBe(inflateRd(50));
    expect(inflateRdForIdle(50, 37)).toBeCloseTo(Math.sqrt(50 * 50 + 30 * 36), 2);
    expect(inflateRdForIdle(50, 100000)).toBe(350);
  });
});

describe('seeds and placement geometry', () => {
  it('seedRating clamps 800..1600', () => {
    expect(seedRating(50)).toBe(1200);
    expect(seedRating(0)).toBe(800);
    expect(seedRating(100)).toBe(1600);
    expect(seedRating(-20)).toBe(800);
    expect(seedRating(140)).toBe(1600);
    expect(seedRating(71)).toBe(1368);
  });
  it('seedDomain blends general rating and domain seed', () => {
    expect(seedDomain(1500, 60)).toBe(1390);
    expect(seedDomain(1600, 100)).toBe(1600);
  });
  it('placementOffsets and window', () => {
    expect(placementOffsets(3, 100)).toEqual([-70, 0, 70]);
    expect(placementOffsets(2, 100)).toEqual([-50, 50]);
    expect(placementOffsets(1, 100)).toEqual([0]);
    expect(placementOffsets(0, 100)).toEqual([]);
    expect(placementWindow(100)).toBe(60);
    expect(placementWindow(300)).toBeCloseTo(105);
  });
  it('plusMinus', () => {
    expect(plusMinus(38.1)).toBe(75);
    expect(plusMinus(250)).toBe(490);
  });
});

describe('outcomeFromPasses', () => {
  it('covers all four combinations', () => {
    expect(outcomeFromPasses('first', 'second')).toEqual({ o: 1, agree: true });
    expect(outcomeFromPasses('second', 'first')).toEqual({ o: 0, agree: true });
    expect(outcomeFromPasses('first', 'first')).toEqual({ o: 0.5, agree: false });
    expect(outcomeFromPasses('second', 'second')).toEqual({ o: 0.5, agree: false });
  });
});

describe('rankAndPercentile', () => {
  const row = (id: string, r: number | null, rd = 50, extra: Partial<BoardRowLike> = {}): BoardRowLike => ({ id, r, rd, elig: true, placed: true, kind: 'user', ...extra });

  it('orders r desc, rd asc, id asc and writes top = rank/total', () => {
    const m = rankAndPercentile([row('c', 1500, 60), row('b', 1500, 40), row('a', 1500, 40), row('z', 1700), row('q', 1400)]);
    expect([...m.entries()].sort((x, y) => x[1].rank - y[1].rank).map(([id]) => id)).toEqual(['z', 'a', 'b', 'c', 'q']);
    expect(m.get('z')).toEqual({ rank: 1, total: 5, top: 0.2, pct: 1 });
    expect(m.get('q')).toEqual({ rank: 5, total: 5, top: 1, pct: 0 });
    expect(m.get('b')?.pct).toBeCloseTo(0.5);
  });
  it('n = 1 gives rank 1, pct 1, top 1', () => {
    expect(rankAndPercentile([row('only', 1234)]).get('only')).toEqual({ rank: 1, total: 1, top: 1, pct: 1 });
  });
  it('excludes anchors, unplaced, ineligible and unrated rows', () => {
    const m = rankAndPercentile([
      row('a', 1500),
      row('anchor', 1600, 30, { kind: 'anchor' }),
      row('unplaced', 1600, 200, { placed: false }),
      row('gone', 1600, 50, { elig: false }),
      row('waiting', null),
    ]);
    expect([...m.keys()]).toEqual(['a']);
    expect(m.get('a')?.total).toBe(1);
  });
  it('rounds top to 4 dp', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`r${i}`, 1500 - i));
    expect(rankAndPercentile(rows).get('r0')?.top).toBe(0.1429);
  });
});

describe('priority', () => {
  const base: PriorityInput = { rd: 100, daysSinceLast: 10, pct: 0.5, moved: false, jitter: 0.5 };
  const bump = (patch: Partial<PriorityInput>) => priority({ ...base, ...patch });

  it('is monotone in each term', () => {
    expect(bump({ rd: 200 })).toBeGreaterThan(bump({}));
    expect(bump({ daysSinceLast: 40 })).toBeGreaterThan(bump({}));
    expect(bump({ pct: 0.95 })).toBeGreaterThan(bump({}));
    expect(bump({ moved: true })).toBeGreaterThan(bump({}));
    expect(bump({ jitter: 0.9 })).toBeGreaterThan(bump({}));
    expect(bump({ views7d: 500 })).toBe(bump({}));
  });
  it('uses the documented term shapes', () => {
    const t = priorityTerms({ rd: 200, daysSinceLast: 90, pct: 1, moved: true, jitter: 0 });
    expect(t.U).toBeCloseTo(0.25);
    expect(t.S).toBe(1);
    expect(t.T).toBe(1);
    expect(t.V).toBe(1);
    expect(priorityTerms({ ...base, pct: null }).T).toBeCloseTo(Math.exp(-4));
    expect(priority({ rd: 50, daysSinceLast: 0, pct: 0, moved: false, jitter: 1 })).toBeCloseTo(1.5 * Math.exp(-8) + 0.25);
  });
});

describe('drift', () => {
  it('computes residual and standard error', () => {
    const s = driftStats([{ s: 1, e: 0.5 }, { s: 0, e: 0.5 }, { s: 1, e: 0.6 }, { s: 1, e: 0.4 }]);
    expect(s.n).toBe(4);
    expect(s.res).toBeCloseTo(0.25);
    expect(s.se).toBeCloseTo(Math.sqrt((0.25 + 0.25 + 0.24 + 0.24) / 4 / 4));
    expect(driftStats([])).toEqual({ n: 0, res: 0, se: 0 });
  });
  it('shift is half-corrected, clamped to ±10 and zero below 2', () => {
    expect(driftShift(0.05)).toBe(4.34);
    expect(driftShift(-0.05)).toBe(-4.34);
    expect(driftShift(0.5)).toBe(10);
    expect(driftShift(0.002)).toBe(0);
  });
  it('decision needs 150 games and |res| > 2 SE', () => {
    expect(driftDecision({ n: 149, res: 0.1, se: 0.01 }, { minGames: 150, maxShift: 10 })).toBe(0);
    expect(driftDecision({ n: 150, res: 0.015, se: 0.01 }, { minGames: 150, maxShift: 10 })).toBe(0);
    expect(driftDecision({ n: 150, res: 0.05, se: 0.01 }, { minGames: 150, maxShift: 10 })).toBe(4.34);
  });
});

describe('budget arithmetic', () => {
  it('runs_left per D-49', () => {
    expect(runsLeft(new Date('2026-10-03T23:55:00Z'))).toBe(1);
    expect(runsLeft(new Date('2026-10-03T00:00:00Z'))).toBe(144);
    expect(runsLeft(new Date('2026-10-03T12:00:30Z'))).toBe(72);
  });
  it('refine allowance', () => {
    const base = { dailyBudgetUsd: 25, refineBudgetShare: 0.4, refineSpentTodayUsd: 0, estCostPerMatchUsd: 0.0165, maxRefineMatchesPerRun: 120, runsLeft: 144 };
    expect(refineAllowance(base)).toBe(4);
    expect(refineAllowance({ ...base, runsLeft: 1 })).toBe(120);
    expect(refineAllowance({ ...base, refineSpentTodayUsd: 10 })).toBe(0);
    expect(refineAllowance({ ...base, refineSpentTodayUsd: 12 })).toBe(0);
  });
  it('placement and hard stop gates', () => {
    expect(placementAllowed(24.99, 25)).toBe(true);
    expect(placementAllowed(25, 25)).toBe(false);
    expect(hardStop(28.74, 25)).toBe(false);
    expect(hardStop(28.75, 25)).toBe(true);
  });
});

describe('days ring deltas', () => {
  const days: [string, number, number | null][] = [['2026-09-26', 1630.0, 430], ['2026-09-27', 1631.5, 428], ['2026-10-03', 1639.9, 415]];
  it('delta7 picks the newest snapshot at or before today − 7 d, else the oldest', () => {
    expect(delta7(days, 1642.31, '2026-10-03')).toBe(12);
    expect(delta7(days, 1642.31, '2026-10-04')).toBe(11);
    expect(delta7(days, 1642.31, '2026-10-01')).toBe(12);
    expect(delta7([], 1642.31, '2026-10-03')).toBeNull();
  });
  it('rank_delta_1d is yesterday minus today', () => {
    expect(rankDelta1d(days, 412)).toBe(3);
    expect(rankDelta1d(days, null)).toBeNull();
    expect(rankDelta1d([['2026-10-03', 1500, null]], 5)).toBeNull();
    expect(rankDelta1d([], 5)).toBeNull();
  });
});
