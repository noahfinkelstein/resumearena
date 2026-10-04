// Repository lint (spec §2 root script `lint`). Node 24, no dependencies, erasable syntax only.
//
//   node scripts/lint.ts [--root <repo>]
//
// Checks:
//   1. no file under web/src/components/upload imports or calls `fetch` (the dropzone owns a worker, never the network)
//   2. no `console.log` in engine/src except summary.ts (step summaries are the only sanctioned stdout)
//   3. every .github/workflows/*.yml declares `permissions` (top level or on every job) and `timeout-minutes` on every job
//   4. docs/prompts/{gate,analysis-system,judge}.md exist (canonical prompts; engine/prompts is generated from them)
// Prints `file:line: message` per finding and exits 1 when there is at least one.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export interface Finding {
  file: string; // repo-relative
  line: number; // 1-based; 0 when the finding is about the file as a whole
  message: string;
}

export const REQUIRED_PROMPTS = ['gate.md', 'analysis-system.md', 'judge.md'];
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Blanks comments and string/template literal contents while keeping line structure, so identifier checks do not
 * trip on copy text or prose. Approximate on purpose (no nested template parsing); good enough for a lint.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += ' ';
          i++;
          if (i < n) out += src[i] === '\n' ? '\n' : ' ';
          i++;
          continue;
        }
        if (quote !== '`' && src[i] === '\n') break; // unterminated string: resync at the line end
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n && src[i] === quote) out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function linesMatching(code: string, re: RegExp): number[] {
  const hits: number[] = [];
  code.split('\n').forEach((line, idx) => {
    if (re.test(line)) hits.push(idx + 1);
  });
  return hits;
}

/** 1. `fetch` anywhere under web/src/components/upload: as a call, a property (window.fetch) or an import binding. */
export function checkUploadNoFetch(root: string): Finding[] {
  const dir = join(root, 'web/src/components/upload');
  if (!existsSync(dir)) return [];
  const findings: Finding[] = [];
  for (const file of walk(dir).filter((f) => SOURCE_RE.test(f))) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const line of linesMatching(code, /\bfetch\b/)) {
      findings.push({ file: relative(root, file), line, message: 'components/upload must not import or call fetch (spec §11.5)' });
    }
  }
  return findings;
}

/** 2. console.log in engine/src except summary.ts. */
export function checkEngineNoConsoleLog(root: string): Finding[] {
  const dir = join(root, 'engine/src');
  if (!existsSync(dir)) return [];
  const findings: Finding[] = [];
  for (const file of walk(dir).filter((f) => SOURCE_RE.test(f) && !f.endsWith('/summary.ts'))) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const line of linesMatching(code, /\bconsole\s*\.\s*log\s*\(/)) {
      findings.push({ file: relative(root, file), line, message: 'console.log in engine/src (only summary.ts may write to stdout)' });
    }
  }
  return findings;
}

interface YamlLine {
  n: number;
  indent: number;
  key: string | null; // mapping key when the line is `key:` or `key: value`
  text: string;
}

