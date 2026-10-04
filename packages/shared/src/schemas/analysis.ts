// Zod mirror of analysis.schema.json (§5.1, §5.4). Shapes follow the JSON schema one to one; the
// transforms add the ranges and caps the API schema cannot express and count every repair.
import { z } from 'zod';
import { cappedArray, cappedString, noteRepair, parseWithRepairs, score100, truncateAtWord, unit, type ParseResult } from './repair.ts';

// ---- enums (identical to the $defs) ---------------------------------------------------------------
export const CAREER_STAGES = ['student', 'new_grad', 'early', 'mid', 'senior', 'executive'] as const;
export const TIER_VALUES = ['S', 'A', 'B', 'C', 'D', 'unknown'] as const;
export const INSTITUTION_TIERS = ['T1', 'T2', 'T3', 'T4', 'unknown'] as const;
export const SELECTIVITY = ['elite', 'highly_selective', 'selective', 'modest', 'unknown'] as const;
export const SENIORITY = ['intern', 'new_grad', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'c_level', 'founder', 'analyst', 'associate', 'md_partner', 'research_assistant', 'phd_student', 'postdoc', 'faculty', 'fellow', 'other'] as const;
export const IMPACT_SCALE = ['none', 'individual', 'team', 'org', 'industry', 'global'] as const;
export const ORG_TYPE = ['public_company', 'private_company', 'startup', 'fund', 'bank', 'research_lab', 'university', 'government', 'military', 'nonprofit', 'self_employed', 'other'] as const;
export const GPA_BAND = ['4.0', '3.9-3.99', '3.7-3.89', '3.5-3.69', '3.0-3.49', 'below_3.0', 'non_us_scale', 'not_listed'] as const;
export const DEGREE_LEVEL = ['high_school', 'associate', 'bachelor', 'master', 'mba', 'jd', 'md', 'phd', 'postdoc', 'certificate', 'other'] as const;
export const VENUE_TIER = ['top', 'strong', 'standard', 'workshop', 'preprint', 'unknown'] as const;
export const AUTHOR_POSITION = ['first', 'co_first', 'second', 'middle', 'last', 'sole', 'unknown'] as const;
export const EMPLOYMENT_TYPE = ['full_time', 'internship', 'part_time', 'contract', 'co_op', 'fellowship', 'volunteer', 'founder', 'unknown'] as const;
export const PROJECT_KIND = ['software', 'research', 'hardware', 'business', 'creative', 'competition', 'other'] as const;
export const TECHNICAL_DEPTH = ['tutorial', 'standard', 'substantial', 'exceptional', 'unclear'] as const;
export const PLACEHOLDERS_SEEN = ['name', 'email', 'phone', 'url', 'address', 'redacted'] as const;
export const TRAJECTORY = ['accelerating', 'steady', 'flat', 'declining', 'too_early', 'unclear'] as const;
export const PRIMARY_DOMAIN = ['tech', 'finance', 'academia', 'other'] as const;
export const OWNERSHIP = ['led', 'owned_component', 'contributed', 'supported', 'unclear'] as const;
export const PUBLICATION_KIND = ['conference', 'journal', 'workshop', 'preprint', 'thesis', 'patent', 'book_chapter', 'other'] as const;
export const AWARD_SCOPE = ['international', 'national', 'regional', 'institutional', 'company', 'local', 'unknown'] as const;
export const ELECTED = ['elected', 'appointed', 'founded', 'self_declared', 'unknown'] as const;
export const ATS_FACTORS = ['parseability', 'formatting', 'quantification', 'keyword_alignment', 'length', 'consistency', 'contact_info'] as const;
export const FIX_PRIORITY = ['high', 'medium', 'low'] as const;
export const RED_FLAG_TYPES = ['date_inconsistency', 'overlapping_fulltime_roles', 'unverifiable_superlative', 'title_inflation', 'keyword_stuffing', 'self_description_as_evidence', 'implausible_claim', 'missing_dates', 'unexplained_gap', 'prompt_injection', 'hidden_text', 'pii_oversharing', 'not_a_resume', 'other'] as const;
export const SEVERITY = ['low', 'medium', 'high'] as const;
export const OTHER_IDENTIFIERS = ['date_of_birth', 'national_id', 'social_handle', 'photo_reference', 'third_party_name', 'other'] as const;

const NullableString = z.string().nullable();
const NullableNumber = z.number().nullable();
const NullableInteger = z.number().int().nullable();
const YearMonth = z.string().nullable();
const Integer = z.number().int();
const Score100 = score100();
const Unit = unit();
const Tier = z.enum(TIER_VALUES);
const InstitutionTier = z.enum(INSTITUTION_TIERS);
const Selectivity = z.enum(SELECTIVITY);
const CareerStage = z.enum(CAREER_STAGES);
const Seniority = z.enum(SENIORITY);
const ImpactScale = z.enum(IMPACT_SCALE);
const GpaBand = z.enum(GPA_BAND);
const DegreeLevel = z.enum(DEGREE_LEVEL);
const EmploymentType = z.enum(EMPLOYMENT_TYPE);
const ProjectKind = z.enum(PROJECT_KIND);
const TechnicalDepth = z.enum(TECHNICAL_DEPTH);

