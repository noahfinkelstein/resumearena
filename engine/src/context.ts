// Everything a command needs, built once by the CLI and overridable by tests and the simulation.
import { join } from 'node:path';
import { createClock, type MutableClock } from './clock.ts';
import { readEnv, type Env, type LlmMode } from './env.ts';
import { createGithub, type GithubClient } from './github/api.ts';
import { createTransport } from './llm/transport.ts';
import type { LlmTransport } from './llm/client.ts';
import { loadPrompts, type PromptSet } from './llm/prompts.ts';
import { commitWithRetry, type CommitFn } from './store/commit.ts';
import { openStore, type Store } from './store/store.ts';
import { consoleLogger, type Logger } from './summary.ts';

export interface Context {
  env: Env;
  clock: MutableClock;
  store: Store;
  transport: LlmTransport;
  prompts: PromptSet;
  github: GithubClient;
  /** RA_SEED or the run id: the root of every PRNG stream. */
  seed: string;
  runId: string;
  log: Logger;
  commit: CommitFn;
}

export interface ContextOverrides {
  env?: Env;
  dataDir?: string;
  llmMode?: LlmMode;
  clock?: MutableClock;
  store?: Store;
  transport?: LlmTransport;
  prompts?: PromptSet;
  github?: GithubClient;
  seed?: string;
  runId?: string;
  log?: Logger;
  commit?: CommitFn;
}

export function createContext(o: ContextOverrides = {}): Context {
  const env = o.env ?? readEnv();
  const store = o.store ?? openStore(o.dataDir ?? env.dataDir);
  const log = o.log ?? consoleLogger;
  const runId = o.runId ?? env.runId;
  const seed = o.seed ?? env.seed ?? runId;
  const prompts = o.prompts ?? loadPrompts(join(env.repoRoot, 'engine', 'prompts'), join(env.repoRoot, 'docs', 'prompts'));
  const transport = o.transport ?? lazyTransport(o.llmMode ?? env.llmMode, () => createTransport(env, o.llmMode ?? env.llmMode, { seed }));
  const commit: CommitFn = o.commit ?? ((message, mutations) => commitWithRetry(store, message, mutations, { noGit: env.noGit }));
  return {
    env,
    clock: o.clock ?? createClock(env.now),
    store,
    transport,
    prompts,
    github: o.github ?? createGithub(env, { log }),
    seed,
    runId,
    log,
    commit,
  };
}

/**
 * Commands that never call a model (build-indexes, record-failure, status, data) must not need an API
 * key, so the live client is constructed on the first call rather than at context creation; a missing
 * key still fails the first model call with LlmConfigError (exit 1) exactly as before.
 */
export function lazyTransport(mode: LlmMode, make: () => LlmTransport): LlmTransport {
  let inner: LlmTransport | null = null;
  return {
    mode,
    // async so a constructor failure (missing key) surfaces as a rejection like any other call error.
    async call(req) {
      inner ??= make();
      return inner.call(req);
    },
  };
}
