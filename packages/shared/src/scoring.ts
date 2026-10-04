// Rubric scoring (§6.2 "Scoring", scoring-rubric.md §3–§4). Pure; the engine stores what it computes here.
import type { Category } from './types.ts';

export const SUB_SCORE_KEYS = ['pedigree', 'trajectory', 'impact', 'selectivity', 'breadth'] as const;
export type SubScoreKey = (typeof SUB_SCORE_KEYS)[number];
export type SubScores = Record<SubScoreKey, number>;

export const CATEGORY_WEIGHTS: Readonly<Record<Category, Readonly<SubScores>>> = {
  general: { pedigree: 0.2, trajectory: 0.2, impact: 0.25, selectivity: 0.2, breadth: 0.15 },
  tech: { pedigree: 0.15, trajectory: 0.2, impact: 0.3, selectivity: 0.25, breadth: 0.1 },
  finance: { pedigree: 0.25, trajectory: 0.2, impact: 0.2, selectivity: 0.3, breadth: 0.05 },
  academia: { pedigree: 0.2, trajectory: 0.15, impact: 0.35, selectivity: 0.25, breadth: 0.05 },
};

export const STAGE_BLEND = { stage_relative: 0.6, absolute: 0.4 } as const;
export const RELEVANCE_THRESHOLD = 0.35;

export const ATS_FACTOR_KEYS = ['parseability', 'formatting', 'quantification', 'keyword_alignment', 'length', 'consistency', 'contact_info'] as const;
export type AtsFactorKey = (typeof ATS_FACTOR_KEYS)[number];
export const ATS_WEIGHTS: Readonly<Record<AtsFactorKey, number>> = {
  parseability: 0.25,
  formatting: 0.15,
  quantification: 0.2,
  keyword_alignment: 0.15,
  length: 0.1,
  consistency: 0.1,
  contact_info: 0.05,
};

export interface CategoryScoreInput {
  sub_scores: SubScores;
  stage_relative_score: number;
}

const clamp100 = (n: number): number => Math.min(100, Math.max(0, n));

/** Σ w_c × sub_c for one category; not rounded. */
export function absoluteScore(cat: Category, sub: SubScores): number {
  const w = CATEGORY_WEIGHTS[cat];
  let total = 0;
  for (const k of SUB_SCORE_KEYS) total += w[k] * sub[k];
  return total;
}

/** `round(0.6 × stage_relative + 0.4 × absolute)`, clamped 0–100. Worked examples: 81 and 75 (§13.4). */
export function computeCategoryScore(cat: Category, cs: CategoryScoreInput): number {
  const blended = STAGE_BLEND.stage_relative * cs.stage_relative_score + STAGE_BLEND.absolute * absoluteScore(cat, cs.sub_scores);
  return clamp100(Math.round(blended));
}

/** The engine stores this instead of the model's own total (scoring-rubric.md §4.3). */
export function recomputeAtsScore(factors: Record<AtsFactorKey, { score: number }>): number {
  let total = 0;
  for (const k of ATS_FACTOR_KEYS) total += ATS_WEIGHTS[k] * factors[k].score;
  return clamp100(Math.round(total));
}

/** general is always in; a domain needs relevance ≥ 0.35. The model's `included` flag is advisory. */
export function isIncluded(cat: Category, relevance: Partial<Record<Category, number>>, threshold = RELEVANCE_THRESHOLD): boolean {
  if (cat === 'general') return true;
  return (relevance[cat] ?? 0) >= threshold;
}

export function includedCategories(relevance: Partial<Record<Category, number>>, threshold = RELEVANCE_THRESHOLD): Category[] {
  const cats: Category[] = ['general', 'finance', 'tech', 'academia'];
  return cats.filter((c) => isIncluded(c, relevance, threshold));
}

/** `rows[id].ss[cat]` order: pedigree, trajectory, impact, selectivity, breadth, stage_relative (D-39). */
export function subScoreTuple(cs: CategoryScoreInput): [number, number, number, number, number, number] {
  const s = cs.sub_scores;
  return [s.pedigree, s.trajectory, s.impact, s.selectivity, s.breadth, cs.stage_relative_score];
}
