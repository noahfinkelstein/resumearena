// PII scrub (D-14, platform-github.md §E.2) and the output sweeps (§5.5 step 2).
//
// scrubPii runs in the browser before the person approves the text and again in the engine, which
// rejects `text_not_scrubbed` when the output differs. The function is therefore idempotent by
// construction: replacements are tokens no pattern can match, and the name heuristic cannot fire on a
// first line that has already become `[name]`.
import type { Redaction, RedactionKind, ScrubResult } from './types.ts';
import { PLACEHOLDER_TOKENS, REMOVED_TOKEN } from './constants.ts';

type Seg = { kind: null; text: string } | { kind: RedactionKind; token: string; original: string };

const KINDS: readonly RedactionKind[] = ['name', 'email', 'phone', 'url', 'address', 'manual'];
const TOKEN_RE = /\[(?:name|email|phone|url|address|redacted)\]/g;
export const PLACEHOLDER_RE = /\[(name|email|phone|url|address|redacted)\]/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`)\]}]+/gi;
const TLDS = 'com|org|net|io|edu|gov|mil|dev|ai|co|me|app|ly|us|uk|ca|de|fr|in|it|es|nl|se|ch|au|nz|jp|kr|cn|sg|hk|tech|xyz|info|biz|ac|eu|tv|cc|so|sh|gg|to|page|site|online|cloud|digital|design|studio|art|run|fyi|wiki|codes|systems|tools';
const BARE_DOMAIN_RE = new RegExp(`(?<![\\w@.\\[/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})\\b(?:/[^\\s<>"'\`)\\]}]*)?`, 'gi');
/** Product and company names that look like domains but carry no personal information. */
const DOMAIN_ALLOW = new Set(['asp.net', 'vb.net', 'ado.net', 'socket.io', 'amazon.com', 'booking.com', 'salesforce.com', 'hotels.com', 'cars.com', 'realtor.com', 'ancestry.com', 'overstock.com', 'match.com', 'priceline.com', 'alibaba.com', 'jd.com']);
const AT_HANDLE_RE = /(?<=^|[\s(\[])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,30}\b/gm;
/** `GitHub: jdoe-dev`; the handle must look like a handle (lowercase, digits, _ . -) so a capitalised word is not eaten. */
const LABELLED_HANDLE_RE = /\b(?:[Ll]inked[Ii]n|[Gg]it[Hh]ub|[Gg]it[Ll]ab|[Bb]itbucket|[Tt]witter|[Ii]nstagram|[Tt]elegram|[Dd]iscord|[Xx])\s*[:|/]\s*@?[a-z0-9_][a-z0-9_.-]{1,38}\b(?![A-Za-z])/g;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)|\d{1,5})(?:[\s.-]?\d{1,5}){1,6}/g;
const STREET_SUFFIX = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Square|Sq|Terrace|Ter|Way|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Trail|Trl|Crescent|Cres|Close|Gardens|Grove|Row|Walk|Alley|Loop|Plaza|Turnpike|Tpke';
const STREET_RE = new RegExp(`\\b\\d{1,6}[A-Za-z]?(?:-\\d{1,4})?\\s+(?:(?:[NSEW]|North|South|East|West)\\.?\\s+)?(?:[A-Z][A-Za-z'.-]*\\s+){1,4}(?:${STREET_SUFFIX})\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Ste|Unit|Floor|Fl|#)\\.?\\s*[\\w-]+)?`, 'g');
const CITY_STATE_ZIP_RE = /\b[A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+){0,3},?\s+(?:[A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+\d{5}(?:-\d{4})?\b/g;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g;
const CA_POSTCODE_RE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g;

/** Title-case words that open many résumés without being a name. */
const NOT_NAME_WORDS = new Set([
  'university', 'college', 'institute', 'school', 'academy', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'technologies', 'labs', 'capital', 'partners',
  'bank', 'group', 'systems', 'solutions', 'consulting', 'ventures', 'holdings', 'foundation', 'department', 'faculty',
  'resume', 'résumé', 'curriculum', 'vitae', 'cv', 'summary', 'profile', 'objective', 'experience', 'education', 'skills', 'contact', 'professional',
  'senior', 'junior', 'lead', 'principal', 'staff', 'software', 'engineer', 'engineering', 'developer', 'manager', 'analyst', 'scientist', 'data', 'product',
  'designer', 'intern', 'student', 'research', 'researcher', 'associate', 'director', 'consultant', 'candidate', 'full', 'stack', 'front', 'back', 'end',
  'machine', 'learning', 'quantitative', 'investment', 'banking', 'financial', 'marketing', 'operations', 'project', 'program', 'technical', 'business',
  'graduate', 'undergraduate', 'phd', 'doctoral', 'postdoctoral', 'assistant', 'professor', 'teaching', 'fellow', 'the', 'and', 'of', 'for', 'at', 'in',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);

function phoneAccept(m: RegExpExecArray, text: string): boolean {
  const s = m[0];
  const groups = s.match(/\d+/g) ?? [];
  const digits = groups.join('').length;
  const prefixed = s.startsWith('+') || s.includes('(');
  if (digits > 15) return false;
  if (digits < 9 && !(prefixed && digits >= 7)) return false;
  if (groups.every((gp) => /^(?:19|20)\d\d$/.test(gp))) return false;
  const before = text[m.index - 1] ?? '';
  const after = text[m.index + s.length] ?? '';
  if (/[\d$€£#%.,A-Za-z]/.test(before) || /[\d%]/.test(after)) return false;
  return true;
}

function domainAccept(m: RegExpExecArray): boolean {
  const host = m[0].split('/')[0]?.toLowerCase() ?? '';
  return !DOMAIN_ALLOW.has(host);
}

interface Pass {
  kind: RedactionKind;
  re: RegExp;
  accept?: (m: RegExpExecArray, text: string) => boolean;
  /** Characters at the start of the match that stay as plain text (a label such as `GitHub: `). */
  keepPrefix?: (m: RegExpExecArray) => number;
  /** Trailing characters to give back to the text (sentence punctuation after a URL). */
  trimTrail?: RegExp;
}

const URL_TRAIL = /[.,;:!?'")\]]+$/;

const labelPrefixLen = (m: RegExpExecArray): number => m[0].search(/@?[a-z0-9_][a-z0-9_.-]{1,38}$/);

const PASSES: readonly Pass[] = [
  { kind: 'email', re: EMAIL_RE },
  { kind: 'url', re: URL_RE, trimTrail: URL_TRAIL },
  { kind: 'url', re: BARE_DOMAIN_RE, accept: domainAccept, trimTrail: URL_TRAIL },
  { kind: 'url', re: AT_HANDLE_RE },
  { kind: 'url', re: LABELLED_HANDLE_RE, keepPrefix: labelPrefixLen },
  { kind: 'phone', re: PHONE_RE, accept: phoneAccept },
  { kind: 'address', re: STREET_RE },
  { kind: 'address', re: CITY_STATE_ZIP_RE },
  { kind: 'address', re: UK_POSTCODE_RE },
  { kind: 'address', re: CA_POSTCODE_RE },
];

function runPass(segs: Seg[], pass: Pass): Seg[] {
  const out: Seg[] = [];
  const re = new RegExp(pass.re.source, pass.re.flags.includes('g') ? pass.re.flags : `${pass.re.flags}g`);
  for (const seg of segs) {
    if (seg.kind !== null) {
      out.push(seg);
      continue;
    }
    const text = seg.text;
    let cursor = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (pass.accept && !pass.accept(m, text)) continue;
      const keep = pass.keepPrefix ? Math.max(0, pass.keepPrefix(m)) : 0;
      const start = m.index + keep;
      let original = m[0].slice(keep);
      if (pass.trimTrail) original = original.replace(pass.trimTrail, '');
      if (original.length === 0) continue;
      if (start > cursor) out.push({ kind: null, text: text.slice(cursor, start) });
      out.push({ kind: pass.kind, token: PLACEHOLDER_TOKENS[pass.kind], original });
      cursor = start + original.length;
    }
    if (cursor < text.length) out.push({ kind: null, text: text.slice(cursor) });
  }
  return out;
}

const joinSegs = (segs: readonly Seg[]): string => segs.map((s) => (s.kind === null ? s.text : s.token)).join('');

const TITLE_TOKEN_RE = /^[A-Z][a-z'’]+(?:[-'’]?[A-Z][a-z'’]+)*$/;
const INITIAL_RE = /^[A-Z]\.?$/;

/**
 * The name heuristic: first non-empty line, first chunk before a separator, 2–4 title-case tokens
 * (one may be an initial), no digits, none a title word. All-caps names and names in running text
 * are missed by design; the UI says removal is by pattern.
 */
export function detectName(text: string): { full: string; tokens: string[] } | null {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const chunk = (line.split(/\s*(?:\||·|•|,|;|—|–| - )\s*/)[0] ?? '').trim();
  if (!chunk || /\d/.test(chunk)) return null;
  const raw = chunk.split(/\s+/);
  while (raw.length > 0 && PLACEHOLDER_RE.test(raw[raw.length - 1] ?? '')) raw.pop();
  if (raw.length < 2 || raw.length > 4) return null;
  const tokens: string[] = [];
  let full = 0;
  for (const t of raw) {
    const clean = t.replace(/[.,]+$/, '');
    if (INITIAL_RE.test(clean)) {
      tokens.push(clean);
      continue;
    }
    if (!TITLE_TOKEN_RE.test(clean) || NOT_NAME_WORDS.has(clean.toLowerCase())) return null;
    tokens.push(clean);
    full++;
  }
  if (full < 2) return null;
  return { full: tokens.join(' '), tokens: tokens.filter((t) => t.length >= 3) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namePass(segs: Seg[]): Seg[] {
  const name = detectName(joinSegs(segs));
  if (!name) return segs;
  // A period is optional only after an initial, so the sentence period after a full name stays in the text.
  const alternatives = [name.full.split(' ').map((t) => (t.length === 1 ? `${escapeRe(t)}\\.?` : escapeRe(t))).join('\\s+'), ...name.tokens.map(escapeRe)];
  const re = new RegExp(`(?<![A-Za-z])(?:${alternatives.join('|')})(?![A-Za-z])`, 'g');
  return runPass(segs, { kind: 'name', re });
}

export interface ScrubOptions {
  /** Skip the name heuristic (preview only; the engine always runs the default). */
  name?: boolean;
}

/**
 * Replace personal data with visible tokens. `counts` includes tokens already present in the input,
 * so re-running on scrubbed text reports the same numbers; `redactions` lists only this pass's work,
 * with `index` pointing into the returned text.
 */
export function scrubPii(input: string, options: ScrubOptions = {}): ScrubResult {
  const counts: Record<RedactionKind, number> = { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 };
  for (const m of input.matchAll(TOKEN_RE)) {
    const kind = KINDS.find((k) => PLACEHOLDER_TOKENS[k] === m[0]);
    if (kind) counts[kind]++;
  }
  let segs: Seg[] = [{ kind: null, text: input }];
  for (const pass of PASSES) segs = runPass(segs, pass);
  if (options.name !== false) segs = namePass(segs);

  const redactions: Redaction[] = [];
  let text = '';
  for (const seg of segs) {
    if (seg.kind === null) {
      text += seg.text;
      continue;
    }
    redactions.push({ kind: seg.kind, original: seg.original, token: seg.token, index: text.length });
    counts[seg.kind]++;
    text += seg.token;
  }
  return { text, redactions, counts };
}

/** True when scrubPii would change the text: the engine's `text_not_scrubbed` test. */
export const isScrubbed = (text: string): boolean => scrubPii(text).text === text;

// ---- output sweeps ------------------------------------------------------------------------------

const SWEEP_PASSES: readonly Pass[] = PASSES.filter((p) => p.re !== AT_HANDLE_RE && p.re !== LABELLED_HANDLE_RE);

/** Does a model-written string carry an email, phone, URL, bare domain, street pattern or a placeholder token? */
export function sweepHit(s: string): boolean {
  if (PLACEHOLDER_RE.test(s)) return true;
  for (const pass of SWEEP_PASSES) {
    const re = new RegExp(pass.re.source, pass.re.flags.includes('g') ? pass.re.flags : `${pass.re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (!pass.accept || pass.accept(m, s)) return true;
    }
  }
  return false;
}

/** Deep copy with every offending string replaced by `[removed]`; `hits` counts replacements. */
export function sweepDeep<T>(value: T): { value: T; hits: number } {
  let hits = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (sweepHit(v)) {
        hits++;
        return REMOVED_TOKEN;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, hits };
}

/** The judge card must carry no contact data and no placeholder (a placeholder means copied text). */
export function sweepCard<C>(card: C): { card: C; hits: number } {
  const r = sweepDeep(card);
  return { card: r.value, hits: r.hits };
}

/** Every free-text field of an analysis (strengths, rationale, fixes, red flags, verdict, the card…). */
export function sweepAnalysisText<A>(analysis: A): { analysis: A; hits: number } {
  const r = sweepDeep(analysis);
  return { analysis: r.value, hits: r.hits };
}
