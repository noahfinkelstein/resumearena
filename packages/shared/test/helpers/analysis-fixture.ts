// A complete, schema-valid ResumeAnalysis for tests. Built fresh on every call so tests can mutate it.
export function makeCard() {
  return {
    card_version: '1.0',
    headline: 'Mid-career infrastructure engineer; senior at an A-tier company; owned a 40k rps system',
    top_signal: '40k rps system',
    career_stage: 'mid',
    years_fulltime: 6.5,
    education: [
      { institution: 'State University', institution_tier: 'T3', degree_level: 'bachelor', field: 'Computer Science', gpa_band: 'not_listed', honors: ["Dean's List"], end_year: 2018, in_progress: false },
    ],
    experiences: [
      {
        org: 'Acme Cloud', org_tier: 'A', role: 'Senior Software Engineer', seniority: 'senior', employment_type: 'full_time', duration_months: 40, years: '2021-present',
        role_selectivity: 'selective', impact_scale: 'org', highlights: ['Owned an ingest service at 40k rps with a 120 ms p99', 'Led 4 engineers through a migration that cut cost 35%'],
      },
      {
        org: 'Widgets Inc', org_tier: 'B', role: 'Software Engineer', seniority: 'mid', employment_type: 'full_time', duration_months: 36, years: '2018-2021',
        role_selectivity: 'modest', impact_scale: 'team', highlights: ['Built a billing pipeline processing 2M invoices a month'],
      },
    ],
    projects: [{ descriptor: 'Open-source load-testing tool (1k stars)', kind: 'software', technical_depth: 'substantial', scale_signal: '1k stars', highlight: 'Caught three outages before release' }],
    publications_summary: { count_total: 0, first_author_count: 0, top_venue_count: 0, strong_venue_count: 0, venues: [], citation_signal: 'not stated' },
    awards: [],
    leadership: ['Led a team of 4 engineers'],
    skills_top: ['Go', 'Rust', 'Kubernetes', 'Postgres', 'Kafka', 'Terraform'],
    notable: ['Owned a 40k rps system with a stated p99'],
  };
}

function categoryScore(sub: [number, number, number, number, number], stage: number, holistic: number, included = true) {
  return {
    included,
    sub_scores: { pedigree: sub[0], trajectory: sub[1], impact: sub[2], selectivity: sub[3], breadth: sub[4] },
    stage_relative_score: stage,
    holistic_score: holistic,
    rationale: 'Senior at an A-tier company with a stated scale number; education is the soft spot.',
    top_evidence: ['Owned a 40k rps ingest service', 'Led a 4-person migration'],
  };
}

const factor = (score: number, note: string) => ({ score, note });

