// commitWithRetry against a local bare repository: two writers on one shard both land; a squash
// between attempts does not stop a writer.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitWithRetry, upsertJson, appendLines } from '../src/store/commit.ts';
import { git, squashDataHistory } from '../src/store/git.ts';

const execFileP = promisify(execFile);
const sh = (cwd: string, args: string[]) => execFileP('git', ['-C', cwd, ...args]);

let root: string;
let bare: string;

async function clone(name: string): Promise<string> {
  const dir = join(root, name);
  await execFileP('git', ['clone', '-q', '-b', 'data', bare, dir]);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ra-commit-'));
  bare = join(root, 'origin.git');
  await execFileP('git', ['init', '-q', '--bare', bare]);
  const seed = join(root, 'seed');
  await execFileP('git', ['init', '-q', '-b', 'data', seed]);
  await writeFile(join(seed, 'settings.json'), '{}\n');
  await sh(seed, ['add', '-A']);
  await sh(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'data: init']);
  await sh(seed, ['remote', 'add', 'origin', bare]);
  await sh(seed, ['push', '-q', 'origin', 'data']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('commitWithRetry', () => {
  it('two concurrent writers on the same shard both land and the file is the union', async () => {
    const a = await clone('a');
    const b = await clone('b');
    const shard = 'rows/ab.json';
    const results = await Promise.all([
      commitWithRetry(a, 'writer a', [upsertJson<Record<string, number>>(shard, (cur) => ({ ...(cur ?? {}), a: 1 })), appendLines('usage/2026-10-03.jsonl', [{ w: 'a' }])], { sleep: async () => {} }),
      commitWithRetry(b, 'writer b', [upsertJson<Record<string, number>>(shard, (cur) => ({ ...(cur ?? {}), b: 2 })), appendLines('usage/2026-10-03.jsonl', [{ w: 'b' }])], { sleep: async () => {} }),
    ]);
    expect(results).toEqual(['pushed', 'pushed']);
    const check = await clone('check');
    const merged = JSON.parse(await readFile(join(check, shard), 'utf8')) as Record<string, number>;
    expect(merged).toEqual({ a: 1, b: 2 });
    const lines = (await readFile(join(check, 'usage/2026-10-03.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.length).toBe(2);
    const log = (await sh(check, ['log', '--oneline'])).stdout.trim().split('\n');
    expect(log.length).toBe(3);
  });

  it('a noop mutation does not create a commit', async () => {
    const a = await clone('a');
    const r = await commitWithRetry(a, 'nothing', [upsertJson<Record<string, unknown>>('settings.json', (cur) => cur ?? {})]);
    expect(r).toBe('noop');
  });

  it('squash-while-writing: a force-pushed snapshot between attempts still lets the writer land', async () => {
    const a = await clone('a');
    const squasher = await clone('squasher');
    let squashed = false;
    const r = await commitWithRetry(a, 'writer after squash', [upsertJson<Record<string, number>>('rows/zz.json', (cur) => ({ ...(cur ?? {}), z: 1 }))], {
      sleep: async () => {},
      beforePush: async () => {
        if (squashed) return;
        squashed = true;
        // Another process lands a commit and squashes the branch history to one snapshot.
        await commitWithRetry(squasher, 'other writer', [upsertJson<Record<string, number>>('rows/yy.json', () => ({ y: 1 }))]);
        await squashDataHistory(squasher, { date: '2026-10-05', sleep: async () => {} });
      },
    });
    expect(r).toBe('pushed');
    const check = await clone('check');
    expect(JSON.parse(await readFile(join(check, 'rows/zz.json'), 'utf8'))).toEqual({ z: 1 });
    expect(JSON.parse(await readFile(join(check, 'rows/yy.json'), 'utf8'))).toEqual({ y: 1 });
    const log = (await git(check, ['log', '--oneline'])).stdout.trim().split('\n');
    expect(log.length).toBe(2); // snapshot + the writer's commit on top
  });

  it('without a remote it commits locally; with noGit it only writes', async () => {
    const local = join(root, 'local');
    await execFileP('git', ['init', '-q', '-b', 'data', local]);
    const r = await commitWithRetry(local, 'local commit', [upsertJson('a.json', () => ({ a: 1 }))]);
    expect(r).toBe('pushed');
    expect((await sh(local, ['log', '--oneline'])).stdout.trim().split('\n').length).toBe(1);
    const plain = join(root, 'plain');
    await rm(plain, { recursive: true, force: true });
    const r2 = await commitWithRetry(plain, 'no git', [upsertJson('b.json', () => ({ b: 1 }))], { noGit: true });
    expect(r2).toBe('pushed');
    expect(JSON.parse(await readFile(join(plain, 'b.json'), 'utf8'))).toEqual({ b: 1 });
  });
});
