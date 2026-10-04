// The fetch-reset-reapply-push loop (§9.2, platform-github.md §C.5). A writer describes its change as an
// idempotent function over the tree; every attempt resets to the remote tip and runs it again, so the
// handle-claim race and the JSONL appends are re-evaluated on fresh state instead of merged.
import { type Store, openStore } from './store.ts';
import { GitError, git, hasRemote, isGitRepo, isPushRace } from './git.ts';

export interface Mutation {
  /** Sparse patterns the mutation touches; materialized before the first attempt. */
  paths: string[];
  apply(store: Store): Promise<void>;
}

export interface CommitOptions {
  attempts?: number;
  branch?: string;
  /** RA_NO_GIT: write files, never commit. */
  noGit?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each attempt's apply and before the push; tests inject faults here. */
  beforePush?: (attempt: number) => Promise<void>;
}

export type CommitResult = 'pushed' | 'noop';
export type CommitFn = (message: string, mutations: Mutation[]) => Promise<CommitResult>;

export class ConflictError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`conflict: ${path} already exists`);
    this.name = 'ConflictError';
    this.path = path;
  }
}

export class PushRejectedError extends Error {
  constructor(message: string, attempts: number) {
    super(`data: push rejected ${attempts} times for "${message}"`);
    this.name = 'PushRejectedError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function applyAll(store: Store, mutations: readonly Mutation[]): Promise<void> {
  for (const m of mutations) await m.apply(store);
}

/**
 * Apply `mutations` and land them on `branch`. With a remote: fetch, reset, re-apply, add, commit, push,
 * retrying push races with exponential backoff. Without a remote: commit locally. On a plain directory
 * or with `noGit`: just write. Memory stores apply once.
 */
export async function commitWithRetry(target: Store | string, message: string, mutations: Mutation[], opts: CommitOptions = {}): Promise<CommitResult> {
  const store = typeof target === 'string' ? openStore(target) : target;
  const attempts = opts.attempts ?? 8;
  const branch = opts.branch ?? 'data';
  const sleep = opts.sleep ?? defaultSleep;

  if (store.kind === 'memory') {
    const mem = store as Store & { dirty: boolean };
    mem.dirty = false;
    await applyAll(store, mutations);
    await opts.beforePush?.(0);
    const changed = mem.dirty;
    mem.dirty = false;
    return changed ? 'pushed' : 'noop';
  }

  const root = store.root;
  const patterns = [...new Set(mutations.flatMap((m) => m.paths))];
  const gitRepo = !opts.noGit && (await isGitRepo(root));
  if (!gitRepo) {
    await applyAll(store, mutations);
    await opts.beforePush?.(0);
    return 'pushed';
  }
  await store.materialize(patterns);
  const remote = await hasRemote(root);

  for (let i = 0; i < attempts; i++) {
    if (remote) {
      await git(root, ['fetch', '--depth=1', 'origin', branch]);
      await git(root, ['reset', '--hard', 'FETCH_HEAD']);
    }
    await applyAll(store, mutations);
    await git(root, ['add', '--sparse', '-A']);
    const { stdout } = await git(root, ['status', '--porcelain']);
    if (!stdout.trim()) return 'noop';
    await git(root, ['commit', '-q', '-m', message]);
    await opts.beforePush?.(i);
    if (!remote) return 'pushed';
    try {
      await git(root, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
      return 'pushed';
    } catch (e) {
      if (!(e instanceof GitError) || !isPushRace(e.stderr)) throw e;
      await sleep(400 * 2 ** i + Math.random() * 400);
    }
  }
  throw new PushRejectedError(message, attempts);
}

// ---- mutation helpers -----------------------------------------------------------------------------

export const upsertJson = <T>(path: string, f: (cur: T | undefined) => T): Mutation => ({
  paths: [path],
  apply: async (store) => {
    const cur = (await store.readJson<T>(path)) ?? undefined;
    await store.writeJson(path, f(cur));
  },
});

export const writeJson = (path: string, value: unknown): Mutation => ({ paths: [path], apply: (store) => store.writeJson(path, value) });

export const createJson = (path: string, value: unknown): Mutation => ({
  paths: [path],
  apply: async (store) => {
    if (await store.exists(path)) throw new ConflictError(path);
    await store.writeJson(path, value);
  },
});

export const appendLines = (path: string, lines: readonly object[]): Mutation => ({
  paths: [path],
  apply: (store) => store.appendLines(path, lines.map((l) => JSON.stringify(l))),
});

export const removeFile = (path: string): Mutation => ({ paths: [path], apply: (store) => store.remove(path) });

/** A mutation whose write set is computed from the fresh tree: the whole submit write set is one of these. */
export const decide = (paths: string[], fn: (store: Store) => Promise<void>): Mutation => ({ paths, apply: fn });

/** Several mutations as one, sharing one materialize call. */
export const group = (mutations: readonly Mutation[]): Mutation => ({
  paths: [...new Set(mutations.flatMap((m) => m.paths))],
  apply: (store) => applyAll(store, mutations),
});
