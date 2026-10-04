// Schema-valid ResumeAnalysis synthesis for mock mode. Scores derive from a hint (fixture anchor or a
// text hash), so they are stable; the card is built from the first lines and the score bands so the
// mock judge's strength heuristic ranks it consistently with the analyst's number.
import { ATS_FACTOR_KEYS, CATEGORIES, type Category, type CareerStage, type ResumeAnalysis, recomputeAtsScore } from '@resumearena/shared';
import type { Rng } from '../rng.ts';

export interface SynthesisHints {
  score: number;
  stage: CareerStage;
  relevance: Record<Category, number>;
  pii: { name: boolean; email: number; url: number; phone: number; address: boolean };
  injection: boolean;
  isResume: boolean;
  lowConfidence: boolean;
  keywordStuffing: boolean;
  extractionQuality: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const int = (n: number): number => Math.round(n);

type Tier = 'S' | 'A' | 'B' | 'C' | 'D';
type Sel = 'elite' | 'highly_selective' | 'selective' | 'modest';
type Impact = 'individual' | 'team' | 'org' | 'industry' | 'global';
type Inst = 'T1' | 'T2' | 'T3' | 'T4';

function bands(score: number): { tier: Tier; sel: Sel; impact: Impact; inst: Inst } {
  if (score >= 90) return { tier: 'S', sel: 'elite', impact: 'industry', inst: 'T1' };
  if (score >= 75) return { tier: 'A', sel: 'highly_selective', impact: 'org', inst: 'T2' };
  if (score >= 55) return { tier: 'B', sel: 'selective', impact: 'team', inst: 'T3' };
  if (score >= 40) return { tier: 'C', sel: 'modest', impact: 'team', inst: 'T3' };
  return { tier: 'D', sel: 'modest', impact: 'individual', inst: 'T4' };
}

const YEARS_BY_STAGE: Record<CareerStage, number> = { student: 0, new_grad: 0.5, early: 2.5, mid: 6, senior: 12, executive: 20 };

function firstLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !/^\[?(?:name|email|phone|url|address)\]?/i.test(l))
    .slice(0, n);
}