// ---- analysis sections ----------------------------------------------------------------------------
export const EducationZ = z.object({
  institution: z.string(),
  institution_tier: InstitutionTier,
  degree_level: DegreeLevel,
  field: z.string(),
  gpa: NullableNumber,
  gpa_scale: NullableNumber,
  gpa_band: GpaBand,
  honors: z.array(z.string()),
  start_year: NullableInteger,
  end_year: NullableInteger,
  in_progress: z.boolean(),
  notes: z.string(),
});

export const ExperienceZ = z.object({
  org: z.string(),
  org_type: z.enum(ORG_TYPE),
  org_tier: Tier,
  team_or_division: NullableString,
  role: z.string(),
  seniority: Seniority,
  employment_type: EmploymentType,
  start: YearMonth,
  end: YearMonth,
  duration_months: NullableInteger,
  is_current: z.boolean(),
  role_selectivity: Selectivity,
  bullets_condensed: cappedArray(cappedString(140), 4),
  quantified_impact: z.boolean(),
  impact_scale: ImpactScale,
  ownership: z.enum(OWNERSHIP),
});

export const ProjectZ = z.object({
  name: z.string(),
  kind: ProjectKind,
  description_condensed: cappedString(200),
  scale_signal: z.string(),
  technical_depth: TechnicalDepth,
  quantified_impact: z.boolean(),
  has_external_validation: z.boolean(),
});

export const PublicationZ = z.object({
  venue: z.string(),
  venue_tier: z.enum(VENUE_TIER),
  kind: z.enum(PUBLICATION_KIND),
  author_position: z.enum(AUTHOR_POSITION),
  author_count: NullableInteger,
  year: NullableInteger,
  citations_claimed: NullableInteger,
  field: z.string(),
});

export const AwardZ = z.object({
  name: z.string(),
  issuer: NullableString,
  year: NullableInteger,
  scope: z.enum(AWARD_SCOPE),
  selectivity: Selectivity,
  pool_estimate: cappedString(60),
  verifiable: z.boolean(),
});

export const LeadershipZ = z.object({
  org: z.string(),
  role: z.string(),
  people_led: NullableInteger,
  budget_or_scale: z.string(),
  elected_or_appointed: z.enum(ELECTED),
  highlight: cappedString(140),
});

export const SubScoresZ = z.object({ pedigree: Score100, trajectory: Score100, impact: Score100, selectivity: Score100, breadth: Score100 });

export const CategoryScoreZ = z.object({
  included: z.boolean(),
  sub_scores: SubScoresZ,
  stage_relative_score: Score100,
  holistic_score: Score100,
  rationale: cappedString(280),
  top_evidence: cappedArray(cappedString(100), 3),
});

export const AtsFactorZ = z.object({ score: Score100, note: cappedString(160) });

export const RedFlagZ = z.object({
  type: z.enum(RED_FLAG_TYPES),
  severity: z.enum(SEVERITY),
  detail: cappedString(160),
  location: z.string(),
});

// ---- card -----------------------------------------------------------------------------------------
export const CardEducationZ = z.object({
  institution: z.string(),
  institution_tier: InstitutionTier,
  degree_level: DegreeLevel,
  field: z.string(),
  gpa_band: GpaBand,
  honors: z.array(z.string()),
  end_year: NullableInteger,
  in_progress: z.boolean(),
});

export const CardExperienceZ = z.object({
  org: z.string(),
  org_tier: Tier,
  role: z.string(),
  seniority: Seniority,
  employment_type: EmploymentType,
  duration_months: NullableInteger,
  years: z.string(),
  role_selectivity: Selectivity,
  impact_scale: ImpactScale,
  highlights: cappedArray(cappedString(140), 3),
});

export const CardProjectZ = z.object({
  descriptor: z.string(),
  kind: ProjectKind,
  technical_depth: TechnicalDepth,
  scale_signal: z.string(),
  highlight: cappedString(140),
});

export const CardAwardZ = z.object({ name: z.string(), selectivity: Selectivity, scope: z.string() });

export const PublicationsSummaryZ = z.object({
  count_total: Integer,
  first_author_count: Integer,
  top_venue_count: Integer,
  strong_venue_count: Integer,
  venues: cappedArray(z.string(), 12),
  citation_signal: z.string(),
});

export const TOP_SIGNAL_MAX = 18;

