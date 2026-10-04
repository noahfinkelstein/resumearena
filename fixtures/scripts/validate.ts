#!/usr/bin/env node
// Validates every fixture under fixtures/resumes and fixtures/analyses against the shared schemas and the
// rules in fixtures/README.md and spec §13.1. Run with `node fixtures/scripts/validate.ts` (Node 24, no
// build). Exit code 1 when any file fails; plan entries that have no files yet are listed as pending and
// do not fail the run unless `--strict` is passed, so a writer can check their own slice mid-way.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ResumeAnalysisZ } from '../../packages/shared/src/schemas/analysis.ts';
import { LayoutMetricsZ } from '../../packages/shared/src/schemas/data.ts';
import { parseWithRepairs } from '../../packages/shared/src/schemas/repair.ts';
import { isIncluded, recomputeAtsScore } from '../../packages/shared/src/scoring.ts';
import { scrubPii, sweepHit } from '../../packages/shared/src/scrub.ts';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESUMES = join(FIXTURES, 'resumes');
const ANALYSES = join(FIXTURES, 'analyses');
const STRICT = process.argv.includes('--strict');

const GROUPS = new Set(['anchor', 'weak', 'gamed', 'pii', 'edge']);
const STAGES = new Set(['student', 'new_grad', 'early', 'mid', 'senior', 'executive']);
const CATEGORIES = new Set(['general', 'finance', 'tech', 'academia']);
const GATES = new Set(['pass', 'reject', 'held']);
const STATUSES = new Set(['analyzed', 'rejected', 'held', 'needs_review']);
const METRIC_KEYS = ['source', 'pages', 'columns_detected', 'font_count', 'image_count', 'char_count', 'word_count', 'extraction_quality', 'redactions'];
const REDACTION_KEYS = ['name', 'email', 'phone', 'url', 'address', 'manual'];
const META_KEYS = new Set(['slug', 'group', 'intended_anchor', 'intended_stage', 'intended_categories', 'expect', 'metrics', 'planted']);
const MIN_CHARS = 400;
const MAX_CHARS = 15000;

interface PlanEntry {
  slug: string;
  group: string;
  expect: { gate: string; status: string };
  target_chars: number;
}

interface Report {
  errors: string[];
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Sorted keys and a trailing newline are the on-disk convention for every JSON file (spec conventions). */
function checkJsonFormatting(path: string, raw: string, report: Report): void {
  if (!raw.endsWith('\n')) report.errors.push('JSON file must end with a newline');
  const walk = (v: unknown, where: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
      return;
    }
    if (!isRecord(v)) return;
    const keys = Object.keys(v);
    const sorted = [...keys].sort();
    if (keys.some((k, i) => k !== sorted[i])) report.errors.push(`keys not sorted at ${where || '<root>'}`);
    for (const k of keys) walk(v[k], where ? `${where}.${k}` : k);
  };
  walk(JSON.parse(raw), '');
  void path;
}

const countTokens = (text: string, token: string): number => text.split(token).length - 1;
const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

/** Every string anywhere in the analysis; the sweep must find nothing (§5.5 step 2). */
function* strings(v: unknown, where = ''): Generator<[string, string]> {
  if (typeof v === 'string') {
    yield [where, v];
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* strings(v[i], `${where}[${i}]`);
    return;
  }
  if (isRecord(v)) for (const k of Object.keys(v)) yield* strings(v[k], where ? `${where}.${k}` : k);
}

function validateText(slug: string, text: string, meta: Record<string, unknown>, report: Report): void {
  if (text.length === 0) {
    report.errors.push('text is empty');
    return;
  }
  if (text !== text.normalize('NFC')) report.errors.push('text is not NFC-normalized');
  if (/\r/.test(text)) report.errors.push('text contains \\r');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) report.errors.push('text contains control characters');
  if (text !== text.trim()) report.errors.push('text has leading or trailing whitespace (the browser submits trimmed text)');
  const expect = isRecord(meta.expect) ? meta.expect : {};
  const rejectedBeforeGate = expect.gate === 'reject' && expect.status === 'rejected';
  if (text.length > MAX_CHARS) report.errors.push(`text is ${text.length} chars, over the ${MAX_CHARS} cap`);
  if (text.length < MIN_CHARS && !rejectedBeforeGate) report.errors.push(`text is ${text.length} chars, under the ${MIN_CHARS} floor`);
  const scrub = scrubPii(text);
  if (scrub.text !== text) {
    const hits = scrub.redactions.map((r) => `${r.kind}:"${r.original}"`).join(', ');
    report.errors.push(`scrubPii would change the text (engine rejects text_not_scrubbed): ${hits}`);
  }
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  if (!firstLine.includes('[name]')) report.warnings.push(`first line is not the [name] placeholder: "${firstLine.slice(0, 40)}"`);
  void slug;
}