/** Model-written strings must carry no contact data; the synthesizer never includes any, but keeps lines short. */
const shorten = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export function synthesizeAnalysis(text: string, h: SynthesisHints, rng: Rng): ResumeAnalysis {
  const score = clamp(int(h.score), 0, 100);
  const b = bands(score);
  const jitter = (): number => int((rng.next() - 0.5) * 12);
  const sub = (base: number) => ({
    pedigree: clamp(base + jitter(), 0, 100),
    trajectory: clamp(base + jitter(), 0, 100),
    impact: clamp(base + jitter(), 0, 100),
    selectivity: clamp(base + jitter(), 0, 100),
    breadth: clamp(base - 5 + jitter(), 0, 100),
  });
  const lines = firstLines(text, 6);
  const orgName = lines[1] ?? 'Mid-size company';
  const years = YEARS_BY_STAGE[h.stage];
  const quantRatio = clamp(0.1 + score / 125, 0, 1);
  const factors = Object.fromEntries(
    ATS_FACTOR_KEYS.map((k) => {
      const base = k === 'parseability' ? (h.extractionQuality < 0.35 ? 55 : h.extractionQuality < 0.6 ? 75 : 95) : k === 'quantification' ? clamp(int(quantRatio * 100), 10, 100) : clamp(60 + score / 4 + jitter(), 0, 100);
      return [k, { score: clamp(int(base), 0, 100), note: k === 'parseability' && h.extractionQuality < 0.6 ? 'extraction quality below 0.60' : 'layout not verified' }];
    }),
  ) as ResumeAnalysis['ats']['factors'];
  const categoryScore = (cat: Category): ResumeAnalysis['scores'][Category] => {
    const rel = h.relevance[cat];
    const base = cat === 'general' ? score : clamp(score - 8 + int(rel * 10), 0, 100);
    const ss = sub(base);
    return {
      included: cat === 'general' || rel >= 0.35,
      sub_scores: ss,
      stage_relative_score: clamp(base + jitter(), 0, 100),
      holistic_score: clamp(base + jitter(), 0, 100),
      rationale: `${cat}: ${b.tier}-tier roles with ${b.impact}-scale outcomes for a ${h.stage.replace('_', ' ')} record.`,
      top_evidence: [shorten(`${b.tier}-tier role at ${orgName}`, 100), 'Quantified bullets on the main role'],
    };
  };
  const headline = shorten(`${h.stage.replace('_', ' ')} record; ${b.tier}-tier ${years > 0 ? 'role' : 'internship'} at a ${b.sel.replace('_', ' ')} employer; ${b.impact}-scale impact`, 120);
  const topSignal = { S: 'S-tier role', A: 'A-tier role', B: 'B-tier role', C: 'C-tier role', D: 'early record' }[b.tier];
  const redFlags: ResumeAnalysis['red_flags'] = [];
  if (h.injection) redFlags.push({ type: 'prompt_injection', severity: 'high', detail: 'A passage addresses the evaluator and asks for a score.', location: 'Summary' });
  if (h.keywordStuffing) redFlags.push({ type: 'keyword_stuffing', severity: 'medium', detail: 'A long technology list with no bullet using most of it.', location: 'Skills' });
  if (!h.isResume) redFlags.push({ type: 'not_a_resume', severity: 'high', detail: 'The document is not one person’s record.', location: 'Document' });
  const experienceCount = h.stage === 'student' ? 1 : h.stage === 'new_grad' ? 2 : 3;
  const experiences = Array.from({ length: experienceCount }, (_, i) => ({
    org: i === 0 ? shorten(orgName, 60) : `Company ${i + 1}`,
    org_type: 'private_company' as const,
    org_tier: i === 0 ? b.tier : ('B' as Tier),
    team_or_division: null,
    role: i === 0 ? `${h.stage === 'student' ? 'Intern' : 'Engineer'} (${b.tier})` : 'Analyst',
    seniority: (h.stage === 'student' ? 'intern' : h.stage === 'senior' || h.stage === 'executive' ? 'senior' : 'mid') as 'intern' | 'senior' | 'mid',
    employment_type: (h.stage === 'student' ? 'internship' : 'full_time') as 'internship' | 'full_time',
    start: `${2024 - i * 2 - 1}`,
    end: i === 0 ? 'present' : `${2024 - i * 2}`,
    duration_months: i === 0 ? int(12 + years * 4) : 18,
    is_current: i === 0,
    role_selectivity: i === 0 ? b.sel : ('modest' as Sel),
    bullets_condensed: [shorten(`Owned a ${b.impact}-scale deliverable with a stated number`, 140), 'Maintained the team’s core service'],
    quantified_impact: score >= 45,
    impact_scale: i === 0 ? b.impact : ('team' as Impact),
    ownership: (score >= 70 ? 'led' : score >= 45 ? 'owned_component' : 'contributed') as 'led' | 'owned_component' | 'contributed',
  }));
  const pubs = h.relevance.academia >= 0.35 ? int(1 + score / 25) : 0;
  const analysis: ResumeAnalysis = {
    schema_version: '1.1',
    input: {
      language: 'en',
      word_count_estimate: text.split(/\s+/).filter(Boolean).length,
      parse_confidence: clamp(h.extractionQuality || 0.9, 0, 1),
      is_resume: h.isResume,
      placeholders_seen: (['name', 'email', 'phone', 'url', 'address', 'redacted'] as const).filter((p) => text.includes(`[${p}]`)),
    },
    card: {
      card_version: '1.0',
      headline,
      top_signal: topSignal,
      career_stage: h.stage,
      years_fulltime: years,
      education: [{ institution: `${b.inst} university`, institution_tier: b.inst, degree_level: h.stage === 'executive' || h.stage === 'senior' ? 'master' : 'bachelor', field: 'Field of study', gpa_band: score >= 70 ? '3.7-3.89' : 'not_listed', honors: score >= 80 ? ['Named scholarship'] : [], end_year: h.stage === 'student' ? 2027 : 2024 - int(years), in_progress: h.stage === 'student' }],
      experiences: experiences.map((e) => ({
        org: e.org,
        org_tier: e.org_tier,
        role: e.role,
        seniority: e.seniority,
        employment_type: e.employment_type,
        duration_months: e.duration_months,
        years: `${e.start}-${e.end}`,
        role_selectivity: e.role_selectivity,
        impact_scale: e.impact_scale,
        highlights: e.bullets_condensed,
      })),
      projects: score >= 40 ? [{ descriptor: `${b.impact}-scale side project`, kind: 'software', technical_depth: score >= 75 ? 'substantial' : 'standard', scale_signal: score >= 75 ? '1k users' : 'none stated', highlight: 'Shipped and maintained' }] : [],
      publications_summary: { count_total: pubs, first_author_count: pubs ? int(pubs / 2) : 0, top_venue_count: score >= 85 && pubs ? 1 : 0, strong_venue_count: score >= 65 && pubs ? 1 : 0, venues: pubs ? ['Field conference'] : [], citation_signal: 'not stated' },
      awards: score >= 60 ? [{ name: score >= 85 ? 'National competition medal' : 'Departmental prize', selectivity: score >= 85 ? 'elite' : 'selective', scope: score >= 85 ? 'national' : 'institutional' }] : [],
      leadership: score >= 50 ? ['Led a small team on the main deliverable'] : [],
      skills_top: ['Skill one', 'Skill two', 'Skill three'],
      notable: score >= 75 ? [shorten(`${b.tier}-tier selection with ${b.impact}-scale outcome`, 120)] : [],
    },
    education: [{ institution: `${b.inst} university`, institution_tier: b.inst, degree_level: 'bachelor', field: 'Field of study', gpa: null, gpa_scale: null, gpa_band: 'not_listed', honors: [], start_year: 2020, end_year: 2024, in_progress: h.stage === 'student', notes: '' }],
    experiences,
    projects: [],
    publications: [],
    awards: [],
    skills: { technical: ['Skill one', 'Skill two', 'Skill three'], domain: [], certifications: [], spoken_languages: ['English'], keyword_stuffing_suspected: h.keywordStuffing },
    leadership: [],
    signals: {
      years_fulltime: years,
      months_internship: h.stage === 'student' ? 3 : 0,
      career_stage: h.stage,
      highest_institution_tier: b.inst,
      highest_org_tier: b.tier,
      sustained_org_tier: years >= 1 ? b.tier : 'unknown',
      top_role_selectivity: b.sel,
      trajectory: h.stage === 'student' ? 'too_early' : score >= 70 ? 'accelerating' : 'steady',
      max_impact_scale: b.impact,
      has_quantified_impact: score >= 45,
      primary_domain: h.relevance.tech >= 0.35 ? 'tech' : h.relevance.finance >= 0.35 ? 'finance' : h.relevance.academia >= 0.35 ? 'academia' : 'other',
    },
    category_relevance: { general: 1, finance: h.relevance.finance, tech: h.relevance.tech, academia: h.relevance.academia },
    scores: Object.fromEntries(CATEGORIES.map((c) => [c, categoryScore(c)])) as ResumeAnalysis['scores'],
    ats: {
      score: recomputeAtsScore(factors),
      factors,
      detected: {
        standard_headings: ['Education', 'Experience', 'Skills'],
        nonstandard_headings: [],
        section_order: ['Education', 'Experience', 'Skills'],
        date_formats_seen: ['YYYY'],
        date_format_consistent: true,
        reverse_chronological: true,
        bullet_count: Math.max(4, int(text.split('\n').filter((l) => /^[-•*]/.test(l.trim())).length)),
        bullet_marker_consistent: true,
        quantified_bullet_ratio: quantRatio,
        action_verb_ratio: 0.8,
        uses_tables_suspected: false,
        skill_bars_or_ratings: false,
        has_summary_section: /summary/i.test(text),
        has_email: text.includes('[email]'),
        has_phone: text.includes('[phone]'),
        has_location: text.includes('[address]') || /\b[A-Z][a-z]+, [A-Z]{2}\b/.test(text),
        has_profile_link: text.includes('[url]'),
        has_street_address: text.includes('[address]'),
        contact_at_top: /\[(?:email|phone)\]/.test(text.split('\n').slice(0, 6).join('\n')),
      },
      target_role_used: 'Role inferred from the record',
      fixes: [
        { priority: 'high', factor: 'quantification', issue: 'Several bullets describe duties without a number.', fix: 'Before: Improved the pipeline → After: Cut pipeline latency by __ % for __ users.' },
        { priority: 'medium', factor: 'keyword_alignment', issue: 'Core competencies appear only in the skills list.', fix: 'Move two skills into bullets with outcomes.' },
        { priority: 'low', factor: 'length', issue: 'Length is acceptable for the stage.', fix: 'Keep to the current page count.' },
      ],
    },
    strengths: [shorten(`${b.tier}-tier employer with a ${b.impact}-scale outcome on the main role`, 140), 'Dates and titles are consistent across roles', 'Education line names the degree and year'],
    weaknesses: ['Some bullets describe duties rather than outcomes', 'Skills list is longer than the evidence in bullets', 'No external validation for the side project'],
    red_flags: redFlags,
    verdict: shorten(`A ${h.stage.replace('_', ' ')} record whose strongest fact is a ${b.tier}-tier role; the rest is described but thinly measured.`, 160),
    residual_pii: { name_suspected: h.pii.name, email_count: h.pii.email, phone_count: h.pii.phone, url_count: h.pii.url, street_address_suspected: h.pii.address, other_identifiers: [] },
    analysis_confidence: h.lowConfidence ? 0.2 : h.isResume ? 0.85 : 0.4,
  };
  return analysis;
}
