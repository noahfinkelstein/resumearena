// Every random choice in the engine draws from here (§9.4 step 1, ranking-engine.md §7.1).
// The seed is RA_SEED when set, otherwise the run id; sub-streams are derived by label so a
// restarted run reproduces the same plan for a wave regardless of how many draws earlier waves made.
import { createHash } from 'node:crypto';

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher–Yates. */
  shuffle<T>(items: T[]): T[];
  /** Weighted pick; weights must be non-negative and not all zero. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T | null;
  /** A new independent stream named by `label`, deterministic for (seed, label). */
  derive(label: string): Rng;
  readonly seed: string;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: string): Rng {
  const digest = sha256Hex(seed);
  // Four 32-bit lanes xor-folded into one state word; sha256 already mixes the label in.
  const state = [0, 8, 16, 24].map((i) => parseInt(digest.slice(i, i + 8), 16)).reduce((a, b) => (a ^ b) >>> 0, 0);
  const next = mulberry32(state);
  const rng: Rng = {
    seed,
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => {
      if (items.length === 0) throw new RangeError('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = items[i] as (typeof items)[number];
        items[i] = items[j] as (typeof items)[number];
        items[j] = t;
      }
      return items;
    },
    weighted: (items, weightOf) => {
      let total = 0;
      const weights = items.map((it) => {
        const w = weightOf(it);
        const safe = Number.isFinite(w) && w > 0 ? w : 0;
        total += safe;
        return safe;
      });
      if (total <= 0) return null;
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i] as number;
        if (roll < 0) return items[i] as (typeof items)[number];
      }
      return items[items.length - 1] as (typeof items)[number];
    },
    derive: (label) => createRng(`${seed}|${label}`),
  };
  return rng;
}

/** Standard normal via Box–Muller on a given stream (simulation only). */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
