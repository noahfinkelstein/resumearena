// Engine-side post-validation of an analysis (§5.5), in the spec's order.
import {
  canonicalJson, computeCategoryScore, includedCategories, recomputeAtsScore, sweepAnalysisText,
  type Category, type CareerStage, type GateVerdict, type HeldReason, type ResumeAnalysis, type ReviewReason,
} from '@resumearena/shared';
import { sha256Hex } from '../rng.ts';

export interface PostValidated {
  analysis: ResumeAnalysis;
  cardScrubbed: number;
  cardSha256: string;
  categoryRelevance: Record<Category, number>;
  scores: Partial<Record<Category, number>>;
  included: Category[];
  stage: CareerStage;
  topSignal: string;
  status: 'analyzed' | 'held' | 'needs_review';
  heldReason: HeldReason | null;
  reviewReason: ReviewReason | null;
}

export function postValidate(raw: ResumeAnalysis, gate: GateVerdict, relevanceMin: number): PostValidated {
  // 2. Sweep every free-text field (card included); hits become [removed].
  const swept = sweepAnalysisText(raw);
  const analysis = swept.analysis;
  // 3. Recompute what the model is not trusted to total.
  analysis.ats.score = recomputeAtsScore(analysis.ats.factors);
  const categoryRelevance = { ...analysis.category_relevance } as Record<Category, number>;
  const included = includedCategories(categoryRelevance, relevanceMin);
  const scores: Partial<Record<Category, number>> = {};
  for (const cat of ['general', 'finance', 'tech', 'academia'] as const) {
    const inc = included.includes(cat);
    analysis.scores[cat].included = inc;
    if (inc) scores[cat] = computeCategoryScore(cat, analysis.scores[cat]);
  }
  const stage = analysis.signals.career_stage;
  const topSignal = analysis.card.top_signal;
  const cardSha256 = sha256Hex(canonicalJson(analysis.card));

  // 4–6. Holds and review, first match wins.
  const pii = analysis.residual_pii;
  let status: PostValidated['status'] = 'analyzed';
  let heldReason: HeldReason | null = null;
  let reviewReason: ReviewReason | null = null;
  if (pii.name_suspected || pii.email_count + pii.phone_count + pii.url_count > 0 || pii.street_address_suspected) {
    status = 'held';
    heldReason = 'pii';
  } else if (gate.prompt_injection_detected && analysis.red_flags.some((f) => (f.type === 'prompt_injection' || f.type === 'hidden_text') && f.severity === 'high')) {
    status = 'held';
    heldReason = 'injection';
  } else if (analysis.input.is_resume === false) {
    status = 'needs_review';
    reviewReason = 'not_a_resume';
  } else if (analysis.analysis_confidence < 0.3) {
    status = 'needs_review';
    reviewReason = 'low_confidence';
  }
  return { analysis, cardScrubbed: swept.hits, cardSha256, categoryRelevance, scores, included, stage, topSignal, status, heldReason, reviewReason };
}
