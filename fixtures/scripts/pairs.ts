#!/usr/bin/env node
// Writes fixtures/pairs.json (spec §13.1): 200 labelled card pairs drawn from the anchor-level fixtures,
// `{ a, b, category, label }` where a/b are fixture slugs (the cards are analyses/<slug>.json → card) and
// the label comes from the plan's intended_anchor: 'a' or 'b' when the anchors differ by ≥ 200, else
// 'close'. Deterministic: a fixed-seed PRNG picks the pairs and their orientation, so re-running the
// script reproduces the file byte for byte. Run with `node fixtures/scripts/pairs.ts`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORIES = ['general', 'finance', 'tech', 'academia'] as const;
type Category = (typeof CATEGORIES)[number];
const TOTAL = 200;
/** Domain ladders get up to this many pairs each; general takes the remainder. */
const PER_DOMAIN = 50;
const CLOSE_GAP = 200;

interface PlanEntry {
  slug: string;
  intended_anchor: number | null;
  intended_categories: Category[];
}
export interface LabelledPair {
  a: string;
  b: string;
  category: Category;
  label: 'a' | 'b' | 'close';
}

/** mulberry32 seeded from a string hash: small, deterministic, good enough for shuffling 800 pairs. */
function rngFrom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function labelFor(anchorA: number, anchorB: number): LabelledPair['label'] {
  if (anchorA - anchorB >= CLOSE_GAP) return 'a';
  if (anchorB - anchorA >= CLOSE_GAP) return 'b';
  return 'close';
}

function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function buildPairs(plan: PlanEntry[], hasAnalysis: (slug: string) => boolean): LabelledPair[] {
  const anchors = plan
    .filter((e): e is PlanEntry & { intended_anchor: number } => e.intended_anchor !== null && hasAnalysis(e.slug))
    .sort((x, y) => (x.slug < y.slug ? -1 : 1));
  const candidates = (cat: Category): [PlanEntry & { intended_anchor: number }, PlanEntry & { intended_anchor: number }][] => {
    const inCat = anchors.filter((e) => e.intended_categories.includes(cat));
    const out: [typeof inCat[number], typeof inCat[number]][] = [];
    for (let i = 0; i < inCat.length; i++) for (let j = i + 1; j < inCat.length; j++) out.push([inCat[i] as typeof inCat[number], inCat[j] as typeof inCat[number]]);
    return out;
  };
  const pairs: LabelledPair[] = [];
  const take = (cat: Category, n: number): void => {
    const rng = rngFrom(`pairs|${cat}`);
    for (const [x, y] of shuffle(candidates(cat), rng).slice(0, n)) {
      const [first, second] = rng() < 0.5 ? [x, y] : [y, x];
      pairs.push({ a: first.slug, b: second.slug, category: cat, label: labelFor(first.intended_anchor, second.intended_anchor) });
    }
  };
  for (const cat of CATEGORIES) if (cat !== 'general') take(cat, PER_DOMAIN);
  take('general', TOTAL - pairs.length);
  if (pairs.length !== TOTAL) throw new Error(`expected ${TOTAL} pairs, built ${pairs.length}`);
  const order = (c: Category): number => CATEGORIES.indexOf(c);
  return pairs.sort((x, y) => order(x.category) - order(y.category) || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const plan = JSON.parse(readFileSync(join(FIXTURES, 'plan.json'), 'utf8')) as PlanEntry[];
  const pairs = buildPairs(plan, (slug) => existsSync(join(FIXTURES, 'analyses', `${slug}.json`)));
  writeFileSync(join(FIXTURES, 'pairs.json'), sortedJson(pairs), 'utf8');
  const counts: Record<string, number> = {};
  for (const p of pairs) counts[`${p.category}:${p.label}`] = (counts[`${p.category}:${p.label}`] ?? 0) + 1;
  console.log(`pairs: wrote ${pairs.length} to fixtures/pairs.json`, JSON.stringify(counts));
}
