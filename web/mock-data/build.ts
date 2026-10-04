// Hand-made mock dataset for VITE_MOCK=1 when fixtures/web-data is absent. Deterministic; follows the
// §3.3 / §10.1 shapes exactly and validates every document against the shared Zod mirrors.
// Run: node mock-data/build.ts (Node 24, native type stripping). Output: mock-data/{pages,raw}.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anonIdOf,
  ArenaPoolZ,
  CATEGORIES,
  computeCategoryScore,
  HistoryDocZ,
  jsonFileText,
  LADDER_COLS,
  PAGE_SIZE,
  plusMinus,
  RANK_KEY,
  recomputeAtsScore,
  ResumeAnalysisZ,
  ResumeDocZ,
  STAGES,
  StatusZ,
  TIERS,
  tierFor,
  UserDocZ,
  type AnchorsFile,
  type ArenaPair,
  type ArenaPool,
  type Card,
  type CareerStage,
  type Category,
  type HistoryDoc,
  type LadderMeta,
  type LadderPage,
  type LadderRowTuple,
  type Manifest,
  type PublicSettings,
  type PublicStatus,
  type RankEntry,
  type RankShard,
  type RankTuple,
  type ResumeAnalysis,
  type ResumeDoc,
  type UserDoc,
} from '@resumearena/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = here;
const fixturesAnchors = path.resolve(here, '..', '..', 'fixtures', 'anchors');

