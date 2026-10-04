// Thin git wrapper for the data checkout: fetch/reset/add/commit/push and the history squash (D-29).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathExists } from './json.ts';

const execFileP = promisify(execFile);

export const BOT_NAME = 'resumearena-bot';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], stderr: string, cause: unknown) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

export async function git(root: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  const full = ['-C', root, '-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, ...args];
  try {
    const { stdout, stderr } = await execFileP('git', full, { maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } });
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    throw new GitError(args, String(err.stderr ?? ''), e);
  }
}

export const isGitRepo = (root: string): Promise<boolean> => pathExists(join(root, '.git'));

export async function hasRemote(root: string, name = 'origin'): Promise<boolean> {
  try {
    const { stdout } = await git(root, ['remote']);
    return stdout.split(/\s+/).includes(name);
  } catch {
    return false;
  }
}

export async function isSparse(root: string): Promise<boolean> {
  try {
    const { stdout } = await git(root, ['config', '--get', 'core.sparseCheckout']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** `git sparse-checkout add --no-cone <patterns>`: one batched blob fetch on a partial clone. No-op on a full checkout. */
export async function sparseAdd(root: string, patterns: readonly string[]): Promise<void> {
  if (patterns.length === 0 || !(await isSparse(root))) return;
  await git(root, ['sparse-checkout', 'add', '--no-cone', ...patterns]);
}

export async function headSha(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    return null;
  }
}

export const isPushRace = (stderr: string): boolean => /non-fast-forward|fetch first|rejected|cannot lock ref|stale info/i.test(stderr);

/**
 * Replace the branch history with one snapshot of its current tree (D-29). `--force-with-lease` against
 * the tip we fetched, so a writer that lands between fetch and push makes the lease fail and we retry.
 */
export async function squashDataHistory(root: string, opts: { branch?: string; date: string; attempts?: number; sleep?: (ms: number) => Promise<void> }): Promise<string> {
  const branch = opts.branch ?? 'data';
  const attempts = opts.attempts ?? 8;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    await git(root, ['fetch', '--filter=blob:none', 'origin', branch]);
    const tip = (await git(root, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
    const tree = (await git(root, ['rev-parse', 'FETCH_HEAD^{tree}'])).stdout.trim();
    const fresh = (await git(root, ['commit-tree', tree, '-m', `data: snapshot ${opts.date}`])).stdout.trim();
    try {
      await git(root, ['push', `--force-with-lease=refs/heads/${branch}:${tip}`, 'origin', `${fresh}:refs/heads/${branch}`]);
      return fresh;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof GitError) || !isPushRace(e.stderr)) throw e;
      await sleep(400 * 2 ** i + Math.random() * 400);
    }
  }
  throw new Error(`squash-data-history: lease failed ${attempts} times: ${String(lastErr)}`);
}
