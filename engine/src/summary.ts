// Step summary (`$GITHUB_STEP_SUMMARY`), job outputs (`$GITHUB_OUTPUT`) and logging.
// Summaries carry ids, outcomes and numbers; never résumé text, cards or judge reasons (§9.3 step 12).
import { appendFile } from 'node:fs/promises';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`::warning::${m}`),
  error: (m) => console.error(`::error::${m}`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export async function writeSummary(path: string | null | undefined, markdown: string): Promise<void> {
  if (!path) return;
  await appendFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
}

/** `key=value` lines for `$GITHUB_OUTPUT`; values are single-line. */
export async function writeOutputs(path: string | null | undefined, values: Record<string, string | number | boolean>): Promise<void> {
  if (!path) return;
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`)
    .join('\n');
  await appendFile(path, `${text}\n`, 'utf8');
}

export function markdownTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|'));
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}
