// SHA-256 and canonical JSON. WebCrypto (`globalThis.crypto.subtle`) exists in every browser and in
// Node 24, so the node:crypto path is only a fallback for stripped-down runtimes; its specifier is kept
// out of static analysis so bundlers never see a `node:` import.

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

interface NodeCryptoLike {
  createHash(alg: string): { update(data: Uint8Array): { digest(enc: 'hex'): string } };
}

async function nodeSha256Hex(data: Uint8Array): Promise<string> {
  const specifier = 'node:crypto';
  const mod = (await import(/* @vite-ignore */ specifier)) as NodeCryptoLike;
  return mod.createHash('sha256').update(data).digest('hex');
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? utf8(input) : input;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', data as BufferSource);
    return bytesToHex(new Uint8Array(digest));
  }
  return nodeSha256Hex(data);
}

/** Deep copy with object keys sorted; arrays keep their order. undefined values are dropped like JSON.stringify does. */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out as T;
  }
  return value;
}

/** Compact JSON with sorted keys: the judge card text and the input of card_sha256 (D-02). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Pretty JSON with sorted keys and a trailing newline: every file written to the data branch. */
export function jsonFileText(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Constant-time string comparison for secrets (owner hashes). Length mismatch is reported without early exit on content. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  const n = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
