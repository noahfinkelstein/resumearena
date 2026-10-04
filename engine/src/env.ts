// Process environment → one typed object (§9.1). Read once by the CLI; everything else receives it.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { REPO } from '@resumearena/shared';

export type LlmMode = 'mock' | 'live' | 'record' | 'replay';
export const LLM_MODES: readonly LlmMode[] = ['mock', 'live', 'record', 'replay'];

export interface Env {
  dataDir: string;
  llmMode: LlmMode;
  recordingsDir: string;
  fixturesDir: string;
  repoRoot: string;
  now: string | null;
  seed: string | null;
  runId: string;
  trigger: string;
  eventPath: string | null;
  /** 'production' enables GitHub API calls; anything else skips them with a warning. */
  raEnv: string;
  repo: string;
  noGit: boolean;
  githubToken: string | null;
  anthropicKey: string | null;
  inActions: boolean;
}

/** The repository root is two levels above engine/src; the engine never relies on the cwd for it. */
export function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function isLlmMode(v: string): v is LlmMode {
  return (LLM_MODES as readonly string[]).includes(v);
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const repoRoot = repoRootFromHere();
  const inActions = source.GITHUB_ACTIONS === 'true';
  const modeRaw = source.RA_LLM_MODE?.trim();
  let llmMode: LlmMode = inActions ? 'live' : 'mock';
  if (modeRaw) {
    if (!isLlmMode(modeRaw)) throw new Error(`RA_LLM_MODE must be one of ${LLM_MODES.join('|')}, got "${modeRaw}"`);
    llmMode = modeRaw;
  }
  return {
    dataDir: resolve(source.RA_DATA_DIR?.trim() || './data'),
    llmMode,
    recordingsDir: resolve(source.RA_RECORDINGS_DIR?.trim() || resolve(repoRoot, 'fixtures', 'recordings')),
    fixturesDir: resolve(source.RA_FIXTURES_DIR?.trim() || resolve(repoRoot, 'fixtures')),
    repoRoot,
    now: source.RA_NOW?.trim() || null,
    seed: source.RA_SEED?.trim() || null,
    runId: source.RA_RUN_ID?.trim() || `local-${Date.now()}`,
    trigger: source.RA_TRIGGER?.trim() || 'local',
    eventPath: source.RA_EVENT_PATH?.trim() || null,
    raEnv: source.RA_ENV?.trim() || 'local',
    repo: source.GITHUB_REPOSITORY?.trim() || REPO,
    noGit: source.RA_NO_GIT === '1',
    githubToken: source.GITHUB_TOKEN?.trim() || null,
    anthropicKey: source.ANTHROPIC_API_KEY?.trim() || null,
    inActions,
  };
}

/** `123456789-1` → 123456789; local ids have no numeric part and map to 0. */
export function numericRunId(runId: string): number {
  const m = /^(\d+)/.exec(runId);
  return m ? Number(m[1]) : 0;
}
