import { describe, expect, it } from 'vitest';
import { formatOwnerKey, generateOwnerKey, hashOwnerKey, parseOwnerKey } from '@resumearena/shared';
import { dropEntry, forget, getIdentity, isOwnerOf, keyFor, latestHandle, pendingEntryFor, recordEntry, remember } from '../src/lib/identity.ts';
import { KEYS, readArena, readJson, readKeys, writeArena, writeRaw } from '../src/lib/storage.ts';

describe('owner key create / restore', () => {
  it('generates, formats, and parses back the same key', () => {
    const key = generateOwnerKey();
    expect(key).toMatch(/^[a-z2-7]{52}$/);
    const shown = formatOwnerKey(key);
    expect(shown.startsWith('rak-')).toBe(true);
    expect(shown.split('-')).toHaveLength(14);
    expect(parseOwnerKey(shown)).toBe(key);
    expect(parseOwnerKey(shown.toUpperCase().replace(/-/g, ' '))).toBe(key);
  });

  it('remembers a pasted key in either form under resumearena.keys and finds the owner by hash', async () => {
    const key = generateOwnerKey();
    expect(remember('priya-n', formatOwnerKey(key))).toBe(true);
    expect(readKeys()).toEqual({ 'priya-n': key });
    expect(keyFor('priya-n')).toBe(key);
    const hash = await hashOwnerKey(key);
    expect(await isOwnerOf(hash)).toBe('priya-n');
    expect(await isOwnerOf('f'.repeat(64))).toBeNull();
  });

  it('rejects garbage keys', () => {
    expect(remember('x', 'not-a-key')).toBe(false);
    expect(readKeys()).toEqual({});
  });

  it('forget removes only that handle', () => {
    remember('a-handle', generateOwnerKey());
    remember('b-handle', generateOwnerKey());
    forget('a-handle');
    expect(Object.keys(readKeys())).toEqual(['b-handle']);
  });

  it('records entries and orders them newest first', () => {
    recordEntry('k7q2m3xw5a', { handle: 'priya-n', owner_hash: 'a'.repeat(64), submitted_at: '2026-10-03T14:11:02Z', via: 'dispatch', ladder_hint: 'tech' });
    recordEntry('x6ppa2a7mq', { handle: 'later', owner_hash: 'b'.repeat(64), submitted_at: '2026-10-04T10:00:00Z', via: 'issue', ladder_hint: 'general' });
    remember('later', generateOwnerKey());
    expect(latestHandle()).toBe('later');
    expect(Object.keys(getIdentity().entries)).toHaveLength(2);
    dropEntry('x6ppa2a7mq');
    expect(Object.keys(getIdentity().entries)).toEqual(['k7q2m3xw5a']);
  });
});

describe('storage is defensive', () => {
  it('yields defaults on malformed JSON', () => {
    writeRaw(KEYS.keys, '{not json');
    expect(readKeys()).toEqual({});
    writeRaw(KEYS.arena, '"a string"');
    expect(readArena().streak).toBe(0);
    expect(readJson(KEYS.entries, { fallback: true })).toEqual({ fallback: true });
  });

  it('caps the arena seen list at 300', () => {
    writeArena({ streak: 1, best: 1, guesses: 1, agreed: 1, seen: Array.from({ length: 400 }, (_, i) => `m${i}`), lastCategory: 'tech', disagreeRun: 0 });
    expect(readArena().seen).toHaveLength(300);
    expect(readArena().seen[0]).toBe('m100');
  });

  it('survives a throwing storage', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(readKeys()).toEqual({});
      expect(remember('h-andle', generateOwnerKey())).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('pending entry lookup (/me before the handle is claimed)', () => {
  it('returns the newest local entry under the handle, or null', () => {
    const entries = {
      aaaaaaaaaa: { handle: 'priya-n', owner_hash: 'a'.repeat(64), submitted_at: '2026-10-03T10:00:00Z', via: 'dispatch' as const, ladder_hint: 'tech' as const },
      bbbbbbbbbb: { handle: 'priya-n', owner_hash: 'a'.repeat(64), submitted_at: '2026-10-03T11:00:00Z', via: 'dispatch' as const, ladder_hint: 'tech' as const },
      cccccccccc: { handle: 'other', owner_hash: 'b'.repeat(64), submitted_at: '2026-10-03T12:00:00Z', via: 'issue' as const, ladder_hint: 'general' as const },
    };
    expect(pendingEntryFor(entries, 'priya-n')?.id).toBe('bbbbbbbbbb');
    expect(pendingEntryFor(entries, 'other')?.id).toBe('cccccccccc');
    expect(pendingEntryFor(entries, 'nobody')).toBeNull();
    expect(pendingEntryFor({}, 'priya-n')).toBeNull();
  });
});
