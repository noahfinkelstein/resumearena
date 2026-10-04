import { describe, expect, it } from 'vitest';
import { ATS_WEIGHTS, CATEGORY_WEIGHTS, RELEVANCE_THRESHOLD, absoluteScore, computeCategoryScore, includedCategories, isIncluded, recomputeAtsScore, subScoreTuple } from '../src/scoring.ts';

describe('scoring', () => {
  it('weights sum to one', () => {
    for (const w of Object.values(CATEGORY_WEIGHTS)) expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Object.values(ATS_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(RELEVANCE_THRESHOLD).toBe(0.35);
  });
  it('worked examples from the rubric (81 and 75)', () => {
    const sophomore = { sub_scores: { pedigree: 78, trajectory: 70, impact: 30, selectivity: 92, breadth: 45 }, stage_relative_score: 94 };
    expect(absoluteScore('tech', sophomore.sub_scores)).toBeCloseTo(62.2);
    expect(computeCategoryScore('tech', sophomore)).toBe(81);
    const staff = { sub_scores: { pedigree: 55, trajectory: 80, impact: 90, selectivity: 60, breadth: 50 }, stage_relative_score: 78 };
    expect(absoluteScore('tech', staff.sub_scores)).toBeCloseTo(71.25);
    expect(computeCategoryScore('tech', staff)).toBe(75);
  });
  it('clamps to 0–100', () => {
    expect(computeCategoryScore('general', { sub_scores: { pedigree: 100, trajectory: 100, impact: 100, selectivity: 100, breadth: 100 }, stage_relative_score: 100 })).toBe(100);
    expect(computeCategoryScore('general', { sub_scores: { pedigree: 0, trajectory: 0, impact: 0, selectivity: 0, breadth: 0 }, stage_relative_score: 0 })).toBe(0);
  });
  it('recomputeAtsScore', () => {
    const f = (score: number) => ({ score });
    expect(recomputeAtsScore({ parseability: f(100), formatting: f(100), quantification: f(100), keyword_alignment: f(100), length: f(100), consistency: f(100), contact_info: f(100) })).toBe(100);
    expect(recomputeAtsScore({ parseability: f(95), formatting: f(90), quantification: f(80), keyword_alignment: f(85), length: f(100), consistency: f(90), contact_info: f(85) })).toBe(89);
    expect(recomputeAtsScore({ parseability: f(0), formatting: f(0), quantification: f(0), keyword_alignment: f(0), length: f(0), consistency: f(0), contact_info: f(0) })).toBe(0);
  });
  it('inclusion is relevance ≥ 0.35 except general', () => {
    const rel = { general: 1, finance: 0.1, tech: 0.82, academia: 0.35 };
    expect(isIncluded('general', { general: 1 })).toBe(true);
    expect(isIncluded('finance', rel)).toBe(false);
    expect(isIncluded('tech', rel)).toBe(true);
    expect(isIncluded('academia', rel)).toBe(true);
    expect(isIncluded('academia', { academia: 0.349 })).toBe(false);
    expect(isIncluded('tech', {})).toBe(false);
    expect(includedCategories(rel)).toEqual(['general', 'tech', 'academia']);
  });
  it('subScoreTuple order is pedigree, trajectory, impact, selectivity, breadth, stage_relative', () => {
    expect(subScoreTuple({ sub_scores: { pedigree: 1, trajectory: 2, impact: 3, selectivity: 4, breadth: 5 }, stage_relative_score: 6 })).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
