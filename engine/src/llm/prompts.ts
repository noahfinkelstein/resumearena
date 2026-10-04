// Prompts (D-36). `docs/prompts/*.md` are canonical; this module extracts their fenced blocks (used by
// scripts/prompts-sync.ts), writes/loads `engine/prompts/*`, assembles the four judge prompts and stamps
// versions as `<name>+<8 hex of sha256(assembled text)>`.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, type Category } from '@resumearena/shared';
import { sha256Hex } from '../rng.ts';

export interface ExtractedPrompts {
  gate: string;
  analyst: string;
  judgeTemplate: string;
  judgeBlocks: Record<Category, string>;
}

export interface PromptSet {
  gate: { text: string; version: string };
  analyst: { text: string; version: string };
  judge: { template: string; blocks: Record<Category, string>; byCategory: Record<Category, string>; version: string };
}

export const PROMPT_FILES = {
  gate: 'gate.v1.md',
  analyst: 'analyst.v1.md',
  judge: 'judge.v1.md',
  judgeBlock: (cat: Category) => `judge-blocks/${cat}.md`,
} as const;

export const stamp = (name: string, text: string): string => `${name}+${sha256Hex(text).slice(0, 8)}`;

/** All ```text fenced blocks of a markdown document, in order, without the fence lines. */
export function fencedTextBlocks(markdown: string): string[] {
  const out: string[] = [];
  const re = /^```text[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) out.push(m[1] ?? '');
  return out;
}

/** Fenced block under `### <heading>`; the judge doc keeps one per category. */
function blockUnderHeading(markdown: string, heading: string): string {
  const re = new RegExp(`^### ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm');
  const section = re.exec(markdown)?.[1];
  if (!section) throw new Error(`docs/prompts/judge.md: missing "### ${heading}" section`);
  const block = fencedTextBlocks(section)[0];
  if (block === undefined) throw new Error(`docs/prompts/judge.md: "### ${heading}" has no fenced text block`);
  return block;
}

function singleBlock(markdown: string, name: string): string {
  const blocks = fencedTextBlocks(markdown);
  if (blocks.length !== 1) throw new Error(`docs/prompts/${name}: expected exactly one fenced text block, found ${blocks.length}`);
  return blocks[0] as string;
}

export function extractPromptsFromDocs(docsPromptsDir: string): ExtractedPrompts {
  const read = (f: string): string => readFileSync(join(docsPromptsDir, f), 'utf8');
  const judgeDoc = read('judge.md');
  const judgeTemplate = fencedTextBlocks(judgeDoc)[0];
  if (!judgeTemplate) throw new Error('docs/prompts/judge.md: missing template block');
  const judgeBlocks = Object.fromEntries(CATEGORIES.map((c) => [c, blockUnderHeading(judgeDoc, c)])) as Record<Category, string>;
  return { gate: singleBlock(read('gate.md'), 'gate.md'), analyst: singleBlock(read('analysis-system.md'), 'analysis-system.md'), judgeTemplate, judgeBlocks };
}

/** The files `engine/prompts/` holds, keyed by relative path. Content is the block text plus one newline. */
export function renderEnginePromptFiles(p: ExtractedPrompts): Record<string, string> {
  const files: Record<string, string> = {
    [PROMPT_FILES.gate]: `${p.gate}\n`,
    [PROMPT_FILES.analyst]: `${p.analyst}\n`,
    [PROMPT_FILES.judge]: `${p.judgeTemplate}\n`,
  };
  for (const cat of CATEGORIES) files[PROMPT_FILES.judgeBlock(cat)] = `${p.judgeBlocks[cat]}\n`;
  return files;
}

export function assembleJudgePrompt(template: string, cat: Category, block: string): string {
  return template.replaceAll('{CATEGORY_NAME}', cat).replaceAll('{CATEGORY_BLOCK}', block);
}

const stripOneNewline = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);

export function promptSetFrom(p: ExtractedPrompts): PromptSet {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, assembleJudgePrompt(p.judgeTemplate, c, p.judgeBlocks[c])])) as Record<Category, string>;
  const judgeStampInput = p.judgeTemplate + CATEGORIES.map((c) => p.judgeBlocks[c]).join('');
  return {
    gate: { text: p.gate, version: stamp('gate.v1', p.gate) },
    analyst: { text: p.analyst, version: stamp('analyst.v1', p.analyst) },
    judge: { template: p.judgeTemplate, blocks: p.judgeBlocks, byCategory, version: stamp('judge.v1', judgeStampInput) },
  };
}

/** Load the generated `engine/prompts/` tree; falls back to extracting from docs when it is absent (fresh clone before prompts:sync). */
export function loadPrompts(enginePromptsDir: string, docsPromptsDir?: string): PromptSet {
  const gatePath = join(enginePromptsDir, PROMPT_FILES.gate);
  if (!existsSync(gatePath)) {
    if (!docsPromptsDir) throw new Error(`prompts missing at ${enginePromptsDir}; run pnpm prompts:sync`);
    return promptSetFrom(extractPromptsFromDocs(docsPromptsDir));
  }
  const read = (f: string): string => stripOneNewline(readFileSync(join(enginePromptsDir, f), 'utf8'));
  const judgeBlocks = Object.fromEntries(CATEGORIES.map((c) => [c, read(PROMPT_FILES.judgeBlock(c))])) as Record<Category, string>;
  return promptSetFrom({ gate: read(PROMPT_FILES.gate), analyst: read(PROMPT_FILES.analyst), judgeTemplate: read(PROMPT_FILES.judge), judgeBlocks });
}
