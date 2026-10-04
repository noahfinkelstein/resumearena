// Owner key (D-10): 32 random bytes → 52 lowercase base32 chars (canonical) → shown as
// `rak-` + 13 groups of 4. owner_hash = sha256(utf8(canonical)) as lowercase hex.
import { base32Encode, defaultRandomBytes, type RandomBytes } from './ids.ts';
import { sha256Hex } from './hash.ts';

export const OWNER_KEY_BYTES = 32;
export const OWNER_KEY_LENGTH = 52;
export const OWNER_KEY_RE = /^[a-z2-7]{52}$/;
export const OWNER_HASH_RE = /^[0-9a-f]{64}$/;
export const OWNER_KEY_PREFIX = 'rak-';
export const OWNER_KEY_GROUPS = 13;

export function generateOwnerKey(random: RandomBytes = defaultRandomBytes): string {
  const bytes = random(OWNER_KEY_BYTES);
  if (bytes.length !== OWNER_KEY_BYTES) throw new Error(`owner key needs ${OWNER_KEY_BYTES} random bytes`);
  const key = base32Encode(bytes);
  if (key.length !== OWNER_KEY_LENGTH) throw new Error('owner key encoding produced the wrong length');
  return key;
}

/** `rak-xxxx-xxxx-…` (13 groups). Throws if the input is not a canonical key. */
export function formatOwnerKey(canonical: string): string {
  if (!OWNER_KEY_RE.test(canonical)) throw new Error('formatOwnerKey expects a canonical 52-char key');
  const groups: string[] = [];
  for (let i = 0; i < OWNER_KEY_LENGTH; i += 4) groups.push(canonical.slice(i, i + 4));
  return OWNER_KEY_PREFIX + groups.join('-');
}

/**
 * Accepts the canonical form, the displayed `rak-` form, and sloppy copies of either (case, whitespace,
 * stray hyphens). Returns the canonical key or null; never throws.
 */
export function parseOwnerKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase().replace(/\s+/g, '');
  if (s.startsWith(OWNER_KEY_PREFIX)) s = s.slice(OWNER_KEY_PREFIX.length);
  else if (s.startsWith('rak')) s = s.slice(3);
  s = s.replace(/-/g, '');
  return OWNER_KEY_RE.test(s) ? s : null;
}

export function isOwnerHash(value: unknown): value is string {
  return typeof value === 'string' && OWNER_HASH_RE.test(value);
}

/** owner_hash of a key in either accepted form. Rejects anything parseOwnerKey rejects. */
export async function hashOwnerKey(key: string): Promise<string> {
  const canonical = parseOwnerKey(key);
  if (canonical === null) throw new Error('hashOwnerKey: not an owner key');
  return sha256Hex(canonical);
}
