import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANALYSIS_SCHEMA, GATE_SCHEMA, JUDGE_SCHEMA } from '../src/schemas/index.ts';
import { CAREER_STAGES, CardZ, ResumeAnalysisZ, parseCard, parseResumeAnalysis, topSignalFromHeadline } from '../src/schemas/analysis.ts';
import { GateVerdictZ, parseGateVerdict } from '../src/schemas/gate.ts';
import { PairwiseVerdictZ, parsePairwiseVerdict } from '../src/schemas/judge.ts';
import { LayoutMetricsZ, RowEntryZ, SettingsZ, StatusZ } from '../src/schemas/data.ts';
import { truncateAtWord } from '../src/schemas/repair.ts';
import { DEFAULT_SETTINGS } from '../src/constants.ts';
import { CATEGORIES, STAGES } from '../src/types.ts';
import { makeAnalysis, makeCard } from './helpers/analysis-fixture.ts';

// ---- JSON schema ↔ Zod structural agreement -------------------------------------------------------
type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; $ref?: string; anyOf?: JsonSchema[]; enum?: string[]; const?: unknown; $defs?: Record<string, JsonSchema> };

function deref(node: JsonSchema, root: JsonSchema): JsonSchema {
  if (!node.$ref) return node;
  const name = node.$ref.replace('#/$defs/', '');
  const target = root.$defs?.[name];
  if (!target) throw new Error(`unresolved $ref ${node.$ref}`);
  return deref(target, root);
}