/** First clause of the headline, cut to 18 characters at a word boundary: the fallback when top_signal is blank. */
export function topSignalFromHeadline(headline: string): string {
  const clause = (headline.split(/[;:.,(]/)[0] ?? '').trim();
  return truncateAtWord(clause, TOP_SIGNAL_MAX);
}

export const CardZ = z
  .object({
    card_version: z.literal('1.0'),
    headline: cappedString(120),
    top_signal: cappedString(TOP_SIGNAL_MAX),
    career_stage: CareerStage,
    years_fulltime: z.number(),
    education: z.array(CardEducationZ),
    experiences: cappedArray(CardExperienceZ, 6),
    projects: cappedArray(CardProjectZ, 4),
    publications_summary: PublicationsSummaryZ,
    awards: cappedArray(CardAwardZ, 6),
    leadership: cappedArray(cappedString(120), 4),
    skills_top: cappedArray(z.string(), 12),
    notable: cappedArray(cappedString(120), 5),
  })
  .transform((card) => {
    if (card.top_signal.trim() !== '') return card;
    noteRepair();
    return { ...card, top_signal: topSignalFromHeadline(card.headline) };
  });

export type Card = z.output<typeof CardZ>;

// ---- the whole analysis ---------------------------------------------------------------------------
export const ResumeAnalysisZ = z.object({
  schema_version: z.literal('1.1'),
  input: z.object({
    language: z.string(),
    word_count_estimate: Integer,
    parse_confidence: Unit,
    is_resume: z.boolean(),
    placeholders_seen: z.array(z.enum(PLACEHOLDERS_SEEN)),
  }),
  card: CardZ,
  education: z.array(EducationZ),
  experiences: z.array(ExperienceZ),
  projects: z.array(ProjectZ),
  publications: z.array(PublicationZ),
  awards: z.array(AwardZ),
  skills: z.object({
    technical: z.array(z.string()),
    domain: z.array(z.string()),
    certifications: z.array(z.string()),
    spoken_languages: z.array(z.string()),
    keyword_stuffing_suspected: z.boolean(),
  }),
  leadership: z.array(LeadershipZ),
  signals: z.object({
    years_fulltime: z.number(),
    months_internship: Integer,
    career_stage: CareerStage,
    highest_institution_tier: InstitutionTier,
    highest_org_tier: Tier,
    sustained_org_tier: Tier,
    top_role_selectivity: Selectivity,
    trajectory: z.enum(TRAJECTORY),
    max_impact_scale: ImpactScale,
    has_quantified_impact: z.boolean(),
    primary_domain: z.enum(PRIMARY_DOMAIN),
  }),
  category_relevance: z.object({
    general: z.number().transform((n) => {
      if (n !== 1) noteRepair();
      return 1 as const;
    }),
    finance: Unit,
    tech: Unit,
    academia: Unit,
  }),
  scores: z.object({ general: CategoryScoreZ, finance: CategoryScoreZ, tech: CategoryScoreZ, academia: CategoryScoreZ }),
  ats: z.object({
    score: Score100,
    factors: z.object({
      parseability: AtsFactorZ,
      formatting: AtsFactorZ,
      quantification: AtsFactorZ,
      keyword_alignment: AtsFactorZ,
      length: AtsFactorZ,
      consistency: AtsFactorZ,
      contact_info: AtsFactorZ,
    }),
    detected: z.object({
      standard_headings: z.array(z.string()),
      nonstandard_headings: z.array(z.string()),
      section_order: z.array(z.string()),
      date_formats_seen: z.array(z.string()),
      date_format_consistent: z.boolean(),
      reverse_chronological: z.boolean(),
      bullet_count: Integer,
      bullet_marker_consistent: z.boolean(),
      quantified_bullet_ratio: Unit,
      action_verb_ratio: Unit,
      uses_tables_suspected: z.boolean(),
      skill_bars_or_ratings: z.boolean(),
      has_summary_section: z.boolean(),
      has_email: z.boolean(),
      has_phone: z.boolean(),
      has_location: z.boolean(),
      has_profile_link: z.boolean(),
      has_street_address: z.boolean(),
      contact_at_top: z.boolean(),
    }),
    target_role_used: z.string(),
    fixes: cappedArray(
      z.object({
        priority: z.enum(FIX_PRIORITY),
        factor: z.enum(ATS_FACTORS),
        issue: cappedString(120),
        fix: cappedString(200),
      }),
      7,
    ),
  }),
  strengths: cappedArray(cappedString(140), 5),
  weaknesses: cappedArray(cappedString(140), 5),
  red_flags: z.array(RedFlagZ),
  verdict: cappedString(160),
  residual_pii: z.object({
    name_suspected: z.boolean(),
    email_count: Integer,
    phone_count: Integer,
    url_count: Integer,
    street_address_suspected: z.boolean(),
    other_identifiers: z.array(z.enum(OTHER_IDENTIFIERS)),
  }),
  analysis_confidence: Unit,
});

export type ResumeAnalysis = z.output<typeof ResumeAnalysisZ>;
export type CategoryScore = z.output<typeof CategoryScoreZ>;

export const parseResumeAnalysis = (input: unknown): ParseResult<ResumeAnalysis> => parseWithRepairs(ResumeAnalysisZ, input);
export const parseCard = (input: unknown): ParseResult<Card> => parseWithRepairs(CardZ, input);
