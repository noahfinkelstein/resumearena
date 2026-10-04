#!/usr/bin/env node
// `pnpm prompts:sync` copies the canonical prompt blocks from docs/prompts into engine/prompts (D-36);
// `pnpm prompts:check` asserts equality and exits 1 on drift (CI).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPromptsFromDocs, promptSetFrom, renderEnginePromptFiles } from '../engine/src/llm/prompts.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(repoRoot, 'docs', 'prompts');
const engineDir = join(repoRoot, 'engine', 'prompts');

export function sync(check: boolean): number {
  const extracted = extractPromptsFromDocs(docsDir);
  const files = renderEnginePromptFiles(extracted);
  const versions = promptSetFrom(extracted);
  let drift = 0;
  for (const [rel, content] of Object.entries(files)) {
    const path = join(engineDir, rel);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      console.error(`prompts:check: ${rel} ${current === null ? 'is missing' : 'differs from docs/prompts'}`);
      drift++;
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    console.log(`prompts:sync: wrote engine/prompts/${rel}`);
  }
  console.log(`prompts: gate ${versions.gate.version} · analyst ${versions.analyst.version} · judge ${versions.judge.version}`);
  if (check && drift) {
    console.error(`prompts:check: ${drift} file(s) out of date; run pnpm prompts:sync`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) process.exitCode = sync(process.argv.includes('--check'));
