// Browser storage under resumearena.* (§11.4). Every access is try/catch-wrapped: a private window or
// blocked storage yields defaults and the site still reads. Writers notify same-tab listeners; the
// `storage` event covers other tabs.
import type { Category, EntryRecord, SubmissionPayload } from '@resumearena/shared';

export const KEYS = {
  theme: 'resumearena.theme',
  keys: 'resumearena.keys',
  entries: 'resumearena.entries',
  revealed: 'resumearena.revealed',
  arena: 'resumearena.arena',
  reloaded: 'resumearena.reloaded',
  draft: 'resumearena.draft',
  probe: 'resumearena.probe',
  /** Session flag: the contents API answered 403/429, read raw only (data.ts). */
  apiOff: 'resumearena.apiOff',
  mockProbe: 'resumearena.mockProbe',
} as const;

export type StorageKey = (typeof KEYS)[keyof typeof KEYS];

export type Theme = 'paper' | 'night';
export type KeysMap = Record<string, string>;
export type EntriesMap = Record<string, EntryRecord>;
export type RevealedMap = Record<string, true>;
export interface ArenaState {
  streak: number;
  best: number;
  guesses: number;
  agreed: number;
  seen: string[];
  lastCategory: Category | null;
  /** Consecutive disagreements, for the wry line. */
  disagreeRun: number;
}
export interface Draft {
  text: string;
  redactions: { kind: string; original: string; token: string; index: number }[];
  metrics: unknown;
  source: 'pdf' | 'docx' | 'paste';
  handle?: string;
  ladder_hint?: Category;
  visibility?: 'handle' | 'anonymous';
  fileName?: string;
  /**
   * The last dispatched payload, so a collision or a stale entry can be resent from this browser. Stored
   * without `owner_key`: the raw key lives only under resumearena.keys and is re-attached at send time.
   */
  sent?: { id: string; payload: SubmissionPayload; withKey?: boolean };
}
export interface ProbeCache {
  at: number;
  v: 'ok' | 'dead' | 'limited' | 'unknown';
}

type Area = 'local' | 'session';

function area(kind: Area): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function readRaw(key: StorageKey, kind: Area = 'local'): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeRaw(key: StorageKey, value: string | null, kind: Area = 'local'): boolean {
  try {
    const s = area(kind);
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    notify(key);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T>(key: StorageKey, fallback: T, kind: Area = 'local'): T {
  const raw = readRaw(key, kind);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: StorageKey, value: unknown, kind: Area = 'local'): boolean {
  return writeRaw(key, value === null || value === undefined ? null : JSON.stringify(value), kind);
}

type Listener = (key: StorageKey | null) => void;
const listeners = new Set<Listener>();
let windowBound = false;

function notify(key: StorageKey | null): void {
  for (const l of listeners) l(key);
}

/** Subscribe to writes from this tab and `storage` events from other tabs. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!windowBound && typeof window !== 'undefined') {
    windowBound = true;
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key.startsWith('resumearena.')) notify((e.key as StorageKey | null) ?? null);
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

// ---- typed accessors -----------------------------------------------------------------------------

export const readTheme = (): Theme | null => {
  const t = readRaw(KEYS.theme);
  return t === 'paper' || t === 'night' ? t : null;
};
export const writeTheme = (t: Theme): boolean => writeRaw(KEYS.theme, t);

export const readKeys = (): KeysMap => sanitizeRecord(readJson<KeysMap>(KEYS.keys, {}));
export const writeKeys = (m: KeysMap): boolean => writeJson(KEYS.keys, m);

export const readEntries = (): EntriesMap => sanitizeRecord(readJson<EntriesMap>(KEYS.entries, {}));
export const writeEntries = (m: EntriesMap): boolean => writeJson(KEYS.entries, m);

export const readRevealed = (): RevealedMap => sanitizeRecord(readJson<RevealedMap>(KEYS.revealed, {}));
export const markRevealed = (id: string): boolean => writeJson(KEYS.revealed, { ...readRevealed(), [id]: true });

export const EMPTY_ARENA: ArenaState = { streak: 0, best: 0, guesses: 0, agreed: 0, seen: [], lastCategory: null, disagreeRun: 0 };
export function readArena(): ArenaState {
  const a = readJson<Partial<ArenaState>>(KEYS.arena, {});
  return {
    streak: num(a.streak),
    best: num(a.best),
    guesses: num(a.guesses),
    agreed: num(a.agreed),
    seen: Array.isArray(a.seen) ? a.seen.filter((s): s is string => typeof s === 'string').slice(-300) : [],
    lastCategory: a.lastCategory ?? null,
    disagreeRun: num(a.disagreeRun),
  };
}
export const writeArena = (a: ArenaState): boolean => writeJson(KEYS.arena, { ...a, seen: a.seen.slice(-300) });

export const readDraft = (): Draft | null => readJson<Draft | null>(KEYS.draft, null, 'session');
export const writeDraft = (d: Draft | null): boolean => writeJson(KEYS.draft, d, 'session');

export const readProbe = (): ProbeCache | null => readJson<ProbeCache | null>(KEYS.probe, null, 'session');
export const writeProbe = (p: ProbeCache | null): boolean => writeJson(KEYS.probe, p, 'session');

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function sanitizeRecord<T extends Record<string, unknown>>(v: unknown): T {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : ({} as T);
}
