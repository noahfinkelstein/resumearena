// Filesystem primitives: sorted-key JSON with a trailing newline, atomic writes, JSONL append/read.
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jsonFileText } from '@resumearena/shared';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function readJsonOrNull<T>(p: string): Promise<T | null> {
  const text = await readTextOrNull(p);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`invalid JSON in ${p}: ${(e as Error).message}`);
  }
}

/** Write to a sibling temp file and rename, so a crash never leaves a half-written document. */
export async function writeTextAtomic(p: string, text: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, p);
}

export const writeJsonAtomic = (p: string, value: unknown): Promise<void> => writeTextAtomic(p, jsonFileText(value));

export async function appendLinesFile(p: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(p), { recursive: true });
  // A file that does not end in a newline would glue our first line onto its last one.
  const existing = await readTextOrNull(p);
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(p, `${prefix}${lines.join('\n')}\n`, 'utf8');
}

export function splitLines(text: string): string[] {
  const out = text.split('\n');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export async function readLinesFile(p: string, fromLine = 0): Promise<string[]> {
  const text = await readTextOrNull(p);
  if (text === null) return [];
  const lines = splitLines(text);
  return fromLine > 0 ? lines.slice(fromLine) : lines;
}

export async function removePath(p: string): Promise<void> {
  await rm(p, { force: true, recursive: false });
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return (await readdir(p)).filter((n) => !n.endsWith('.tmp')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Relative paths of every regular file under `dir`, sorted, `.git` skipped. */
export async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (ent.name === '.git' || ent.name.endsWith('.tmp')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await listFilesRecursive(join(dir, ent.name), rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}
