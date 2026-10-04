import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OWNER_KEY_RE, formatOwnerKey, generateOwnerKey, hashOwnerKey, isOwnerHash, parseOwnerKey } from '../src/owner-key.ts';
import { canonicalJson, jsonFileText, sha256Hex, sortKeys, timingSafeEqualString } from '../src/hash.ts';

describe('owner key', () => {
  it('generates 52 canonical base32 chars', () => {
    const k = generateOwnerKey();
    expect(k).toMatch(OWNER_KEY_RE);
    expect(generateOwnerKey()).not.toBe(k);
    expect(generateOwnerKey(() => new Uint8Array(32))).toBe('a'.repeat(52));
    // 256 bits = 51 full groups + 1 bit, so the last character carries one set bit and four zero pad bits.
    expect(generateOwnerKey(() => new Uint8Array(32).fill(255))).toBe(`${'7'.repeat(51)}q`);
    expect(() => generateOwnerKey(() => new Uint8Array(31))).toThrow();
  });
  it('formats as rak- plus 13 groups of 4 and round-trips through parse', () => {
    const k = generateOwnerKey();
    const shown = formatOwnerKey(k);
    expect(shown.startsWith('rak-')).toBe(true);
    expect(shown.slice(4).split('-')).toHaveLength(13);
    expect(shown).toHaveLength(4 + 52 + 12);
    expect(parseOwnerKey(shown)).toBe(k);
    expect(parseOwnerKey(k)).toBe(k);
    expect(parseOwnerKey(` ${shown.toUpperCase()} `)).toBe(k);
    expect(parseOwnerKey(shown.replace(/-/g, ' '))).toBe(k);
    expect(parseOwnerKey(`RAK${k}`)).toBe(k);
    expect(() => formatOwnerKey('short')).toThrow();
  });
  it('parse rejects anything that is not a key', () => {
    expect(parseOwnerKey('')).toBeNull();
    expect(parseOwnerKey(null)).toBeNull();
    expect(parseOwnerKey(42)).toBeNull();
    expect(parseOwnerKey('a'.repeat(51))).toBeNull();
    expect(parseOwnerKey('a'.repeat(53))).toBeNull();
    expect(parseOwnerKey(`${'a'.repeat(51)}1`)).toBeNull();
    expect(parseOwnerKey(`rak-${'a'.repeat(52)}x`)).toBeNull();
  });
  it('hashes the canonical UTF-8 string and agrees with node:crypto in both forms', async () => {
    const k = generateOwnerKey();
    const node = createHash('sha256').update(k, 'utf8').digest('hex');
    expect(await hashOwnerKey(k)).toBe(node);
    expect(await hashOwnerKey(formatOwnerKey(k))).toBe(node);
    expect(isOwnerHash(node)).toBe(true);
    expect(isOwnerHash(node.toUpperCase())).toBe(false);
    await expect(hashOwnerKey('nope')).rejects.toThrow();
  });
});

describe('hash', () => {
  it('sha256Hex matches the known vector and node:crypto for bytes', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await sha256Hex('résumé ✓')).toBe(createHash('sha256').update('résumé ✓', 'utf8').digest('hex'));
  });
  it('falls back to node:crypto when WebCrypto is unavailable', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    if (!desc?.configurable) return;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      Object.defineProperty(globalThis, 'crypto', desc);
    }
  });
  it('canonicalJson is key-order independent and array-order preserving', () => {
    const a = { z: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' }, m: null };
    const b = { m: null, a: { c: 'x', d: [3, { x: 2, y: 1 }] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"m":null,"z":1}');
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(sortKeys({ b: undefined, a: 1 })).toEqual({ a: 1 });
    expect(jsonFileText({ b: 1, a: [1] })).toBe('{\n  "a": [\n    1\n  ],\n  "b": 1\n}\n');
  });
  it('timingSafeEqualString', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'ab')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });
});