// ---- deterministic randomness ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261003);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;
const between = (lo: number, hi: number): number => lo + rng() * (hi - lo);
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SHARDS = ['k7', 'x6', 'a4', 'm2', 'p4', 'q6', 'r3', 'z5'];
const usedIds = new Set<string>();
function makeId(prefix?: string): string {
  for (;;) {
    let id = prefix ?? pick(SHARDS);
    while (id.length < 10) id += ALPHABET[Math.floor(rng() * 32)];
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}
const hex = (n: number): string => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');

const NOW = new Date('2026-10-03T14:20:11Z');
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const date = (d: Date): string => iso(d).slice(0, 10);

// ---- cards from the anchor fixtures -----------------------------------------------------------------

const cards: Record<Category, Card[]> = { general: [], finance: [], tech: [], academia: [] };
for (const cat of CATEGORIES) {
  const file = JSON.parse(readFileSync(path.join(fixturesAnchors, `${cat}.json`), 'utf8')) as AnchorsFile;
  cards[cat] = file.anchors.map((a) => a.card);
}
const allCards = CATEGORIES.flatMap((c) => cards[c]);

// ---- synthetic population ------------------------------------------------------------------------

interface Person {
  id: string;
  handle: string;
  visible: boolean;
  stage: CareerStage;
  sig: string;
  primary: Category;
  cats: Category[];
  ratings: Partial<Record<Category, { r: number; rd: number; g: number; w: number; l: number; d: number; placed: boolean; delta7: number | null; days: [string, number, number | null][] }>>;
  card: Card;
}

const FIRST = ['priya', 'marco', 'ling', 'amara', 'tomas', 'nadia', 'kenji', 'sofia', 'ravi', 'elena', 'omar', 'hana', 'jonas', 'mei', 'diego', 'zara', 'felix', 'ines', 'arjun', 'lea'];
const LAST = ['n', 'castellan', 'wu', 'okafor', 'berg', 'haddad', 'sato', 'reyes', 'iyer', 'petrova', 'said', 'kim', 'lind', 'chen', 'moreno', 'ali', 'bauer', 'costa', 'rao', 'dubois'];
const usedHandles = new Set<string>();
function makeHandle(): string {
  for (;;) {
    const h = `${pick(FIRST)}-${pick(LAST)}${rng() < 0.3 ? String(Math.floor(rng() * 90) + 10) : ''}`;
    if (!usedHandles.has(h)) {
      usedHandles.add(h);
      return h;
    }
  }
}

function makePerson(primary: Category, opts: { id?: string; handle?: string; visible?: boolean; placing?: boolean; card?: Card } = {}): Person {
  const card = opts.card ?? pick(allCards);
  const cats: Category[] = primary === 'general' ? ['general'] : ['general', primary];
  if (rng() < 0.25) {
    const extra = pick(CATEGORIES.filter((c) => !cats.includes(c)));
    cats.push(extra);
  }
  const p: Person = {
    id: opts.id ?? makeId(),
    handle: opts.handle ?? makeHandle(),
    visible: opts.visible ?? rng() < 0.45,
    stage: card.career_stage,
    sig: card.top_signal,
    primary,
    cats,
    ratings: {},
    card,
  };
  const base = Math.round(between(950, 2350));
  for (const c of cats) {
    const r = Math.round(base + between(-80, 80));
    const placed = !opts.placing;
    const g = placed ? Math.floor(between(8, 60)) : Math.floor(between(1, 7));
    const w = Math.floor(g * between(0.3, 0.7));
    const d = Math.floor((g - w) * between(0, 0.2));
    const l = g - w - d;
    const rd = placed ? Math.round(between(35, 120) * 10) / 10 : Math.round(between(150, 250) * 10) / 10;
    const days: [string, number, number | null][] = placed ? Array.from({ length: 8 }, (_, i) => [date(daysAgo(7 - i)), Math.round(r + between(-30, 30)), null]) : [];
    const delta7 = placed && days[0] ? Math.round(r - (days[0]?.[1] ?? r)) : null;
    p.ratings[c] = { r, rd, g, w, l, d, placed, delta7, days };
  }
  return p;
}

const people: Person[] = [];
// The four hand-picked documents.
const priya = makePerson('tech', { id: 'k7q2m3xw5a', handle: 'priya-n', visible: true, card: cards.tech[7]! });
const anonEntrant = makePerson('general', { id: 'x6ppa2a7mq', handle: 'm-castellan', visible: false, placing: true, card: cards.general[4]! });
people.push(priya, anonEntrant);
for (let i = 0; i < 128; i++) people.push(makePerson('general'));
for (const c of ['finance', 'tech', 'academia'] as const) for (let i = 0; i < 40; i++) people.push(makePerson(c));
usedIds.add('a4heldpiia');
usedIds.add('m2rejected');

// ---- ranks per category -------------------------------------------------------------------------------

const boards: Record<Category, Person[]> = { general: [], finance: [], tech: [], academia: [] };
for (const c of CATEGORIES) {
  boards[c] = people.filter((p) => p.ratings[c]?.placed).sort((a, b) => (b.ratings[c]?.r ?? 0) - (a.ratings[c]?.r ?? 0) || a.id.localeCompare(b.id));
}
const rankOf = (p: Person, c: Category): number | null => {
  const i = boards[c].indexOf(p);
  return i >= 0 ? i + 1 : null;
};

function tupleFor(p: Person, c: Category): RankTuple | undefined {
  const rt = p.ratings[c];
  if (!rt) return undefined;
  const rank = rankOf(p, c);
  const total = boards[c].length;
  const top = rank ? Math.round((rank / total) * 10000) / 10000 : null;
  const prevRank = rank ? Math.max(1, rank + Math.round(between(-3, 3))) : null;
  return [rank, total, Math.round(rt.r), rt.rd, rt.g, rt.w, rt.l, rt.d, rt.delta7, rt.placed ? 1 : 0, top, rank && prevRank ? prevRank - rank : null];
}

function rankEntry(p: Person): RankEntry {
  const e: RankEntry = { h: p.visible ? p.handle : null, v: p.visible ? 'handle' : 'anonymous', st: p.stage, sig: p.sig, p: p.primary };
  for (const c of CATEGORIES) {
    const t = tupleFor(p, c);
    if (t) e[RANK_KEY[c]] = t;
  }
  return e;
}

// ---- ladder pages ---------------------------------------------------------------------------------------

function ladderRow(p: Person, c: Category, rank: number): LadderRowTuple {
  const rt = p.ratings[c]!;
  const t = tupleFor(p, c)!;
  return [rank, p.id, p.visible ? p.handle : anonIdOf(p.id), tierFor(rt.r), Math.round(rt.r), plusMinus(rt.rd), rt.w, rt.l, rt.d, p.stage, p.sig, rt.delta7, t[10] ?? 1];
}

function paginate(rows: LadderRowTuple[], c: Category, partition: string): LadderPage[] {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  return Array.from({ length: rows.length === 0 ? 0 : pages }, (_, i) => ({
    schema: 1,
    category: c,
    partition,
    page: i + 1,
    pages,
    total: rows.length,
    cols: LADDER_COLS,
    rows: rows.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
  }));
}

// ---- analyses ------------------------------------------------------------------------------------

function analysisFromCard(card: Card, relevance: Record<Category, number>, stage: CareerStage): ResumeAnalysis {
  const sub = (base: number) => ({
    pedigree: clamp100(base + Math.round(between(-15, 15))),
    trajectory: clamp100(base + Math.round(between(-15, 15))),
    impact: clamp100(base + Math.round(between(-15, 15))),
    selectivity: clamp100(base + Math.round(between(-15, 15))),
    breadth: clamp100(base + Math.round(between(-15, 15))),
  });
  const base = 50 + Math.round(between(10, 35));
  const catScore = (c: Category) => {
    const included = c === 'general' || relevance[c] >= 0.35;
    return {
      included,
      sub_scores: sub(included ? base : base - 20),
      stage_relative_score: clamp100(base + Math.round(between(-10, 10))),
      holistic_score: clamp100(base + Math.round(between(-10, 10))),
      rationale: `${card.headline.split(';')[0]}; the ${c} weighting rewards the strongest lines on the card.`,
      top_evidence: card.experiences.slice(0, 2).flatMap((e) => e.highlights.slice(0, 1)),
    };
  };
  const factors = Object.fromEntries(['parseability', 'formatting', 'quantification', 'keyword_alignment', 'length', 'consistency', 'contact_info'].map((k) => [k, { score: clamp100(70 + Math.round(between(-20, 25))), note: `${k.replace(/_/g, ' ')} read cleanly from the text.` }]));
  const draft = {
    schema_version: '1.1',
    input: { language: 'en', word_count_estimate: 620, parse_confidence: 0.94, is_resume: true, placeholders_seen: ['name', 'email', 'phone', 'url'] },
    card,
    education: card.education.map((e) => ({ institution: e.institution, institution_tier: e.institution_tier, degree_level: e.degree_level, field: e.field, gpa: null, gpa_scale: null, gpa_band: e.gpa_band, honors: e.honors, start_year: e.end_year ? e.end_year - 4 : null, end_year: e.end_year, in_progress: e.in_progress, notes: '' })),
    experiences: card.experiences.map((e) => ({ org: e.org, org_type: 'private_company', org_tier: e.org_tier, team_or_division: null, role: e.role, seniority: e.seniority, employment_type: e.employment_type, start: e.years.split('-')[0] ?? null, end: e.years.split('-')[1] ?? null, duration_months: e.duration_months, is_current: e.years.endsWith('present'), role_selectivity: e.role_selectivity, bullets_condensed: e.highlights, quantified_impact: e.highlights.some((h) => /\d/.test(h)), impact_scale: e.impact_scale, ownership: 'owned_component' })),
    projects: card.projects.map((p) => ({ name: p.descriptor, kind: p.kind, description_condensed: p.highlight, scale_signal: p.scale_signal, technical_depth: p.technical_depth, quantified_impact: /\d/.test(p.highlight), has_external_validation: p.scale_signal !== 'none stated' })),
    publications: [],
    awards: card.awards.map((a) => ({ name: a.name, issuer: null, year: null, scope: a.scope, selectivity: a.selectivity, pool_estimate: 'unknown pool', verifiable: true })),
    skills: { technical: card.skills_top, domain: [], certifications: [], spoken_languages: ['English'], keyword_stuffing_suspected: false },
    leadership: card.leadership.map((l) => ({ org: l, role: 'lead', people_led: null, budget_or_scale: 'not stated', elected_or_appointed: 'unknown', highlight: l })),
    signals: { years_fulltime: card.years_fulltime, months_internship: 3, career_stage: stage, highest_institution_tier: card.education[0]?.institution_tier ?? 'unknown', highest_org_tier: card.experiences[0]?.org_tier ?? 'unknown', sustained_org_tier: card.experiences[0]?.org_tier ?? 'unknown', top_role_selectivity: card.experiences[0]?.role_selectivity ?? 'unknown', trajectory: 'steady', max_impact_scale: card.experiences[0]?.impact_scale ?? 'none', has_quantified_impact: true, primary_domain: 'other' },
    category_relevance: { general: 1, finance: relevance.finance, tech: relevance.tech, academia: relevance.academia },
    scores: { general: catScore('general'), finance: catScore('finance'), tech: catScore('tech'), academia: catScore('academia') },
    ats: {
      score: 0,
      factors,
      detected: { standard_headings: ['Experience', 'Education', 'Skills'], nonstandard_headings: [], section_order: ['Summary', 'Experience', 'Education', 'Skills'], date_formats_seen: ['MMM YYYY'], date_format_consistent: true, reverse_chronological: true, bullet_count: 14, bullet_marker_consistent: true, quantified_bullet_ratio: 0.64, action_verb_ratio: 0.86, uses_tables_suspected: false, skill_bars_or_ratings: false, has_summary_section: true, has_email: true, has_phone: true, has_location: false, has_profile_link: true, has_street_address: false, contact_at_top: true },
      target_role_used: 'Software engineer, mid-career',
      fixes: [
        { priority: 'high', factor: 'consistency', issue: 'Dates use "Jan 2023 – present"; two parsers read "present" as missing.', fix: 'Use an end month or "Present" consistently.' },
        { priority: 'medium', factor: 'formatting', issue: 'The skills section is a table.', fix: 'Export skills as plain lines, one group per line.' },
        { priority: 'low', factor: 'length', issue: 'The summary paragraph repeats the bullets.', fix: 'Cut the summary to one line with the strongest number.' },
      ],
    },
    strengths: ['Quantified results on 7 of 9 bullets', 'Two promotions in 4 years at the same employer', 'Owned a system with named scale (40k rps)'],
    weaknesses: ['Education sits below the ladder median for this tier', 'No open-source or public work listed', 'Summary paragraph repeats the bullets'],
    red_flags: [{ type: 'unverifiable_superlative', severity: 'medium', detail: '"Industry-leading" appears twice without a number behind it.', location: 'Experience / summary line' }],
    verdict: 'A strong mid-career infrastructure resume whose numbers do the work; the education line is the only soft spot.',
    residual_pii: { name_suspected: false, email_count: 0, phone_count: 0, url_count: 0, street_address_suspected: false, other_identifiers: [] },
    analysis_confidence: 0.86,
  };
  draft.ats.score = recomputeAtsScore(draft.ats.factors as unknown as Record<'parseability' | 'formatting' | 'quantification' | 'keyword_alignment' | 'length' | 'consistency' | 'contact_info', { score: number }>);
  const parsed = ResumeAnalysisZ.safeParse(draft);
  if (!parsed.success) throw new Error(`analysis invalid: ${parsed.error.message}`);
  return parsed.data;
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

const SAMPLE_TEXT = `[name]
[email] · [phone] · [url]

Summary
Infrastructure engineer with six years building and operating high-throughput services. Led the migration of a 40k rps edge service to a new runtime, cutting p99 latency by 38% and on-call pages by half.

Experience
Senior engineer, Acme Cloud, Jan 2022 – present
· Led migration of a 40k rps service to a new runtime; p99 latency down 38%, infrastructure cost down 22%
· Designed the capacity model used by four product teams; forecast error under 6% over 18 months
· Promoted twice in four years; mentor to five engineers, two of whom were promoted

Engineer, Northwind Fintech, Jun 2020 – Dec 2021
· Built the reconciliation pipeline for 2.1M daily transactions with a measured 99.98% match rate
· Cut nightly batch time from 6 hours to 70 minutes by rewriting the join strategy

Education
BS Computer Science, Large State University, 2020
Dean's list, 2018 – 2020

Skills
Go, Rust, Kubernetes, Terraform, PostgreSQL, Kafka, observability, capacity planning
`;

function resumeDoc(p: Person, status: ResumeDoc['status'], extra: Partial<ResumeDoc> = {}): ResumeDoc {
  const created = daysAgo(status === 'analyzed' && p.ratings.general?.placed ? 12 : 0.1);
  const relevance: Record<Category, number> = { general: 1, finance: p.cats.includes('finance') ? 0.7 : 0.1, tech: p.cats.includes('tech') ? 0.82 : 0.1, academia: p.cats.includes('academia') ? 0.66 : 0.05 };
  const analysis = analysisFromCard(p.card, relevance, p.stage);
  const scores: Partial<Record<Category, number>> = {};
  for (const c of p.cats) scores[c] = computeCategoryScore(c, analysis.scores[c]);
  const base: ResumeDoc = {
    schema: 1,
    id: p.id,
    kind: 'user',
    status,
    handle: p.handle,
    visibility: p.visible ? 'handle' : 'anonymous',
    owner_hash: hex(64),
    primary: p.primary,
    created_at: iso(created),
    updated_at: iso(new Date(created.getTime() + 160_000)),
    source: { kind: 'dispatch', run_id: 123456700, issue_number: null, client_version: 'mock.1' },
    text_sha256: hex(64),
    metrics: { source: 'pdf', pages: 2, columns_detected: 1, font_count: 3, image_count: 0, char_count: SAMPLE_TEXT.length, word_count: 212, extraction_quality: 0.96, redactions: { name: 1, email: 1, phone: 1, url: 1, address: 0, manual: 0 } },
    gate: { model: 'claude-haiku-4-5', prompt: 'gate.v1+1a2b3c4d', verdict: { is_resume: true, language: 'en', spam_or_abuse: false, prompt_injection_detected: false, estimated_career_stage: p.stage, reason: 'Two-page engineering résumé with dated roles.' } },
    held_reason: null,
    rejected_reason: null,
    duplicate_of: null,
    supersedes: null,
    superseded_by: null,
    deleted_at: null,
    versions: { analyst_model: 'claude-opus-5-5', analyst_prompt: 'analyst.v1+9e8f7a6b', gate_prompt: 'gate.v1+1a2b3c4d', schema: '1.1', taxonomy: '2026-10', fell_back: false },
    usage: { gate_usd: 0.0046, analysis_usd: 0.188, latency_ms: 61230 },
  };
  if (status === 'analyzed' || status === 'held') {
    base.analysis = analysis;
    base.card_sha256 = hex(64);
    base.category_relevance = relevance;
    base.scores = scores;
    base.stage = p.stage;
    base.top_signal = p.card.top_signal;
    if (status === 'analyzed') base.text = SAMPLE_TEXT;
  }
  const doc = { ...base, ...extra };
  const parsed = ResumeDocZ.safeParse(doc);
  if (!parsed.success) throw new Error(`resume doc invalid (${p.id}): ${parsed.error.message}`);
  return doc;
}

function historyDoc(p: Person, c: Category, opponents: Person[]): HistoryDoc {
  const rt = p.ratings[c]!;
  const points: HistoryDoc['points'] = [];
  let r = rt.r - 160;
  const start = 12;
  points.push([date(daysAgo(start)), Math.round(r), 220, 'p']);
  r += 90;
  points.push([date(daysAgo(start)), Math.round(r), 118, 'p']);
  for (let i = start - 1; i >= 0; i--) {
    r += between(-12, 18);
    points.push([date(daysAgo(i)), Math.round(r * 100) / 100, Math.round(Math.max(rt.rd, 40) * 10) / 10, i % 4 === 0 ? 's' : 'm']);
  }
  const last = points[points.length - 1];
  if (last) last[1] = rt.r;
  const recent: HistoryDoc['recent'] = Array.from({ length: Math.min(10, rt.g) }, (_, i) => {
    const opp = opponents[i % opponents.length]!;
    const o = pick(['W', 'W', 'L', 'D'] as const);
    return { m: hex(16), at: iso(new Date(NOW.getTime() - (i + 1) * 5_400_000)), o, opp: i === 3 ? 'anchrtgaaa' : opp.id, opp_r: Math.round(opp.ratings[c]?.r ?? 1500), dr: o === 'W' ? Math.round(between(4, 14)) : o === 'L' ? -Math.round(between(4, 14)) : 0, note: pick(['Broader ownership at the same company tier; the second record’s projects are smaller in scope.', 'First: owned a 40k rps migration with a p99 number. Second: strong A-tier record but smaller scope.', 'Second: first-author publication at a top venue. First: solid industry bullets without a comparable peak.', 'Close on pedigree; the first record’s sustained tier and quantified bullets decide it.']), k: i < 2 ? 'refine' : 'placement' };
  });
  const doc: HistoryDoc = { id: p.id, cat: c, lin: p.id, placed: rt.placed, points, recent };
  const parsed = HistoryDocZ.safeParse(doc);
  if (!parsed.success) throw new Error(`history invalid: ${parsed.error.message}`);
  return doc;
}

function arenaPool(c: Category): ArenaPool {
  const pool = boards[c].filter((p) => p.ratings[c]?.placed);
  const pairs: ArenaPair[] = [];
  for (let i = 0; i < 30 && pool.length >= 2; i++) {
    const a = pick(pool);
    let b = pick(pool);
    while (b === a) b = pick(pool);
    const w = pick(['A', 'A', 'B', 'B', 'draw'] as const);
    const delta = Math.round(between(4, 12));
    pairs.push({
      m: hex(16),
      at: iso(new Date(NOW.getTime() - i * 3_600_000)),
      kind: i % 5 === 0 ? 'crosscheck' : 'refine',
      a: { id: a.id, card: a.card, stage: a.stage, r_before: Math.round(a.ratings[c]?.r ?? 1500), delta: w === 'A' ? delta : w === 'B' ? -delta : 0 },
      b: { id: b.id, card: b.card, stage: b.stage, r_before: Math.round(b.ratings[c]?.r ?? 1500), delta: w === 'B' ? delta : w === 'A' ? -delta : 0 },
      w,
      c: Math.round(between(0.55, 0.9) * 100) / 100,
      reason: w === 'draw' ? 'A: deeper ownership of one system. B: broader record across two tiers. The passes split.' : `${w}: owned the larger system with a measured outcome. ${w === 'A' ? 'B' : 'A'}: a well-executed record inside a bigger team.`,
    });
  }
  const pool_ = { schema: 1 as const, category: c, updated_at: iso(NOW), pairs };
  const parsed = ArenaPoolZ.safeParse(pool_);
  if (!parsed.success) throw new Error(`arena invalid: ${parsed.error.message}`);
  return pool_;
}

// ---- write everything ---------------------------------------------------------------------------------

async function write(rel: string, value: unknown): Promise<void> {
  const file = path.join(out, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jsonFileText(value));
}

async function main(): Promise<void> {
  await rm(path.join(out, 'pages'), { recursive: true, force: true });
  await rm(path.join(out, 'raw'), { recursive: true, force: true });

  const buildId = '412345678.1';
  const manifest: Manifest = {
    schema: 1,
    build_id: buildId,
    built_at: iso(NOW),
    data_sha: hex(40),
    commit: hex(40),
    counts: { resumes: people.length + 2, rated: { general: boards.general.length, finance: boards.finance.length, tech: boards.tech.length, academia: boards.academia.length }, matches: 23456, users: people.length },
    page_size: PAGE_SIZE,
    partitions: ['all', ...STAGES.map((s) => `stage-${s}`)],
    pages: { general: Math.ceil(boards.general.length / PAGE_SIZE), finance: 1, tech: 1, academia: 1 },
  };

  for (const c of CATEGORIES) {
    const all = boards[c].map((p, i) => ladderRow(p, c, i + 1));
    for (const page of paginate(all, c, 'all')) await write(`pages/ladder/${c}/all/${page.page}.json`, page);
    const stages = {} as LadderMeta['stages'];
    for (const s of STAGES) {
      const rows = boards[c].filter((p) => p.stage === s).map((p, i) => ladderRow(p, c, i + 1));
      const pages = paginate(rows, c, `stage-${s}`);
      for (const page of pages) await write(`pages/ladder/${c}/stage-${s}/${page.page}.json`, page);
      stages[s] = { total: rows.length, pages: pages.length };
    }
    const meta: LadderMeta = {
      category: c,
      total: all.length,
      pages: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
      page_size: PAGE_SIZE,
      updated_at: iso(NOW),
      stages,
      medians: all.length >= 20 ? { pedigree: 58, trajectory: 64, impact: 61, selectivity: 60, breadth: 55, stage_relative: 62 } : null,
    };
    await write(`pages/ladder/${c}/meta.json`, meta);
    await write(`pages/arena/${c}.json`, arenaPool(c));
  }

  const shards = new Map<string, RankShard>();
  for (const p of people) {
    const ab = p.id.slice(0, 2);
    const shard = shards.get(ab) ?? {};
    shard[p.id] = rankEntry(p);
    shards.set(ab, shard);
  }
  for (const [ab, shard] of shards) await write(`pages/rank/${ab}.json`, shard);

  const status: PublicStatus = {
    schema: 1,
    updated_at: iso(NOW),
    paused: false,
    budget: { day: date(NOW), daily_usd: 25, spent_usd: 7.12, analysis_usd: 3.9, refine_spent_usd: 1.9, exhausted: false, hard_stopped: false },
    queue: { placement: 3, analysis: 1, delete: 0, oldest_queued_at: iso(new Date(NOW.getTime() - 450_000)) },
    last_rerank: { run_id: 123456789, at: iso(new Date(NOW.getTime() - 11_000)), trigger: 'workflow_run', waves: 4, matches: 42, placements_completed: 3, duration_s: 311, changed: true, state: 'ok' },
    last_submission_at: iso(new Date(NOW.getTime() - 549_000)),
    last_deploy_requested_at: iso(new Date(NOW.getTime() - 1_000)),
    deploy_pending: false,
    counts: { resumes: people.length + 2, analyzed: people.length, rated: boards.general.length, placing: people.length - boards.general.length, queued: 1, held: 1, needs_review: 0, rejected: 1, duplicate: 0, superseded: 0, deleted: 0, users: people.length, matches: 23456, anchors: 48 },
    per_category: {
      general: { rated: boards.general.length, mean: 1512, sd: 196, anchor_residual_7d: 0.012, anchor_n_7d: 210, anchor_accuracy_7d: 0.91, disagreement_rate_7d: 0.21 },
      finance: { rated: boards.finance.length, mean: 1498, sd: 188, anchor_residual_7d: -0.03, anchor_n_7d: 44, anchor_accuracy_7d: 0.88, disagreement_rate_7d: 0.24 },
      tech: { rated: boards.tech.length, mean: 1520, sd: 201, anchor_residual_7d: 0.004, anchor_n_7d: 120, anchor_accuracy_7d: 0.93, disagreement_rate_7d: 0.19 },
      academia: { rated: boards.academia.length, mean: 1490, sd: 210, anchor_residual_7d: 0.051, anchor_n_7d: 31, anchor_accuracy_7d: 0.86, disagreement_rate_7d: 0.27 },
    },
    health: { judge_healthy: true, schedule_enabled: true, token_expires: '2027-10-01', submissions_last_hour: 4, failed_runs_24h: 1, cancelled_runs_24h: 0, issue_path_24h: 0, dispatch_path_24h: 96, alerts: [] },
    versions: { engine: '0.1.0', gate_prompt: 'gate.v1+1a2b3c4d', analyst_prompt: 'analyst.v1+9e8f7a6b', judge_prompt: 'judge.v1+5c4d3e2f', schema: '1.1', taxonomy: '2026-10' },
    deployed_at: iso(NOW),
    build_id: buildId,
  };
  const statusCheck = StatusZ.safeParse(status);
  if (!statusCheck.success) throw new Error(`status invalid: ${statusCheck.error.message}`);
  await write('pages/status.json', status);

  const settings: PublicSettings = {
    tiers: [...TIERS],
    provisional_blurb: 'Not yet placed. The rating is a guess until placement finishes.',
    paused: false,
    pause_message: '',
    limits: { min_chars: 400, max_chars: 15000, max_file_bytes: 10485760, max_submissions_per_hour: 20 },
    models: { gate: 'claude-haiku-4-5', analyst: 'claude-opus-5-5', judge: 'claude-sonnet-5-5', analyst_effort: 'high', judge_effort: 'low' },
    versions: status.versions,
    categories: [...CATEGORIES],
    stages: [...STAGES],
  };
  await write('pages/settings.json', settings);
  await write('pages/manifest.json', manifest);

  // Raw documents: the two hand-picked analyzed entries, one held, one rejected, plus docs for the first ladder page
  // so profile links resolve.
  const rawPeople = [priya, anonEntrant, ...boards.general.slice(0, 12)];
  for (const p of rawPeople) {
    const doc = resumeDoc(p, 'analyzed');
    await write(`raw/resumes/${p.id.slice(0, 2)}/${p.id}.json`, doc);
    const user: UserDoc = { schema: 1, handle: p.handle, owner_hash: doc.owner_hash, created_at: doc.created_at, state: 'active', key_exposed: false, resumes: [{ id: p.id, created_at: doc.created_at, current: true }] };
    const uc = UserDocZ.safeParse(user);
    if (!uc.success) throw new Error(`user invalid: ${uc.error.message}`);
    await write(`raw/users/${p.handle.slice(0, 2)}/${p.handle}.json`, user);
    for (const c of p.cats) {
      if (!p.ratings[c]) continue;
      const opponents = boards[c].filter((o) => o !== p).slice(0, 6);
      await write(`raw/history/${c}/${p.id.slice(0, 2)}/${p.id}.json`, historyDoc(p, c, opponents));
    }
  }
  const heldPerson = makePerson('general', { id: 'a4heldpiia', handle: 'held-example', visible: false, card: cards.general[2]! });
  const held = resumeDoc(heldPerson, 'held', { held_reason: 'pii' });
  delete held.text;
  await write(`raw/resumes/a4/${held.id}.json`, held);
  const rejectedPerson = makePerson('general', { id: 'm2rejected', handle: 'rejected-example', visible: false, card: cards.general[1]! });
  const rejected: ResumeDoc = { schema: 1, id: rejectedPerson.id, kind: 'user', status: 'rejected', rejected_reason: 'not_a_resume', handle: rejectedPerson.handle, owner_hash: hex(64), visibility: 'anonymous', primary: 'general', created_at: iso(daysAgo(1)), updated_at: iso(daysAgo(1)), source: { kind: 'dispatch', run_id: 123456701, issue_number: null, client_version: 'mock.1' }, text_sha256: hex(64) };
  const rc = ResumeDocZ.safeParse(rejected);
  if (!rc.success) throw new Error(`rejected invalid: ${rc.error.message}`);
  await write(`raw/resumes/m2/${rejected.id}.json`, rejected);

  console.log(`mock data written: ${people.length} people, ${shards.size} rank shards, ${rawPeople.length + 2} raw docs`);
}

await main();
