// Resolves which maintenance action a run of maintenance.yml performs (spec §8.5, D-58).
//
//   node scripts/plan-maintenance.ts --event schedule|push [--dir ops/commands] [--out "$GITHUB_OUTPUT"]
//
// schedule → `nightly`. push → the newest command file under ops/commands/ whose name is not listed in
// ops/commands/.done. Prints `action`, `args`, `group` and `file` as GITHUB_OUTPUT lines (to --out when given,
// else to stdout). When nothing is pending every output is empty and the `run` job is skipped by its `if`.
// Node 24, no dependencies, erasable syntax only.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type MaintenanceAction =
  | 'nightly'
  | 'drain-queue'
  | 'squash-data-history'
  | 'rebuild-indexes'
  | 'reanalyze'
  | 'rotate-anchors'
  | 'validate-anchors';

export const GROUP_OF: Record<MaintenanceAction, 'rerank' | 'maintenance-long'> = {
  nightly: 'rerank',
  'drain-queue': 'rerank',
  'squash-data-history': 'rerank',
  'rebuild-indexes': 'rerank',
  reanalyze: 'maintenance-long',
  'rotate-anchors': 'maintenance-long',
  'validate-anchors': 'maintenance-long',
};

export const COMMAND_FILE_RE = /^\d{8}-\d{4}-[a-z-]+\.json$/;

export interface Plan {
  action: MaintenanceAction | '';
  args: string; // JSON object, one line
  group: 'rerank' | 'maintenance-long' | '';
  file: string; // command file name, '' on schedule
}

export class PlanError extends Error {
  file: string;
  constructor(file: string, message: string) {
    super(message);
    this.file = file;
  }
}

const EMPTY: Plan = { action: '', args: '', group: '', file: '' };

/** Names already processed: the first whitespace-separated token of every non-empty line of `.done`. */
export function readDone(dir: string): Set<string> {
  const path = join(dir, '.done');
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((n) => n.length > 0),
  );
}

export function pendingCommandFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const done = readDone(dir);
  // Names start with YYYYMMDD-HHMM, so a descending string sort is newest first.
  return readdirSync(dir)
    .filter((n) => COMMAND_FILE_RE.test(n) && !done.has(n))
    .sort()
    .reverse();
}

export function parseCommandFile(dir: string, file: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    throw new PlanError(file, `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PlanError(file, 'must be a JSON object { "action": …, "args": {…} }');
  }
  const { action, args } = parsed as { action?: unknown; args?: unknown };
  if (typeof action !== 'string' || !(action in GROUP_OF)) {
    throw new PlanError(file, `unknown action ${JSON.stringify(action)}; expected one of ${Object.keys(GROUP_OF).join(', ')}`);
  }
  const argsValue = args === undefined ? {} : args;
  if (typeof argsValue !== 'object' || argsValue === null || Array.isArray(argsValue)) {
    throw new PlanError(file, '"args" must be a JSON object when present');
  }
  const typedAction = action as MaintenanceAction;
  return { action: typedAction, args: JSON.stringify(argsValue), group: GROUP_OF[typedAction], file };
}

export function plan(event: string, dir: string): Plan {
  if (event === 'schedule') return { action: 'nightly', args: '{}', group: 'rerank', file: '' };
  if (event !== 'push') throw new Error(`unsupported event "${event}"; expected schedule or push`);
  const [newest] = pendingCommandFiles(dir);
  return newest === undefined ? EMPTY : parseCommandFile(dir, newest);
}

/** GITHUB_OUTPUT syntax; the heredoc form keeps a value with newlines intact (JSON never has them, belt and braces). */
export function formatOutputs(p: Plan): string {
  return (Object.entries(p) as [string, string][])
    .map(([k, v]) => (v.includes('\n') ? `${k}<<RA_EOF_${k}\n${v}\nRA_EOF_${k}\n` : `${k}=${v}\n`))
    .join('');
}

function main(): void {
  const { values } = parseArgs({
    options: {
      event: { type: 'string' },
      dir: { type: 'string', default: 'ops/commands' },
      out: { type: 'string' },
    },
  });
  const event = values.event ?? process.env.GITHUB_EVENT_NAME ?? '';
  const dir = values.dir ?? 'ops/commands';
  let result: Plan;
  try {
    result = plan(event, dir);
  } catch (e) {
    if (e instanceof PlanError) {
      process.stdout.write(`::error file=${join(dir, e.file)}::${e.message}\n`);
    } else {
      process.stdout.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
    }
    process.exit(1);
  }
  const text = formatOutputs(result);
  if (values.out) appendFileSync(values.out, text);
  else process.stdout.write(text);
  if (result.action === '') process.stdout.write('::notice::no pending command file; nothing to run\n');
  else process.stdout.write(`::notice::maintenance ${result.action} (group ${result.group}${result.file ? `, ${result.file}` : ''})\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