/** Peel transforms, defaults, nullables and the like until an object / array / enum is exposed. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s: unknown = schema;
  for (;;) {
    const def = (s as unknown as { def: Record<string, unknown> & { type: string } }).def;
    if (def.type === 'pipe') s = def.in;
    else if (def.type === 'nullable' || def.type === 'optional' || def.type === 'default' || def.type === 'catch' || def.type === 'readonly') s = def.innerType;
    else return s as z.ZodType;
  }
}

function compare(json: JsonSchema, zod: z.ZodType, path: string, root: JsonSchema, problems: string[]): void {
  const node = deref(json, root);
  const zs = unwrap(zod);
  const def = (zs as unknown as { def: Record<string, unknown> & { type: string } }).def;
  if (node.anyOf) {
    const nonNull = node.anyOf.find((x) => x.type !== 'null');
    if (nonNull) compare(nonNull, zs, path, root, problems);
    return;
  }
  if (node.enum) {
    const options = (zs as unknown as { options?: string[] }).options;
    if (!options) problems.push(`${path}: json enum but zod ${def.type}`);
    else if ([...options].sort().join('|') !== [...node.enum].sort().join('|')) problems.push(`${path}: enum mismatch ${options.join(',')} vs ${node.enum.join(',')}`);
    return;
  }
  if (node.type === 'object') {
    if (def.type !== 'object') return void problems.push(`${path}: json object but zod ${def.type}`);
    const shape = def.shape as Record<string, z.ZodType>;
    const jsonKeys = Object.keys(node.properties ?? {}).sort();
    const zodKeys = Object.keys(shape).sort();
    if (jsonKeys.join(',') !== zodKeys.join(',')) problems.push(`${path}: keys ${jsonKeys.join(',')} vs ${zodKeys.join(',')}`);
    if ([...(node.required ?? [])].sort().join(',') !== jsonKeys.join(',')) problems.push(`${path}: required != properties`);
    for (const k of jsonKeys) if (shape[k]) compare(node.properties![k]!, shape[k]!, `${path}.${k}`, root, problems);
    return;
  }
  if (node.type === 'array') {
    if (def.type !== 'array') return void problems.push(`${path}: json array but zod ${def.type}`);
    compare(node.items!, def.element as z.ZodType, `${path}[]`, root, problems);
    return;
  }
  const expectZod: Record<string, string[]> = { string: ['string', 'literal'], number: ['number', 'literal'], integer: ['number'], boolean: ['boolean'] };
  if (node.type && expectZod[node.type] && !expectZod[node.type]!.includes(def.type)) problems.push(`${path}: json ${node.type} but zod ${def.type}`);
  if (node.const !== undefined && def.type !== 'literal' && def.type !== 'number') problems.push(`${path}: const without literal`);
}

describe('JSON schemas and Zod mirrors agree', () => {
  it('analysis', () => {
    const problems: string[] = [];
    compare(ANALYSIS_SCHEMA as JsonSchema, ResumeAnalysisZ, 'analysis', ANALYSIS_SCHEMA as JsonSchema, problems);
    expect(problems).toEqual([]);
  });
  it('gate and judge', () => {
    const problems: string[] = [];
    compare(GATE_SCHEMA as JsonSchema, GateVerdictZ, 'gate', GATE_SCHEMA as JsonSchema, problems);
    compare(JUDGE_SCHEMA as JsonSchema, PairwiseVerdictZ, 'judge', JUDGE_SCHEMA as JsonSchema, problems);
    expect(problems).toEqual([]);
  });
  it('schemas carry no unsupported keywords and every object is closed', () => {
    const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];
    const walk = (n: unknown, path: string, out: string[]) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`, out));
      const o = n as Record<string, unknown>;
      for (const k of banned) if (k in o) out.push(`${path}.${k}`);
      if (o.type === 'object' && o.additionalProperties !== false) out.push(`${path}.additionalProperties`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, out);
    };
    for (const [name, s] of [['analysis', ANALYSIS_SCHEMA], ['gate', GATE_SCHEMA], ['judge', JUDGE_SCHEMA]] as const) {
      const out: string[] = [];
      walk(s, name, out);
      expect(out).toEqual([]);
    }
  });
  it('enums match the shared constants', () => {
    expect([...CAREER_STAGES]).toEqual([...STAGES]);
    expect(Object.keys((ANALYSIS_SCHEMA as JsonSchema).properties!.category_relevance!.properties!).sort()).toEqual([...CATEGORIES].sort());
  });
});

// ---- repairs --------------------------------------------------------------------------------------
describe('ResumeAnalysisZ', () => {
  it('accepts the fixture without repairs', () => {
    const r = parseResumeAnalysis(makeAnalysis());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repairs).toBe(0);
    expect(r.value).toEqual(makeAnalysis());
  });
  it('clamps, truncates and slices while counting repairs', () => {
    const a = makeAnalysis();
    a.scores.tech.sub_scores.impact = 120;
    a.scores.general.stage_relative_score = -5;
    a.category_relevance.tech = 1.4;
    a.verdict = 'word '.repeat(50);
    a.strengths = Array.from({ length: 7 }, (_, i) => `strength ${i}`);
    a.ats.fixes = Array.from({ length: 9 }, () => a.ats.fixes[0]!);
    a.card.experiences = Array.from({ length: 8 }, () => a.card.experiences[0]!);
    a.card.top_signal = 'first-author NeurIPS best paper award';
    const r = parseResumeAnalysis(a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scores.tech.sub_scores.impact).toBe(100);
    expect(r.value.scores.general.stage_relative_score).toBe(0);
    expect(r.value.category_relevance.tech).toBe(1);
    expect(r.value.verdict.length).toBeLessThanOrEqual(160);
    expect(r.value.verdict.endsWith('word')).toBe(true);
    expect(r.value.strengths).toHaveLength(5);
    expect(r.value.ats.fixes).toHaveLength(7);
    expect(r.value.card.experiences).toHaveLength(6);
    expect(r.value.card.top_signal).toBe('first-author');
    expect(r.repairs).toBe(8);
  });
  it('derives top_signal from the headline when blank', () => {
    const c = makeCard();
    c.top_signal = '   ';
    const r = parseCard(c);
    expect(r.ok && r.value.top_signal).toBe('Mid-career');
    expect(r.ok && r.repairs).toBe(1);
    expect(topSignalFromHeadline('CS junior at a T1 university; quant trading intern')).toBe('CS junior at a T1');
    expect(topSignalFromHeadline('IOI bronze')).toBe('IOI bronze');
    expect(topSignalFromHeadline('')).toBe('');
  });
  it('rejects structural problems with a message', () => {
    const a = makeAnalysis() as Record<string, unknown>;
    delete a.verdict;
    const r = parseResumeAnalysis(a);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('verdict');
    expect(parseResumeAnalysis({ ...makeAnalysis(), schema_version: '1.0' }).ok).toBe(false);
    expect(parseCard({ ...makeCard(), career_stage: 'wizard' }).ok).toBe(false);
  });
  it('truncateAtWord', () => {
    expect(truncateAtWord('short', 18)).toBe('short');
    expect(truncateAtWord('S-tier quant intern at Jane', 18)).toBe('S-tier quant');
    expect(truncateAtWord('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
    expect(truncateAtWord('a verylongwordwithoutspaces', 10)).toBe('a verylong');
    expect(truncateAtWord('one two, three', 8)).toBe('one two');
  });
});

describe('GateVerdictZ', () => {
  const base = { is_resume: true, language: 'en', spam_or_abuse: false, prompt_injection_detected: false, estimated_career_stage: 'mid', reason: 'Two-page engineering résumé.' };
  it('normalises language and caps reason', () => {
    expect(parseGateVerdict(base)).toMatchObject({ ok: true, repairs: 0 });
    const r = parseGateVerdict({ ...base, language: 'en-US', reason: 'x '.repeat(120) });
    expect(r.ok && r.value.language).toBe('en');
    expect(r.ok && r.value.reason.length).toBeLessThanOrEqual(160);
    expect(r.ok && r.repairs).toBe(2);
    expect(parseGateVerdict({ ...base, estimated_career_stage: 'unknown' }).ok).toBe(true);
    expect(parseGateVerdict({ ...base, estimated_career_stage: 'ceo' }).ok).toBe(false);
  });
});

describe('PairwiseVerdictZ', () => {
  const base = { winner: 'first', confidence: 0.71, decisive_factors: ['first: owned a 40k rps service'], reasoning: 'First owned more.' };
  it('clamps confidence, bounds factors, caps reasoning', () => {
    expect(parsePairwiseVerdict(base)).toMatchObject({ ok: true, repairs: 0 });
    const low = parsePairwiseVerdict({ ...base, confidence: 0.2 });
    expect(low.ok && low.value.confidence).toBe(0.5);
    const high = parsePairwiseVerdict({ ...base, confidence: 1.3 });
    expect(high.ok && high.value.confidence).toBe(1);
    const empty = parsePairwiseVerdict({ ...base, decisive_factors: [] });
    expect(empty.ok && empty.value.decisive_factors).toEqual(['(none given)']);
    const many = parsePairwiseVerdict({ ...base, decisive_factors: ['a', 'b', 'c', 'd', 'e'], reasoning: 'r '.repeat(200) });
    expect(many.ok && many.value.decisive_factors).toHaveLength(3);
    expect(many.ok && many.value.reasoning.length).toBeLessThanOrEqual(200);
    expect(many.ok && many.repairs).toBe(2);
    expect(parsePairwiseVerdict({ ...base, winner: 'tie' }).ok).toBe(false);
  });
});

describe('document mirrors', () => {
  it('LayoutMetricsZ defaults and strips', () => {
    expect(LayoutMetricsZ.parse({})).toEqual({ source: 'paste', pages: 0, columns_detected: 0, font_count: 0, image_count: 0, char_count: 0, word_count: 0, extraction_quality: 0, redactions: { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 } });
    expect(LayoutMetricsZ.parse({ source: 'pdf', pages: 2, redactions: { email: 1 }, extra: true })).toMatchObject({ source: 'pdf', pages: 2, redactions: { email: 1, name: 0 } });
    expect(LayoutMetricsZ.safeParse({ pages: 1.5 }).success).toBe(false);
  });
  it('SettingsZ accepts the defaults and names a bad key', () => {
    expect(SettingsZ.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    const bad = SettingsZ.safeParse({ ...DEFAULT_SETTINGS, rating: { ...DEFAULT_SETTINGS.rating, rd_floor: 'fifty' } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(['rating', 'rd_floor']);
    expect(SettingsZ.safeParse({ ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, judge_effort: 'high' } }).success).toBe(false);
  });
  it('StatusZ and RowEntryZ accept the spec examples', () => {
    const status = {
      schema: 1, updated_at: '2026-10-03T14:20:11Z', paused: false,
      budget: { day: '2026-10-03', daily_usd: 25, spent_usd: 7.12, analysis_usd: 3.9, refine_spent_usd: 1.9, exhausted: false, hard_stopped: false },
      queue: { placement: 3, analysis: 0, delete: 0, oldest_queued_at: '2026-10-03T14:12:40Z' },
      last_rerank: { run_id: 123456789, at: '2026-10-03T14:20:00Z', trigger: 'workflow_run', waves: 4, matches: 42, placements_completed: 3, duration_s: 311, changed: true, state: 'ok' },
      last_submission_at: '2026-10-03T14:11:02Z', last_deploy_requested_at: '2026-10-03T14:20:10Z', deploy_pending: false,
      counts: { resumes: 1234, analyzed: 1200, rated: 1180, placing: 3, queued: 0, held: 2, needs_review: 1, rejected: 40, duplicate: 9, superseded: 30, deleted: 12, users: 900, matches: 23456, anchors: 48 },
      per_category: Object.fromEntries(CATEGORIES.map((c) => [c, { rated: 1, mean: 1500, sd: 200, anchor_residual_7d: null, anchor_n_7d: 0, anchor_accuracy_7d: null, disagreement_rate_7d: null }])),
      health: { judge_healthy: true, schedule_enabled: true, token_expires: '2027-10-01', submissions_last_hour: 4, failed_runs_24h: 1, cancelled_runs_24h: 0, issue_path_24h: 0, dispatch_path_24h: 96, alerts: [] },
      versions: { engine: '0.1.0', gate_prompt: 'gate.v1+1a2b3c4d', analyst_prompt: 'analyst.v1+9e8f7a6b', judge_prompt: 'judge.v1+5c4d3e2f', schema: '1.1', taxonomy: '2026-10' },
    };
    expect(StatusZ.safeParse(status).success).toBe(true);
    const row = { h: 'priya-n', v: 'anonymous', p: 'tech', st: 'mid', sig: '40k rps system', s: 'analyzed', c: { general: 1, tech: 0.82 }, sc: { general: 71, tech: 78 }, ss: { general: [60, 70, 78, 64, 55, 74], tech: [52, 70, 78, 86, 68, 74] }, ch: 'c1f6', t: 1759500662 };
    expect(RowEntryZ.safeParse(row).success).toBe(true);
    expect(RowEntryZ.safeParse({ ...row, ss: { general: [1, 2, 3] } }).success).toBe(false);
  });
  it('CardZ output is a plain Card', () => {
    const c = CardZ.parse(makeCard());
    expect(c.card_version).toBe('1.0');
    expect(c.publications_summary.venues).toEqual([]);
  });
});