export function makeAnalysis() {
  return {
    schema_version: '1.1',
    input: { language: 'en', word_count_estimate: 640, parse_confidence: 0.96, is_resume: true, placeholders_seen: ['name', 'email', 'phone', 'url'] },
    card: makeCard(),
    education: [
      {
        institution: 'State University', institution_tier: 'T3', degree_level: 'bachelor', field: 'Computer Science', gpa: null, gpa_scale: null, gpa_band: 'not_listed',
        honors: ["Dean's List"], start_year: 2014, end_year: 2018, in_progress: false, notes: '',
      },
    ],
    experiences: [
      {
        org: 'Acme Cloud', org_type: 'private_company', org_tier: 'A', team_or_division: 'Core Infra', role: 'Senior Software Engineer', seniority: 'senior', employment_type: 'full_time',
        start: '2021-03', end: 'present', duration_months: 40, is_current: true, role_selectivity: 'selective',
        bullets_condensed: ['Owned ingest service, 40k rps, p99 120 ms', 'Led 4 engineers; migration cut cost 35%'], quantified_impact: true, impact_scale: 'org', ownership: 'led',
      },
      {
        org: 'Widgets Inc', org_type: 'private_company', org_tier: 'B', team_or_division: null, role: 'Software Engineer', seniority: 'mid', employment_type: 'full_time',
        start: '2018-06', end: '2021-02', duration_months: 33, is_current: false, role_selectivity: 'modest',
        bullets_condensed: ['Built billing pipeline, 2M invoices/month'], quantified_impact: true, impact_scale: 'team', ownership: 'owned_component',
      },
    ],
    projects: [{ name: 'loadgen', kind: 'software', description_condensed: 'Open-source load-testing tool', scale_signal: '1k stars', technical_depth: 'substantial', quantified_impact: true, has_external_validation: true }],
    publications: [],
    awards: [],
    skills: { technical: ['Go', 'Rust', 'Kubernetes', 'Postgres', 'Kafka', 'Terraform'], domain: ['Distributed systems'], certifications: [], spoken_languages: ['English'], keyword_stuffing_suspected: false },
    leadership: [{ org: 'Acme Cloud', role: 'Tech lead', people_led: 4, budget_or_scale: '4 engineers', elected_or_appointed: 'appointed', highlight: 'Led the ingest migration' }],
    signals: {
      years_fulltime: 6.5, months_internship: 0, career_stage: 'mid', highest_institution_tier: 'T3', highest_org_tier: 'A', sustained_org_tier: 'A', top_role_selectivity: 'selective',
      trajectory: 'accelerating', max_impact_scale: 'org', has_quantified_impact: true, primary_domain: 'tech',
    },
    category_relevance: { general: 1, finance: 0.1, tech: 0.82, academia: 0.05 },
    scores: {
      general: categoryScore([60, 70, 78, 64, 55], 74, 72),
      finance: categoryScore([30, 30, 30, 25, 20], 20, 22, false),
      tech: categoryScore([52, 70, 78, 86, 68], 74, 76),
      academia: categoryScore([20, 20, 15, 10, 10], 10, 12, false),
    },
    ats: {
      score: 88,
      factors: {
        parseability: factor(95, 'Single column, clean headings'),
        formatting: factor(90, 'Reverse chronological, consistent bullets'),
        quantification: factor(80, '7 of 9 bullets carry a number'),
        keyword_alignment: factor(85, 'Core infra competencies appear with outcomes'),
        length: factor(100, 'Two pages for a mid-career engineer'),
        consistency: factor(90, 'One date format'),
        contact_info: factor(85, 'Email, phone and link placeholders present'),
      },
      detected: {
        standard_headings: ['Experience', 'Education', 'Skills'], nonstandard_headings: [], section_order: ['Experience', 'Education', 'Skills'], date_formats_seen: ['YYYY'],
        date_format_consistent: true, reverse_chronological: true, bullet_count: 9, bullet_marker_consistent: true, quantified_bullet_ratio: 0.78, action_verb_ratio: 0.89,
        uses_tables_suspected: false, skill_bars_or_ratings: false, has_summary_section: false, has_email: true, has_phone: true, has_location: false, has_profile_link: true,
        has_street_address: false, contact_at_top: true,
      },
      target_role_used: 'Senior infrastructure engineer',
      fixes: [
        { priority: 'high', factor: 'keyword_alignment', issue: 'No observability tooling named', fix: 'Name the metrics and tracing stack in the ingest bullet' },
        { priority: 'medium', factor: 'quantification', issue: 'Billing bullet lacks an outcome', fix: 'Add the error rate or cost change the pipeline produced' },
        { priority: 'low', factor: 'contact_info', issue: 'No location given', fix: 'Add a city or region line under the name' },
      ],
    },
    strengths: ['Quantified results on 7 of 9 bullets', 'Promotion to senior within three years', 'Owned a system with named scale'],
    weaknesses: ['Education sits below the ladder median', 'No public or open-source work beyond one tool', 'No awards or publications'],
    red_flags: [],
    verdict: 'A strong mid-career infrastructure résumé whose numbers do the work; the education line is the only soft spot.',
    residual_pii: { name_suspected: false, email_count: 0, phone_count: 0, url_count: 0, street_address_suspected: false, other_identifiers: [] },
    analysis_confidence: 0.9,
  };
}
