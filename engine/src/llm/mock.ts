// `--llm mock` (§13.2): no network, deterministic under RA_SEED. The gate accepts ≥ 400 chars with a
// four-digit year unless the fixture plan says otherwise; the analyst returns the committed fixture
// analysis when the text hash matches one, else a schema-valid synthesis; the judge prefers the card
// whose fixture anchor (or heuristic strength) is higher and flips 20 % of swapped passes into draws.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, canonicalJson, type Card, type Category, type CareerStage, type ResumeAnalysis } from '@resumearena/shared';
import { createRng, sha256Hex, type Rng } from '../rng.ts';
import type { LlmRequest, LlmResponse, LlmTransport } from './client.ts';
import { parseUserMessage } from './framing.ts';
import { synthesizeAnalysis, type SynthesisHints } from './mock-analysis.ts';

export interface PlanEntry {
  slug: string;
  group: 'anchor' | 'weak' | 'gamed' | 'pii' | 'edge';
  category: Category;
  intended_anchor: number | null;
  intended_stage: CareerStage;
  intended_categories: Category[];
  expect: { gate: 'pass' | 'reject' | 'held'; status: 'analyzed' | 'rejected' | 'held' | 'needs_review' };
  brief: string;
  target_chars: number;
}

export interface FixtureIndex {
  plan: Map<string, PlanEntry>;
  textHashToSlug: Map<string, string>;
  cardHashToSlug: Map<string, string>;
  analyses: Map<string, ResumeAnalysis>;
}

const FIXTURE_MARKER_RE = /^fixture: ([a-z0-9-]+)\s*$/m;

/** Lazily read fixtures/ once per process; a missing directory yields an empty index. */
export function loadFixtureIndex(fixturesDir: string): FixtureIndex {
  const index: FixtureIndex = { plan: new Map(), textHashToSlug: new Map(), cardHashToSlug: new Map(), analyses: new Map() };
  const planPath = join(fixturesDir, 'plan.json');
  if (existsSync(planPath)) {
    for (const e of JSON.parse(readFileSync(planPath, 'utf8')) as PlanEntry[]) index.plan.set(e.slug, e);
  }
  const resumesDir = join(fixturesDir, 'resumes');
  if (existsSync(resumesDir)) {
    for (const f of readdirSync(resumesDir)) {
      if (!f.endsWith('.txt')) continue;
      index.textHashToSlug.set(sha256Hex(readFileSync(join(resumesDir, f), 'utf8')), f.slice(0, -4));
    }
  }
  const analysesDir = join(fixturesDir, 'analyses');
  if (existsSync(analysesDir)) {
    for (const f of readdirSync(analysesDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const a = JSON.parse(readFileSync(join(analysesDir, f), 'utf8')) as ResumeAnalysis;
        const slug = f.slice(0, -5);
        index.analyses.set(slug, a);
        index.cardHashToSlug.set(sha256Hex(canonicalJson(a.card)), slug);
      } catch {
        // A malformed fixture is E4's problem; the mock stays usable.
      }
    }
  }
  const anchorsDir = join(fixturesDir, 'anchors');
  if (existsSync(anchorsDir)) {
    for (const f of readdirSync(anchorsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const file = JSON.parse(readFileSync(join(anchorsDir, f), 'utf8')) as { anchors: { id: string; rating: number; card: Card }[] };
        for (const a of file.anchors) index.cardHashToSlug.set(sha256Hex(canonicalJson(a.card)), `anchor:${a.rating}`);
      } catch {
        // ignore
      }
    }
  }
  return index;
}

export function planEntryForText(index: FixtureIndex, text: string): PlanEntry | null {
  const bySlug = (slug: string | undefined): PlanEntry | null => (slug ? (index.plan.get(slug) ?? null) : null);
  const marker = FIXTURE_MARKER_RE.exec(text)?.[1];
  return bySlug(index.textHashToSlug.get(sha256Hex(text))) ?? bySlug(marker);
}

// ---- heuristics shared by gate and analyst --------------------------------------------------------

