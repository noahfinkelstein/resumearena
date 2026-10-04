import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@resumearena/shared';
import { assembleJudgePrompt, extractPromptsFromDocs, loadPrompts, renderEnginePromptFiles, stamp } from '../src/llm/prompts.ts';
import { sync } from '../../scripts/prompts-sync.ts';
import { REPO_ROOT } from './helpers/harness.ts';

describe('prompts (D-36)', () => {
  it('engine/prompts equals the canonical docs (prompts:check)', () => {
    const extracted = extractPromptsFromDocs(join(REPO_ROOT, 'docs', 'prompts'));
    const files = renderEnginePromptFiles(extracted);
    for (const [rel, content] of Object.entries(files)) expect(readFileSync(join(REPO_ROOT, 'engine', 'prompts', rel), 'utf8')).toBe(content);
    expect(sync(true)).toBe(0);
  });

  it('assembles four judge prompts with the category block and stamps versions', () => {
    const p = loadPrompts(join(REPO_ROOT, 'engine', 'prompts'));
    for (const cat of CATEGORIES) {
      const text = p.judge.byCategory[cat];
      expect(text).toContain(`pairwise judge for the ${cat} leaderboard`);
      expect(text).toContain(p.judge.blocks[cat]);
      expect(text).not.toContain('{CATEGORY_');
      expect(text).toBe(assembleJudgePrompt(p.judge.template, cat, p.judge.blocks[cat]));
    }
    expect(p.gate.version).toMatch(/^gate\.v1\+[0-9a-f]{8}$/);
    expect(p.analyst.version).toMatch(/^analyst\.v1\+[0-9a-f]{8}$/);
    expect(p.judge.version).toBe(stamp('judge.v1', p.judge.template + CATEGORIES.map((c) => p.judge.blocks[c]).join('')));
    expect(p.gate.text.startsWith('You are the ResumeArena intake classifier')).toBe(true);
    expect(p.analyst.text.endsWith('Return only the JSON object.')).toBe(true);
  });
});