function validateMeta(slug: string, meta: unknown, text: string | null, report: Report): Record<string, unknown> | null {
  if (!isRecord(meta)) {
    report.errors.push('meta is not an object');
    return null;
  }
  for (const k of Object.keys(meta)) if (!META_KEYS.has(k)) report.errors.push(`meta has unexpected key "${k}"`);
  for (const k of ['slug', 'group', 'intended_anchor', 'intended_stage', 'intended_categories', 'expect', 'metrics']) {
    if (!(k in meta)) report.errors.push(`meta is missing "${k}"`);
  }
  if (meta.slug !== slug) report.errors.push(`meta.slug "${String(meta.slug)}" does not match the file name`);
  if (!GROUPS.has(String(meta.group))) report.errors.push(`meta.group "${String(meta.group)}" is not anchor|weak|gamed|pii|edge`);
  const anchor = meta.intended_anchor;
  if (anchor !== null && (typeof anchor !== 'number' || anchor < 1000 || anchor > 2100 || anchor % 100 !== 0)) {
    report.errors.push('meta.intended_anchor must be null or 1000…2100 step 100');
  }
  if (meta.group === 'anchor' && anchor === null) report.errors.push('anchor-group fixture has intended_anchor null');
  if (meta.group !== 'anchor' && anchor !== null) report.errors.push('non-anchor fixture has a numeric intended_anchor');
  if (!STAGES.has(String(meta.intended_stage))) report.errors.push(`meta.intended_stage "${String(meta.intended_stage)}" is not a CareerStage`);
  const cats = meta.intended_categories;
  if (!Array.isArray(cats) || cats.length === 0 || cats[0] !== 'general' || cats.some((c) => !CATEGORIES.has(String(c)))) {
    report.errors.push('meta.intended_categories must be a non-empty list of categories starting with general');
  }
  const expect = meta.expect;
  if (!isRecord(expect) || !GATES.has(String(expect.gate)) || !STATUSES.has(String(expect.status))) {
    report.errors.push('meta.expect must be { gate: pass|reject|held, status: analyzed|rejected|held|needs_review }');
  }
  if (meta.group === 'pii') {
    if (!isRecord(meta.planted) || Object.keys(meta.planted).length === 0) report.errors.push('pii fixture must record planted values');
    else if (text) {
      for (const [k, v] of Object.entries(meta.planted)) {
        if (typeof v !== 'string' || v.length === 0) report.errors.push(`planted.${k} must be a non-empty string`);
        else if (!text.includes(v)) report.errors.push(`planted.${k} "${v}" does not appear in the text`);
      }
    }
  } else if ('planted' in meta) {
    report.errors.push('only pii fixtures carry planted');
  }

  const metrics = meta.metrics;
  if (!isRecord(metrics)) {
    report.errors.push('meta.metrics missing');
    return meta;
  }
  for (const k of METRIC_KEYS) if (!(k in metrics)) report.errors.push(`metrics is missing "${k}" (D-13: never partial, never null)`);
  for (const k of Object.keys(metrics)) if (!METRIC_KEYS.includes(k)) report.errors.push(`metrics has unexpected key "${k}"`);
  if (isRecord(metrics.redactions)) {
    for (const k of REDACTION_KEYS) if (typeof metrics.redactions[k] !== 'number') report.errors.push(`metrics.redactions.${k} must be a number`);
  }
  const parsed = LayoutMetricsZ.safeParse(metrics);
  if (!parsed.success) {
    report.errors.push(`metrics fails LayoutMetricsZ: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return meta;
  }
  const m = parsed.data;
  if (text) {
    if (m.char_count !== text.length) report.errors.push(`metrics.char_count ${m.char_count} ≠ text length ${text.length}`);
    const words = wordCount(text);
    if (Math.abs(m.word_count - words) > Math.max(5, words * 0.1)) report.errors.push(`metrics.word_count ${m.word_count} is far from the counted ${words}`);
    for (const k of ['name', 'email', 'phone', 'url', 'address'] as const) {
      const n = countTokens(text, `[${k}]`);
      if (m.redactions[k] !== n) report.errors.push(`metrics.redactions.${k} ${m.redactions[k]} ≠ ${n} [${k}] placeholders in the text`);
    }
    if (m.source !== 'pdf') {
      const pages = Math.ceil(text.length / 3000);
      if (m.pages !== pages) report.errors.push(`metrics.pages ${m.pages} should be ceil(char_count / 3000) = ${pages} for ${m.source}`);
    }
  }
  if (m.source === 'pdf') {
    if (m.pages < 1) report.errors.push('pdf metrics need pages ≥ 1');
    if (m.columns_detected === 0) report.warnings.push('pdf metrics with columns_detected 0 (0 means not measurable)');
  } else {
    if (m.columns_detected !== 0 || m.font_count !== 0 || m.image_count !== 0) report.errors.push(`${m.source} metrics must have columns_detected, font_count and image_count 0`);
    const q = m.source === 'paste' ? [1] : [0.95, 0.7];
    if (!q.includes(m.extraction_quality)) report.warnings.push(`${m.source} extraction_quality is usually ${q.join(' or ')}, got ${m.extraction_quality}`);
  }
  return meta;
}

function validateAnalysis(slug: string, analysisRaw: unknown, meta: Record<string, unknown> | null, text: string | null, report: Report): void {
  const result = parseWithRepairs(ResumeAnalysisZ, analysisRaw);
  if (!result.ok) {
    report.errors.push(`analysis fails ResumeAnalysisZ:\n      ${result.message.split('\n').join('\n      ')}`);
    return;
  }
  if (result.repairs > 0) {
    // A committed analysis is what the engine stores after repair, so a fixture that still needs
    // repairs is not faithful; name the first field whose value changed.
    const diff = firstDifference(analysisRaw, result.value);
    report.errors.push(`analysis needs ${result.repairs} Zod repair(s) (string over its cap, array over its cap, or a clamp)${diff ? ` at ${diff}` : ''}`);
  }
  const a = result.value;
  for (const [where, s] of strings(a)) {
    if (sweepHit(s)) report.errors.push(`analysis string at ${where} would be swept (placeholder, email, URL, phone or address): "${s.slice(0, 60)}"`);
  }
  if (a.input.language !== 'en') report.warnings.push(`analysis.input.language is ${a.input.language}`);
  const ats = recomputeAtsScore(a.ats.factors);
  if (a.ats.score !== ats) report.errors.push(`ats.score ${a.ats.score} ≠ recomputeAtsScore ${ats} (the engine overwrites it)`);
  for (const cat of ['general', 'finance', 'tech', 'academia'] as const) {
    const inc = isIncluded(cat, a.category_relevance);
    if (a.scores[cat].included !== inc) report.errors.push(`scores.${cat}.included ${String(a.scores[cat].included)} disagrees with relevance ${a.category_relevance[cat]}`);
  }
  if (a.card.career_stage !== a.signals.career_stage) report.errors.push(`card.career_stage ${a.card.career_stage} ≠ signals.career_stage ${a.signals.career_stage}`);
  if (a.card.years_fulltime !== a.signals.years_fulltime) report.warnings.push(`card.years_fulltime ${a.card.years_fulltime} ≠ signals.years_fulltime ${a.signals.years_fulltime}`);
  if (a.strengths.length < 3) report.errors.push(`strengths has ${a.strengths.length} items (3–5 expected)`);
  if (a.weaknesses.length < 3) report.errors.push(`weaknesses has ${a.weaknesses.length} items (3–5 expected)`);
  if (a.ats.fixes.length < 3) report.errors.push(`ats.fixes has ${a.ats.fixes.length} items (3–7 expected)`);
  if (a.card.publications_summary.count_total !== a.publications.length) {
    report.warnings.push(`card.publications_summary.count_total ${a.card.publications_summary.count_total} ≠ ${a.publications.length} parsed publications`);
  }
  if (text) {
    const seen = new Set(a.input.placeholders_seen);
    for (const k of ['name', 'email', 'phone', 'url', 'address'] as const) {
      const inText = text.includes(`[${k}]`);
      if (inText && !seen.has(k)) report.errors.push(`text has [${k}] but input.placeholders_seen lacks it`);
      if (!inText && seen.has(k)) report.errors.push(`input.placeholders_seen lists ${k} but the text has no [${k}]`);
    }
    const words = wordCount(text);
    if (Math.abs(a.input.word_count_estimate - words) > Math.max(30, words * 0.15)) report.warnings.push(`input.word_count_estimate ${a.input.word_count_estimate} is far from ${words}`);
  }
  if (!meta) return;

  const expect = isRecord(meta.expect) ? meta.expect : {};
  const piiHit = a.residual_pii.name_suspected || a.residual_pii.email_count + a.residual_pii.phone_count + a.residual_pii.url_count > 0 || a.residual_pii.street_address_suspected;
  const injectionHit = a.red_flags.some((f) => (f.type === 'prompt_injection' || f.type === 'hidden_text') && f.severity === 'high');
  if (meta.group === 'pii' && !piiHit) report.errors.push('pii fixture analysis does not flag any residual PII');
  if (expect.status === 'analyzed') {
    if (piiHit) report.errors.push('expected analyzed but residual_pii would hold the record (§5.5 step 4)');
    if (!a.input.is_resume) report.errors.push('expected analyzed but input.is_resume is false (→ needs_review)');
    if (a.analysis_confidence < 0.3) report.errors.push('expected analyzed but analysis_confidence < 0.3 (→ needs_review)');
    if (expect.gate === 'held' && injectionHit) report.errors.push('gate held + high-severity injection flag would make this held, not analyzed');
  }
  if (expect.status === 'held') {
    if (!piiHit && !(expect.gate === 'held' && injectionHit)) report.errors.push('expected held but neither residual PII nor (gate held + high-severity injection flag) is present');
  }
  if (expect.status === 'needs_review' && a.input.is_resume && a.analysis_confidence >= 0.3) {
    report.errors.push('expected needs_review but is_resume is true and analysis_confidence ≥ 0.3');
  }
  if (isRecord(meta.planted)) {
    const json = JSON.stringify(analysisRaw);
    for (const [k, v] of Object.entries(meta.planted)) if (typeof v === 'string' && json.includes(v)) report.errors.push(`planted.${k} leaked into the analysis`);
  }
  if (a.signals.career_stage !== meta.intended_stage) report.errors.push(`signals.career_stage ${a.signals.career_stage} ≠ intended_stage ${String(meta.intended_stage)}`);
  const cats = Array.isArray(meta.intended_categories) ? meta.intended_categories.map(String) : [];
  for (const cat of ['finance', 'tech', 'academia'] as const) {
    const inc = isIncluded(cat, a.category_relevance);
    const intended = cats.includes(cat);
    if (inc !== intended) report.errors.push(`${cat} relevance ${a.category_relevance[cat]} ${inc ? 'includes' : 'excludes'} the ladder but intended_categories ${intended ? 'lists' : 'omits'} it`);
  }
  if (meta.group === 'gamed' && !a.skills.keyword_stuffing_suspected && a.red_flags.length === 0) report.warnings.push('gamed fixture has no red flag and no keyword_stuffing_suspected');
  void slug;
}

/** Path of the first leaf where the repaired value differs from the raw input. */
function firstDifference(raw: unknown, repaired: unknown, where = ''): string | null {
  if (Array.isArray(raw) && Array.isArray(repaired)) {
    if (raw.length !== repaired.length) return `${where} (length ${raw.length} → ${repaired.length})`;
    for (let i = 0; i < raw.length; i++) {
      const d = firstDifference(raw[i], repaired[i], `${where}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (isRecord(raw) && isRecord(repaired)) {
    for (const k of Object.keys(repaired)) {
      const d = firstDifference(raw[k], repaired[k], where ? `${where}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return raw === repaired ? null : `${where} (${JSON.stringify(raw)?.slice(0, 50)} → ${JSON.stringify(repaired)?.slice(0, 50)})`;
}

function main(): number {
  const plan = readJson(join(FIXTURES, 'plan.json')) as PlanEntry[];
  const planBySlug = new Map(plan.map((e) => [e.slug, e]));
  const reports = new Map<string, Report>();
  const reportFor = (slug: string): Report => {
    let r = reports.get(slug);
    if (!r) {
      r = { errors: [], warnings: [] };
      reports.set(slug, r);
    }
    return r;
  };

  const txtSlugs = existsSync(RESUMES) ? readdirSync(RESUMES).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)) : [];
  const metaSlugs = existsSync(RESUMES) ? readdirSync(RESUMES).filter((f) => f.endsWith('.meta.json')).map((f) => f.slice(0, -'.meta.json'.length)) : [];
  const analysisSlugs = existsSync(ANALYSES) ? readdirSync(ANALYSES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  const onDisk = new Set([...txtSlugs, ...metaSlugs, ...analysisSlugs]);

  const hashes = new Map<string, string>();
  for (const slug of onDisk) {
    const report = reportFor(slug);
    if (!planBySlug.has(slug)) report.errors.push('slug is not in plan.json');
    const txtPath = join(RESUMES, `${slug}.txt`);
    const metaPath = join(RESUMES, `${slug}.meta.json`);
    const analysisPath = join(ANALYSES, `${slug}.json`);
    const text = existsSync(txtPath) ? readFileSync(txtPath, 'utf8') : null;
    if (text === null) report.errors.push('resumes/<slug>.txt is missing');
    if (!existsSync(metaPath)) report.errors.push('resumes/<slug>.meta.json is missing');

    let meta: Record<string, unknown> | null = null;
    if (existsSync(metaPath)) {
      const raw = readFileSync(metaPath, 'utf8');
      try {
        checkJsonFormatting(metaPath, raw, report);
        meta = validateMeta(slug, JSON.parse(raw), text, report);
      } catch (e) {
        report.errors.push(`meta is not valid JSON: ${(e as Error).message}`);
      }
    }
    if (text !== null && meta) validateText(slug, text, meta, report);
    if (text !== null) {
      const h = createHash('sha256').update(text).digest('hex');
      const other = hashes.get(h);
      if (other) report.errors.push(`text is byte-identical to ${other} (submit dedupes on text_sha256)`);
      hashes.set(h, slug);
      const planned = planBySlug.get(slug);
      if (planned) {
        const lo = Math.round(planned.target_chars * 0.9);
        const hi = Math.round(planned.target_chars * 1.1);
        const exact = planned.target_chars === MAX_CHARS || planned.target_chars < MIN_CHARS;
        if (exact ? text.length !== planned.target_chars : text.length < lo || text.length > hi) {
          report.warnings.push(`text is ${text.length} chars; plan targets ${planned.target_chars}${exact ? ' exactly' : ` (±10%: ${lo}–${hi})`}`);
        }
      }
    }

    const expectStatus = meta && isRecord(meta.expect) ? String(meta.expect.status) : planBySlug.get(slug)?.expect.status;
    const hasAnalysis = existsSync(analysisPath);
    if (expectStatus === 'rejected' && hasAnalysis) report.errors.push('rejected fixtures carry no analysis (nothing ran past the gate)');
    if ((expectStatus === 'analyzed' || expectStatus === 'held') && !hasAnalysis) report.errors.push('analyses/<slug>.json is missing');
    if (hasAnalysis) {
      const raw = readFileSync(analysisPath, 'utf8');
      try {
        checkJsonFormatting(analysisPath, raw, report);
        validateAnalysis(slug, JSON.parse(raw), meta, text, report);
      } catch (e) {
        report.errors.push(`analysis is not valid JSON: ${(e as Error).message}`);
      }
    }
  }

  const pending = plan.filter((e) => !onDisk.has(e.slug)).map((e) => e.slug);
  let failed = 0;
  let warned = 0;
  for (const slug of [...reports.keys()].sort()) {
    const r = reports.get(slug)!;
    if (r.errors.length === 0 && r.warnings.length === 0) continue;
    if (r.errors.length > 0) failed++;
    if (r.warnings.length > 0) warned++;
    console.log(`${r.errors.length > 0 ? 'FAIL' : 'warn'} ${slug}`);
    for (const e of r.errors) console.log(`  error: ${e}`);
    for (const w of r.warnings) console.log(`  warn:  ${w}`);
  }
  const checked = reports.size;
  console.log(`\n${checked} fixture(s) checked, ${checked - failed} clean, ${failed} failing, ${warned} with warnings, ${pending.length} plan entries pending`);
  if (pending.length > 0) {
    console.log(STRICT ? 'missing plan entries:' : 'pending (not written yet):');
    for (const slug of pending) console.log(`  ${slug}`);
  }
  return failed > 0 || (STRICT && pending.length > 0) ? 1 : 0;
}

process.exitCode = main();
