// Identity without accounts (§11.3, product-ux.md §6.4): the keys and entries this browser holds, as an
// external store so every component sees the same thing and tabs stay in sync.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { hashOwnerKey, parseOwnerKey, type EntryRecord } from '@resumearena/shared';
import { KEYS, readEntries, readKeys, subscribe, writeEntries, writeKeys, type EntriesMap, type KeysMap } from './storage.ts';

export interface IdentitySnapshot {
  keys: KeysMap;
  entries: EntriesMap;
}

let snapshot: IdentitySnapshot = { keys: readKeys(), entries: readEntries() };
const hashCache = new Map<string, Promise<string>>();

function refresh(): void {
  snapshot = { keys: readKeys(), entries: readEntries() };
}

function subscribeIdentity(cb: () => void): () => void {
  return subscribe((key) => {
    if (key === null || key === KEYS.keys || key === KEYS.entries) {
      refresh();
      cb();
    }
  });
}

export const getIdentity = (): IdentitySnapshot => snapshot;

/** Hash each stored key once; the cache survives for the page's life. */
export function hashOf(canonicalKey: string): Promise<string> {
  let p = hashCache.get(canonicalKey);
  if (!p) {
    p = hashOwnerKey(canonicalKey).catch(() => '');
    hashCache.set(canonicalKey, p);
  }
  return p;
}

/** Which stored handle (if any) owns a document with this owner_hash. */
export async function isOwnerOf(ownerHash: string, keys: KeysMap = snapshot.keys): Promise<string | null> {
  const entries = Object.entries(keys);
  const hashes = await Promise.all(entries.map(([, k]) => hashOf(k)));
  const i = hashes.findIndex((h) => h === ownerHash);
  return i >= 0 ? (entries[i]?.[0] ?? null) : null;
}

export function remember(handle: string, key: string): boolean {
  const canonical = parseOwnerKey(key);
  if (!canonical) return false;
  const ok = writeKeys({ ...readKeys(), [handle]: canonical });
  refresh();
  return ok;
}

export function forget(handle: string): void {
  const keys = { ...readKeys() };
  delete keys[handle];
  writeKeys(keys);
  refresh();
}

export function recordEntry(id: string, rec: EntryRecord): void {
  writeEntries({ ...readEntries(), [id]: rec });
  refresh();
}

export function dropEntry(id: string): void {
  const e = { ...readEntries() };
  delete e[id];
  writeEntries(e);
  refresh();
}

export const keyFor = (handle: string): string | null => snapshot.keys[handle] ?? null;
export const hasAnyKey = (): boolean => Object.keys(snapshot.keys).length > 0;

/** The handle whose entry was recorded most recently (prefill for /me and /upload). */
export function latestHandle(): string | null {
  const entries = Object.values(snapshot.entries).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const withKey = entries.find((e) => snapshot.keys[e.handle]);
  if (withKey) return withKey.handle;
  return Object.keys(snapshot.keys)[0] ?? null;
}

/** Most recent entry id per handle, newest first. */
export function entriesNewestFirst(): [string, EntryRecord][] {
  return Object.entries(snapshot.entries).sort((a, b) => b[1].submitted_at.localeCompare(a[1].submitted_at));
}

/**
 * The newest entry this browser dispatched under a handle. A handle is claimed in users/ only once the
 * document is analyzed, so until then this is the only evidence the entry exists (product-ux §3.7).
 */
export function pendingEntryFor(entries: EntriesMap, handle: string): { id: string; entry: EntryRecord } | null {
  const match = Object.entries(entries)
    .filter(([, e]) => e.handle === handle)
    .sort((a, b) => b[1].submitted_at.localeCompare(a[1].submitted_at))[0];
  return match ? { id: match[0], entry: match[1] } : null;
}

export function useIdentity(): IdentitySnapshot & {
  isOwnerOf: typeof isOwnerOf;
  remember: typeof remember;
  forget: typeof forget;
  recordEntry: typeof recordEntry;
  hasKey: boolean;
} {
  const snap = useSyncExternalStore(subscribeIdentity, getIdentity, getIdentity);
  return { ...snap, isOwnerOf, remember, forget, recordEntry, hasKey: Object.keys(snap.keys).length > 0 };
}

/** Resolves the owning handle for a document hash, re-evaluated when keys change. */
export function useOwnerOf(ownerHash: string | null | undefined): string | null {
  const { keys } = useIdentity();
  const [handle, setHandle] = useState<string | null>(null);
  const check = useCallback(async () => {
    if (!ownerHash) return setHandle(null);
    setHandle(await isOwnerOf(ownerHash, keys));
  }, [ownerHash, keys]);
  useEffect(() => {
    void check();
  }, [check]);
  return handle;
}
