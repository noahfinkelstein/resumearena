// The Store: the engine's only view of the data tree (§9.2). Two implementations share one interface so
// the simulation and the fault-injection tests run the real commands against memory.
import { join } from 'node:path';
import { jsonFileText } from '@resumearena/shared';
import { appendLinesFile, fileSize, listDir, listFilesRecursive, pathExists, readJsonOrNull, readLinesFile, readTextOrNull, removePath, splitLines, writeJsonAtomic, writeTextAtomic } from './json.ts';
import { sparseAdd } from './git.ts';

export interface Store {
  readonly kind: 'fs' | 'memory';
  /** Filesystem root; a synthetic label for the memory store. */
  readonly root: string;
  readText(rel: string): Promise<string | null>;
  readJson<T>(rel: string): Promise<T | null>;
  writeText(rel: string, text: string): Promise<void>;
  /** Sorted keys, trailing newline, atomic. */
  writeJson(rel: string, value: unknown): Promise<void>;
  appendLines(rel: string, lines: readonly string[]): Promise<void>;
  readLines(rel: string, fromLine?: number): Promise<string[]>;
  /** Direct children of a directory (files and directories), sorted; [] when missing. */
  list(relDir: string): Promise<string[]>;
  /** Every file below a directory as a relative path from the store root, sorted. */
  listFiles(relDir: string): Promise<string[]>;
  remove(rel: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  size(rel: string): Promise<number>;
  /** Make these sparse patterns present in a partial clone; harmless elsewhere. */
  materialize(patterns: readonly string[]): Promise<void>;
}

const norm = (rel: string): string => rel.replace(/^\/+/, '').replace(/\/+$/, '');

export function openStore(root: string): Store {
  const abs = (rel: string): string => join(root, norm(rel));
  return {
    kind: 'fs',
    root,
    readText: (rel) => readTextOrNull(abs(rel)),
    readJson: (rel) => readJsonOrNull(abs(rel)),
    writeText: (rel, text) => writeTextAtomic(abs(rel), text),
    writeJson: (rel, value) => writeJsonAtomic(abs(rel), value),
    appendLines: (rel, lines) => appendLinesFile(abs(rel), lines),
    readLines: (rel, fromLine = 0) => readLinesFile(abs(rel), fromLine),
    list: (relDir) => listDir(abs(relDir)),
    listFiles: async (relDir) => {
      const d = norm(relDir);
      const files = await listFilesRecursive(abs(relDir));
      return files.map((f) => (d ? `${d}/${f}` : f));
    },
    remove: (rel) => removePath(abs(rel)),
    exists: (rel) => pathExists(abs(rel)),
    size: (rel) => fileSize(abs(rel)),
    materialize: (patterns) => sparseAdd(root, patterns),
  };
}

/** In-memory tree for the simulation and tests. `snapshot()`/`restore()` give tests a cheap "remote". */
export interface MemoryStore extends Store {
  readonly kind: 'memory';
  files: Map<string, string>;
  /** Set whenever a write happens; the memory commit loop reads and clears it. */
  dirty: boolean;
  snapshot(): Map<string, string>;
  restore(files: Map<string, string>): void;
}

export function openMemoryStore(label = 'memory'): MemoryStore {
  const files = new Map<string, string>();
  const self: MemoryStore = {
    kind: 'memory',
    root: label,
    files,
    dirty: false,
    snapshot: () => new Map(files),
    restore(next) {
      files.clear();
      for (const [k, v] of next) files.set(k, v);
    },
    readText: async (rel) => files.get(norm(rel)) ?? null,
    readJson: async (rel) => {
      const t = files.get(norm(rel));
      return t === undefined ? null : JSON.parse(t);
    },
    writeText: async (rel, text) => {
      files.set(norm(rel), text);
      self.dirty = true;
    },
    writeJson: async (rel, value) => {
      files.set(norm(rel), jsonFileText(value));
      self.dirty = true;
    },
    appendLines: async (rel, lines) => {
      if (lines.length === 0) return;
      const k = norm(rel);
      const cur = files.get(k) ?? '';
      const prefix = cur && !cur.endsWith('\n') ? '\n' : '';
      files.set(k, `${cur}${prefix}${lines.join('\n')}\n`);
      self.dirty = true;
    },
    readLines: async (rel, fromLine = 0) => {
      const t = files.get(norm(rel));
      if (t === undefined) return [];
      const lines = splitLines(t);
      return fromLine > 0 ? lines.slice(fromLine) : lines;
    },
    list: async (relDir) => {
      const d = norm(relDir);
      const prefix = d ? `${d}/` : '';
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...names].sort();
    },
    listFiles: async (relDir) => {
      const d = norm(relDir);
      const prefix = d ? `${d}/` : '';
      return [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    remove: async (rel) => {
      if (files.delete(norm(rel))) self.dirty = true;
    },
    exists: async (rel) => files.has(norm(rel)),
    size: async (rel) => Buffer.byteLength(files.get(norm(rel)) ?? '', 'utf8'),
    materialize: async () => {},
  };
  return self;
}