/** Enough YAML to find top-level keys, job names and job-level keys in block-style workflow files. */
function yamlLines(src: string): YamlLine[] {
  const out: YamlLine[] = [];
  src.split('\n').forEach((raw, idx) => {
    const text = raw.replace(/\t/g, '  ');
    if (!text.trim() || text.trim().startsWith('#')) return;
    const indent = text.length - text.trimStart().length;
    const m = text.trim().match(/^("?[A-Za-z0-9_./-]+"?)\s*:(\s|$)/);
    out.push({ n: idx + 1, indent, key: m ? (m[1] as string).replace(/"/g, '') : null, text });
  });
  return out;
}

export interface WorkflowShape {
  topPermissions: boolean;
  jobs: { name: string; line: number; permissions: boolean; timeout: boolean }[];
  jobsLine: number | null;
}

export function workflowShape(src: string): WorkflowShape {
  const lines = yamlLines(src);
  const shape: WorkflowShape = { topPermissions: false, jobs: [], jobsLine: null };
  const jobsIdx = lines.findIndex((l) => l.indent === 0 && l.key === 'jobs');
  shape.topPermissions = lines.some((l) => l.indent === 0 && l.key === 'permissions');
  if (jobsIdx === -1) return shape;
  shape.jobsLine = (lines[jobsIdx] as YamlLine).n;
  let jobIndent: number | null = null;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const l = lines[i] as YamlLine;
    if (l.indent === 0) break; // next top-level key
    if (jobIndent === null) jobIndent = l.indent;
    if (l.indent === jobIndent && l.key) {
      shape.jobs.push({ name: l.key, line: l.n, permissions: false, timeout: false });
      continue;
    }
    const job = shape.jobs[shape.jobs.length - 1];
    if (!job || jobIndent === null || l.indent <= jobIndent) continue;
    // Direct children of the job sit at the shallowest indent under its header; deeper lines belong to steps/env.
    if (l.key === 'permissions' && isDirectChild(lines, i, jobIndent)) job.permissions = true;
    if (l.key === 'timeout-minutes' && isDirectChild(lines, i, jobIndent)) job.timeout = true;
  }
  return shape;
}

function isDirectChild(lines: YamlLine[], i: number, jobIndent: number): boolean {
  // The smallest indent seen between the job header and this line is the child level.
  let min = Infinity;
  for (let k = i; k >= 0; k--) {
    const l = lines[k] as YamlLine;
    if (l.indent === jobIndent) break;
    if (l.indent < min) min = l.indent;
  }
  return (lines[i] as YamlLine).indent === min;
}

/** 3. permissions + timeout-minutes in every workflow. */
export function checkWorkflows(root: string): Finding[] {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [{ file: '.github/workflows', line: 0, message: 'missing workflows directory' }];
  const findings: Finding[] = [];
  const files = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  if (files.length === 0) findings.push({ file: '.github/workflows', line: 0, message: 'no workflow files' });
  for (const name of files) {
    const rel = `.github/workflows/${name}`;
    const shape = workflowShape(readFileSync(join(dir, name), 'utf8'));
    if (shape.jobsLine === null) {
      findings.push({ file: rel, line: 0, message: 'no jobs: key found' });
      continue;
    }
    if (shape.jobs.length === 0) findings.push({ file: rel, line: shape.jobsLine, message: 'jobs: has no jobs' });
    for (const job of shape.jobs) {
      if (!shape.topPermissions && !job.permissions) {
        findings.push({ file: rel, line: job.line, message: `job "${job.name}" has no permissions (none at top level either)` });
      }
      if (!job.timeout) findings.push({ file: rel, line: job.line, message: `job "${job.name}" has no timeout-minutes` });
    }
  }
  return findings;
}

/** 4. canonical prompts exist. */
export function checkPrompts(root: string): Finding[] {
  return REQUIRED_PROMPTS.filter((n) => !existsSync(join(root, 'docs/prompts', n))).map((n) => ({
    file: `docs/prompts/${n}`,
    line: 0,
    message: 'canonical prompt missing (spec D-36)',
  }));
}

export function lint(root: string): Finding[] {
  return [...checkUploadNoFetch(root), ...checkEngineNoConsoleLog(root), ...checkWorkflows(root), ...checkPrompts(root)];
}

export function formatFinding(f: Finding): string {
  return f.line > 0 ? `${f.file}:${f.line}: ${f.message}` : `${f.file}: ${f.message}`;
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });
  const root = resolve(values.root ?? '.');
  const findings = lint(root);
  for (const f of findings) process.stdout.write(formatFinding(f) + '\n');
  if (findings.length > 0) {
    process.stdout.write(`lint: ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
    process.exit(1);
  }
  process.stdout.write('lint: ok\n');
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
