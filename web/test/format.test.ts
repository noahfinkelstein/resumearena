import { describe, expect, it } from 'vitest';
import { fmtCount, fmtDate, fmtDelta, fmtElapsed, fmtFileSize, fmtRank, fmtRatingWithRd, fmtRecord, fmtRelative, fmtTopPct, fmtUpdatedAgo, fmtUsd, middleTruncate } from '../src/lib/format.ts';

describe('format rules (product-ux.md §5.2)', () => {
  it('ratings, ±, ranks, deltas, records', () => {
    expect(fmtRatingWithRd(1642.4, 38)).toBe('1642 ±38');
    expect(fmtRank(1204)).toBe('#1,204');
    expect(fmtDelta(12)).toBe('+12');
    expect(fmtDelta(-7)).toBe('−7');
    expect(fmtDelta(0)).toBe('0');
    expect(fmtRecord(21, 15, 2)).toBe('21-15-2');
  });

  it('percentiles never divide and floor at 0.1', () => {
    expect(fmtTopPct(0.032)).toBe('top 3.2%');
    expect(fmtTopPct(0.24)).toBe('top 24%');
    expect(fmtTopPct(0.0001)).toBe('top 0.1%');
    expect(fmtTopPct(0.61)).toBe('top 61%');
    expect(fmtTopPct(0.61, { own: true })).toBe('bottom 39%');
  });

  it('counts, money, sizes', () => {
    expect(fmtCount(124318)).toBe('124,318');
    expect(fmtCount(2_100_000)).toBe('2.1M');
    expect(fmtUsd(18.4)).toBe('$18.40');
    expect(fmtFileSize(412 * 1024)).toBe('412 KB');
    expect(fmtFileSize(1.3 * 1024 * 1024)).toBe('1.3 MB');
  });

  it('dates and relative times', () => {
    expect(fmtDate('2026-10-03T14:31:00Z')).toMatch(/^\d{1,2} Oct 2026$/);
    const now = Date.parse('2026-10-03T14:31:00Z');
    expect(fmtRelative('2026-10-03T12:31:00Z', now)).toBe('2 h ago');
    expect(fmtRelative('2026-10-02T13:00:00Z', now)).toBe('yesterday');
    expect(fmtRelative('2026-09-29T14:31:00Z', now)).toBe('4 d ago');
    expect(fmtUpdatedAgo('2026-10-03T14:30:40Z', now)).toBe('updated just now');
    expect(fmtUpdatedAgo('2026-10-03T14:27:00Z', now)).toBe('updated 4 min ago');
    expect(fmtUpdatedAgo('2026-10-03T12:31:00Z', now)).toBe('updated 2 h ago');
    expect(fmtUpdatedAgo('2026-10-01T14:31:00Z', now)).toBe('updated 1 Oct 14:31 UTC');
  });

  it('elapsed and truncation', () => {
    expect(fmtElapsed(42_000)).toBe('0:42');
    expect(fmtElapsed(12 * 60_000 + 5_000)).toBe('12:05');
    expect(fmtElapsed(3_729_000)).toBe('1:02:09');
    expect(middleTruncate('linkedin.com/in/priya-natarajan-12345')).toHaveLength(28);
    expect(middleTruncate('short')).toBe('short');
  });
});
