import { describe, expect, it } from 'vitest';
import { PROVISIONAL_BLURB, TIERS, TIER_BY_KEY, isProvisional, tierFor, tierOf } from '../src/tiers.ts';

describe('tiers', () => {
  it('has eight tiers in ascending order with the spec thresholds', () => {
    expect(TIERS.map((t) => t.key)).toEqual(['entrant', 'contender', 'challenger', 'candidate', 'expert', 'master', 'grandmaster', 'laureate']);
    expect(TIERS.slice(1).map((t) => t.min)).toEqual([1200, 1400, 1600, 1800, 2000, 2200, 2400]);
    expect(TIERS.map((t) => t.numeral)).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);
    for (const t of TIERS) expect(t.blurb).not.toMatch(/percent|%|quarter|tenth|median/i);
  });
  it('boundaries', () => {
    expect(tierFor(1199)).toBe('entrant');
    expect(tierFor(1200)).toBe('contender');
    expect(tierFor(2399)).toBe('grandmaster');
    expect(tierFor(2400)).toBe('laureate');
    expect(tierFor(1199.5)).toBe('contender');
    expect(tierFor(1199.49)).toBe('entrant');
    expect(tierFor(-500)).toBe('entrant');
    expect(tierFor(9000)).toBe('laureate');
  });
  it('tierOf and lookups', () => {
    expect(tierOf(1650).label).toBe('Candidate');
    expect(TIER_BY_KEY.master.min).toBe(2000);
    expect(PROVISIONAL_BLURB).toBe('Not yet placed. The rating is a guess until placement finishes.');
    expect(isProvisional(false)).toBe(true);
    expect(isProvisional(1)).toBe(false);
  });
  it('survives JSON', () => {
    const back = JSON.parse(JSON.stringify(TIERS)) as typeof TIERS;
    expect(back[0]?.min).toBeTypeOf('number');
    expect(tierFor(1000, back)).toBe('entrant');
  });
});
