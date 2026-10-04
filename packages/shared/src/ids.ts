// Ids (§3.2, D-01, D-15, D-25). Every id is 10 lowercase base32 chars; shards are the first two.
import type { Category } from './types.ts';

export const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const ID_LENGTH = 10;
export const ID_RE = /^[a-z2-7]{10}$/;
export const ANCHOR_RE = /^anchr[gfta][b-m]aaa$/;
export const ANCHOR_PREFIX = 'anchr';
/** Locked anchor ratings, 1000…2100 step 100; index i maps to the letter `'bcdefghijklm'[i]`. */
export const ANCHOR_RATINGS = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100] as const;
const ANCHOR_LETTERS = 'bcdefghijklm';

export type RandomBytes = (n: number) => Uint8Array;

/** Browser and Node 24 both expose WebCrypto on globalThis; tests inject a deterministic source. */
export const defaultRandomBytes: RandomBytes = (n) => {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('No cryptographic random source available');
  return c.getRandomValues(new Uint8Array(n));
};

/** Big-endian base32 (RFC 4648 alphabet, lowercase) of the whole byte string, no padding characters. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ID_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ID_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** 8 random bytes → the low 50 bits as 10 base32 chars. Never yields the `anchr` prefix in practice; clients are rejected if they send one. */
export function newId(random: RandomBytes = defaultRandomBytes): string {
  const bytes = random(8);
  if (bytes.length < 8) throw new Error('newId needs 8 random bytes');
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out = ID_ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

export const shardOf = (id: string): string => id.slice(0, 2);
export const anonIdOf = (id: string): string => `anon-${id.slice(0, 7)}`;
export const isAnchorId = (id: string): boolean => id.startsWith(ANCHOR_PREFIX);
export const isValidId = (id: string): boolean => ID_RE.test(id);

/** `anchrggaaa` = general 1500. Throws on a rating outside the locked ladder. */
export function anchorId(cat: Category, rating: number): string {
  const idx = (rating - 1000) / 100;
  const letter = Number.isInteger(idx) ? ANCHOR_LETTERS[idx] : undefined;
  if (letter === undefined) throw new RangeError(`anchor rating must be 1000..2100 step 100, got ${rating}`);
  return `${ANCHOR_PREFIX}${cat[0]}${letter}aaa`;
}

const CATEGORY_BY_INITIAL: Record<string, Category> = { g: 'general', f: 'finance', t: 'tech', a: 'academia' };

/** Inverse of anchorId; null for anything that is not a well-formed anchor id. */
export function parseAnchorId(id: string): { category: Category; rating: number } | null {
  if (!ANCHOR_RE.test(id)) return null;
  const category = CATEGORY_BY_INITIAL[id[5] ?? ''];
  const idx = ANCHOR_LETTERS.indexOf(id[6] ?? '');
  if (!category || idx < 0) return null;
  return { category, rating: 1000 + idx * 100 };
}