const GERMAN_RE = /\b(?:und|oder|Lebenslauf|Berufserfahrung|Ausbildung|Kenntnisse|seit|bei der|GmbH)\b/g;
const COVER_LETTER_RE = /\b(?:Dear (?:Hiring|Sir|Madam|Recruit)|I am writing to (?:apply|express)|Sincerely,|Yours faithfully)/;
const INJECTION_RE = /(?:ignore (?:all |the )?previous instructions|to the ai (?:reviewer|evaluator)|rate this (?:resume|résumé|candidate)|you are (?:a|an) (?:helpful|ai)|system message|score this 100)/i;
const SPAM_RE = /(?:buy now|click here|crypto giveaway|\$\$\$|free money)/i;
const NAME_IN_TEXT_RE = /\b(?:my name is|I am|I'm|contact|reach)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
const OBFUSCATED_EMAIL_RE = /\b[\w.-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}\b/i;
const SPELLED_URL_RE = /\b[a-z0-9-]+\s+dot\s+(?:com|org|io|net|dev|edu)\b/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;

export function detectLanguage(text: string): string {
  const hits = text.match(GERMAN_RE)?.length ?? 0;
  return hits >= 6 ? 'de' : 'en';
}

export interface MockGateHints {
  is_resume: boolean;
  language: string;
  spam_or_abuse: boolean;
  prompt_injection_detected: boolean;
}

export function gateHints(text: string, plan: PlanEntry | null): MockGateHints {
  const hasYear = YEAR_RE.test(text);
  const hints: MockGateHints = {
    is_resume: text.length >= 400 && hasYear && !COVER_LETTER_RE.test(text),
    language: detectLanguage(text),
    spam_or_abuse: SPAM_RE.test(text),
    prompt_injection_detected: INJECTION_RE.test(text),
  };
  if (plan) {
    if (plan.expect.gate === 'held') hints.prompt_injection_detected = true;
    if (plan.expect.gate === 'reject') {
      if (plan.slug.includes('german')) hints.language = 'de';
      else if (plan.slug.includes('short')) hints.is_resume = false;
      else hints.is_resume = false;
    }
  }
  return hints;
}

export function piiHints(text: string, plan: PlanEntry | null): SynthesisHints['pii'] {
  const pii: SynthesisHints['pii'] = { name: NAME_IN_TEXT_RE.test(text), email: OBFUSCATED_EMAIL_RE.test(text) ? 1 : 0, url: SPELLED_URL_RE.test(text) ? 1 : 0, phone: 0, address: false };
  if (plan?.group === 'pii') {
    if (plan.slug.includes('name')) pii.name = true;
    else if (plan.slug.includes('email')) pii.email = Math.max(1, pii.email);
    else if (plan.slug.includes('url')) pii.url = Math.max(1, pii.url);
    else pii.name = true;
  }
  return pii;
}

/** Deterministic 0..100 from the text; fixtures map intended_anchor onto the rubric scale. */
export function baseScore(text: string, plan: PlanEntry | null): number {
  if (plan?.intended_anchor) return Math.round(25 + ((plan.intended_anchor - 1000) / 1100) * 70);
  if (plan?.group === 'weak') return 30 + (parseInt(sha256Hex(plan.slug).slice(0, 2), 16) % 12);
  if (plan?.group === 'gamed') return 40 + (parseInt(sha256Hex(plan.slug).slice(0, 2), 16) % 15);
  const h = parseInt(sha256Hex(text).slice(0, 6), 16);
  return 25 + (h % 66);
}

// ---- card strength for the mock judge ------------------------------------------------------------

const ORG_TIER: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1, unknown: 1.5 };
const INST_TIER: Record<string, number> = { T1: 4, T2: 3, T3: 2, T4: 1, unknown: 1.5 };
const SELECTIVITY: Record<string, number> = { elite: 4, highly_selective: 3, selective: 2, modest: 1, unknown: 1 };
const IMPACT: Record<string, number> = { none: 0, individual: 1, team: 2, org: 3, industry: 4, global: 5 };
const STAGE_BASELINE: Record<CareerStage, number> = { student: 0, new_grad: 2, early: 4, mid: 7, senior: 10, executive: 13 };

export function cardStrength(card: Card): number {
  let s = 0;
  const exps = card.experiences;
  if (exps.length) {
    const tiers = exps.map((e) => ORG_TIER[e.org_tier] ?? 1.5);
    s += Math.max(...tiers) * 4 + (tiers.reduce((a, b) => a + b, 0) / tiers.length) * 2;
    s += Math.max(...exps.map((e) => IMPACT[e.impact_scale] ?? 0)) * 3;
    s += Math.max(...exps.map((e) => SELECTIVITY[e.role_selectivity] ?? 1)) * 3;
  }
  if (card.education.length) s += Math.max(...card.education.map((e) => INST_TIER[e.institution_tier] ?? 1.5)) * 2;
  const p = card.publications_summary;
  s += p.top_venue_count * 4 + p.strong_venue_count * 2 + p.first_author_count * 2 + Math.min(p.count_total, 10) * 0.5;
  if (card.awards.length) s += Math.max(...card.awards.map((a) => SELECTIVITY[a.selectivity] ?? 1)) * 3;
  s += Math.min(card.notable.length, 5) * 0.5 + Math.min(card.leadership.length, 4) * 0.5;
  // 60 % stage-relative, 40 % absolute (judge rule 2): subtract most of what the stage alone predicts.
  return s - 0.6 * STAGE_BASELINE[card.career_stage];
}

