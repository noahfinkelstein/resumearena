// `data init <dir>` and `data clone <dir>` (§9.1, platform-github.md §G.1).
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CATEGORIES, DEFAULT_SETTINGS, type Settings } from '@resumearena/shared';
import { openStore, type Store } from '../store/store.ts';
import { GITATTRIBUTES_PATH, GITATTRIBUTES_TEXT, SETTINGS_PATH, STATUS_PATH, anchorsPath } from '../store/paths.ts';
import { emptyStatus } from '../settings.ts';
import { pathExists } from '../store/json.ts';

const execFileP = promisify(execFile);

export interface DataInitOptions {
  now: string;
  settings?: Settings;
  /** Copy anchors/<cat>.json from a fixtures-style directory (tests and mock mode). */
  anchorsDir?: string | null;
  /** Leave an existing settings.json alone. */
  keepExisting?: boolean;
}

/** Write the minimum data tree: settings defaults, an empty status, .gitattributes, optional anchors. */
export async function dataInit(target: string | Store, opts: DataInitOptions): Promise<void> {
  const store = typeof target === 'string' ? openStore(target) : target;
  if (store.kind === 'fs') await mkdir(store.root, { recursive: true });
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  if (!(opts.keepExisting && (await store.exists(SETTINGS_PATH)))) await store.writeJson(SETTINGS_PATH, settings);
  if (!(opts.keepExisting && (await store.exists(STATUS_PATH)))) await store.writeJson(STATUS_PATH, emptyStatus(opts.now, settings));
  await store.writeText(GITATTRIBUTES_PATH, GITATTRIBUTES_TEXT);
  if (opts.anchorsDir) {
    for (const cat of CATEGORIES) {
      const src = join(opts.anchorsDir, `${cat}.json`);
      if (!(await pathExists(src))) continue;
      if (store.kind === 'fs') {
        await mkdir(join(store.root, 'anchors'), { recursive: true });
        await copyFile(src, join(store.root, anchorsPath(cat)));
      } else {
        const { readFile } = await import('node:fs/promises');
        await store.writeText(anchorsPath(cat), await readFile(src, 'utf8'));
      }
    }
  }
}

/** Owner convenience: a blobless sparse clone of the data branch. */
export async function dataClone(dir: string, repo: string): Promise<void> {
  await execFileP('git', ['clone', '--filter=blob:none', '--sparse', '-b', 'data', `https://github.com/${repo}.git`, dir]);
  await execFileP('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', '/settings.json', '/status.json', '/.gitattributes', '/anchors/', '/ratings/', '/queue/', '/arena/', '/usage/', '/failures/', '/audits/']);
}

export async function listAnchorFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
