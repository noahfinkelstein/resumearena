import { describe, expect, it } from 'vitest';
import { ANCHOR_RATINGS, ANCHOR_RE, ID_ALPHABET, ID_RE, anchorId, anonIdOf, base32Encode, isAnchorId, newId, parseAnchorId, shardOf } from '../src/ids.ts';
import { CATEGORIES } from '../src/types.ts';

describe('ids', () => {
  it('newId is 10 chars from the base32 alphabet and never an anchor', () => {
    for (let i = 0; i < 500; i++) {
      const id = newId();
      expect(id).toMatch(ID_RE);
      expect(id).toHaveLength(10);
      for (const ch of id) expect(ID_ALPHABET.includes(ch)).toBe(true);
      expect(isAnchorId(id)).toBe(false);
    }
  });
  it('newId is deterministic for a given byte source and uses the low 50 bits', () => {
    expect(newId(() => new Uint8Array(8))).toBe('aaaaaaaaaa');
    expect(newId(() => new Uint8Array(8).fill(255))).toBe('7777777777');
    expect(newId(() => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]))).toBe('aaaaaaaaab');
    expect(() => newId(() => new Uint8Array(4))).toThrow();
  });
  it('base32Encode', () => {
    expect(base32Encode(new Uint8Array([]))).toBe('');
    expect(base32Encode(new Uint8Array(5))).toBe('aaaaaaaa');
    expect(base32Encode(new Uint8Array(32))).toHaveLength(52);
  });
  it('shardOf and anonIdOf', () => {
    expect(shardOf('k7q2m3xw5a')).toBe('k7');
    expect(anonIdOf('k7q2m3xw5a')).toBe('anon-k7q2m3x');
  });
  it('anchor ids', () => {
    expect(anchorId('general', 1500)).toBe('anchrggaaa');
    expect(anchorId('tech', 1000)).toBe('anchrtbaaa');
    expect(anchorId('academia', 2100)).toBe('anchramaaa');
    expect(() => anchorId('finance', 1050)).toThrow(RangeError);
    expect(() => anchorId('finance', 2200)).toThrow(RangeError);
    for (const cat of CATEGORIES) {
      for (const rating of ANCHOR_RATINGS) {
        const id = anchorId(cat, rating);
        expect(id).toMatch(ANCHOR_RE);
        expect(isAnchorId(id)).toBe(true);
        expect(ID_RE.test(id)).toBe(true);
        expect(parseAnchorId(id)).toEqual({ category: cat, rating });
      }
    }
    expect(parseAnchorId('anchrgaaaa')).toBeNull();
    expect(parseAnchorId('k7q2m3xw5a')).toBeNull();
    expect(ANCHOR_RE.test('anchrggaab')).toBe(false);
  });
});