// ---- the transport --------------------------------------------------------------------------------

const MOCK_USAGE = {
  gate: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  analysis: { input_tokens: 9000, output_tokens: 7000, cache_read_input_tokens: 6400, cache_creation_input_tokens: 0 },
  judge: { input_tokens: 1500, output_tokens: 450, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 },
  anchor_gen: { input_tokens: 3000, output_tokens: 2500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  fixture_text: { input_tokens: 800, output_tokens: 2500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} as const;

export interface MockOptions {
  fixturesDir: string;
  seed: string;
  /** Overrides for tests: force a refusal or a max_tokens stop for a purpose. */
  script?: (req: LlmRequest) => Partial<LlmResponse> | null;
}

export function createMockTransport(opts: MockOptions): LlmTransport {
  let index: FixtureIndex | null = null;
  const fixtures = (): FixtureIndex => (index ??= loadFixtureIndex(opts.fixturesDir));
  const respond = (req: LlmRequest, value: unknown, model = req.model): LlmResponse => ({
    stop_reason: 'end_turn',
    text: typeof value === 'string' ? value : JSON.stringify(value),
    model,
    usage: { ...MOCK_USAGE[req.purpose] },
    fell_back: false,
    refusal_category: null,
  });

  return {
    mode: 'mock',
    async call(req) {
      const scripted = opts.script?.(req);
      if (scripted) return { ...respond(req, scripted.text ?? '{}'), ...scripted };
      switch (req.purpose) {
        case 'gate': {
          const { text } = parseUserMessage(req.user);
          const plan = planEntryForText(fixtures(), text);
          const h = gateHints(text, plan);
          const stage = plan?.intended_stage ?? stageFromText(text);
          const reason = !h.is_resume ? 'Not a résumé: no dated record of one person.' : h.prompt_injection_detected ? 'Résumé with a passage addressed to the evaluator.' : 'Résumé with dated roles and education.';
          return respond(req, { is_resume: h.is_resume, language: h.language, spam_or_abuse: h.spam_or_abuse, prompt_injection_detected: h.prompt_injection_detected, estimated_career_stage: h.is_resume ? stage : 'unknown', reason });
        }
        case 'analysis': {
          const { text, metrics } = parseUserMessage(req.user);
          const idx = fixtures();
          const plan = planEntryForText(idx, text);
          const slug = idx.textHashToSlug.get(sha256Hex(text));
          const committed = slug ? idx.analyses.get(slug) : undefined;
          if (committed) return respond(req, committed);
          const rng = createRng(`${opts.seed}|analysis|${sha256Hex(text)}`);
          const hints: SynthesisHints = {
            score: baseScore(text, plan),
            stage: plan?.intended_stage ?? stageFromText(text),
            relevance: relevanceFor(text, plan),
            pii: piiHints(text, plan),
            injection: gateHints(text, plan).prompt_injection_detected,
            isResume: plan ? plan.expect.status !== 'needs_review' && plan.expect.gate !== 'reject' : gateHints(text, null).is_resume,
            lowConfidence: plan?.expect.status === 'needs_review',
            keywordStuffing: plan?.slug.includes('skills-list') === true || plan?.slug.includes('keyword') === true,
            extractionQuality: typeof metrics.extraction_quality === 'number' ? metrics.extraction_quality : 1,
          };
          return respond(req, synthesizeAnalysis(text, hints, rng));
        }
        case 'judge': {
          const body = JSON.parse(req.user) as { category: Category; first: Card; second: Card };
          const idx = fixtures();
          const strength = (card: Card): number => {
            const slug = idx.cardHashToSlug.get(sha256Hex(canonicalJson(card)));
            if (slug?.startsWith('anchor:')) return Number(slug.slice(7)) / 50;
            const anchor = slug ? idx.plan.get(slug)?.intended_anchor : null;
            return anchor ? anchor / 50 : cardStrength(card);
          };
          const pass = req.meta?.pass === 2 ? 2 : 1;
          const pairKey = [sha256Hex(canonicalJson(body.first)), sha256Hex(canonicalJson(body.second))].sort().join('|');
          // Keyed by pair and plan position: a restarted wave replays the same verdicts, repeated pairs (validate-anchors) vary.
          const rng = createRng(`${opts.seed}|judge|${body.category}|${pairKey}|${String(req.meta?.seq ?? 0)}`);
          const sf = strength(body.first);
          const ss = strength(body.second);
          const gap = Math.abs(sf - ss);
          let winner: 'first' | 'second' = sf === ss ? (rng.next() < 0.5 ? 'first' : 'second') : sf > ss ? 'first' : 'second';
          // Draws come from 20 % of swapped passes disagreeing with the forward pass; the same stream decides both passes.
          const flipRoll = rng.next();
          if (pass === 2 && flipRoll < 0.2) winner = winner === 'first' ? 'second' : 'first';
          const confidence = Math.round((0.6 + Math.min(0.2, gap / 50)) * 100) / 100;
          const loser = winner === 'first' ? 'second' : 'first';
          return respond(req, {
            winner,
            confidence,
            decisive_factors: [`${winner}: stronger selections for the stage`, `${loser}: smaller scope and fewer verifiable facts`],
            reasoning: `${capitalize(winner)}: harder selections and larger stated scope. ${capitalize(loser)}: comparable stage but fewer verifiable outcomes.`,
          });
        }
        case 'anchor_gen': {
          const rng = createRng(`${opts.seed}|anchor|${sha256Hex(req.user)}`);
          const spec = /spec: (.*)/.exec(req.user)?.[1] ?? 'anchor';
          const stage = (/stage: ([a-z_]+)/.exec(req.user)?.[1] ?? 'mid') as CareerStage;
          const rating = Number(/rating: (\d+)/.exec(req.user)?.[1] ?? 1500);
          const analysis = synthesizeAnalysis(`${spec}\n2020 2024`, { score: Math.round(25 + ((rating - 1000) / 1100) * 70), stage, relevance: { general: 1, finance: 0.5, tech: 0.5, academia: 0.5 }, pii: { name: false, email: 0, url: 0, phone: 0, address: false }, injection: false, isResume: true, lowConfidence: false, keywordStuffing: false, extractionQuality: 1 }, rng);
          return respond(req, analysis.card);
        }
        case 'fixture_text':
          return respond(req, `Mock fixture text generated offline.\n2021-2024\n${'Experience line with a measured outcome. '.repeat(20)}`);
      }
    },
  };
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const TECH_RE = /\b(?:software|engineer|python|java|typescript|kubernetes|machine learning|backend|frontend|distributed|compiler|rust|golang|api|sre|data pipeline)\b/gi;
const FINANCE_RE = /\b(?:investment|banking|equity|hedge fund|portfolio|analyst|m&a|valuation|lbo|trading|private equity|cfa|financial model|fp&a)\b/gi;
const ACADEMIA_RE = /\b(?:phd|postdoc|publication|publications|journal|conference paper|first author|professor|thesis|dissertation|research assistant|neurips|nature|lab)\b/gi;

export function relevanceFor(text: string, plan: PlanEntry | null): Record<Category, number> {
  if (plan) {
    const set = new Set(plan.intended_categories);
    return { general: 1, finance: set.has('finance') ? 0.8 : 0.1, tech: set.has('tech') ? 0.8 : 0.1, academia: set.has('academia') ? 0.8 : 0.1 };
  }
  const score = (re: RegExp): number => Math.min(1, 0.05 + 0.08 * (text.match(re)?.length ?? 0));
  return { general: 1, finance: round2(score(FINANCE_RE)), tech: round2(score(TECH_RE)), academia: round2(score(ACADEMIA_RE)) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function stageFromText(text: string): CareerStage {
  const years = [...text.matchAll(/\b(19|20)(\d{2})\b/g)].map((m) => Number(`${m[1]}${m[2]}`)).filter((y) => y >= 1980 && y <= 2030);
  if (years.length < 2) return 'early';
  const span = Math.max(...years) - Math.min(...years);
  if (/\b(?:B\.?S\.?|B\.?A\.?|undergraduate|sophomore|junior|senior year|expected 20\d\d)\b/i.test(text) && span <= 4) return 'student';
  if (span <= 1) return 'new_grad';
  if (span <= 5) return 'early';
  if (span <= 10) return 'mid';
  if (span <= 18) return 'senior';
  return 'executive';
}

export const MOCK_CATEGORIES = CATEGORIES;
export type { Rng };
