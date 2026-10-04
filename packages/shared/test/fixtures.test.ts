// Spec §5.4: every committed fixture analysis passes the JSON schema (a schema validator in devDependencies
// only) and the Zod mirror; §13.1: the anchor cards and pairs.json are consistent with the plan.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ajv2020 from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_SCHEMA } from '../src/schemas/index.ts';
import { ResumeAnalysisZ } from '../src/schemas/analysis.ts';
import { AnchorsFileZ } from '../src/schemas/data.ts';
import { parseWithRepairs } from '../src/schemas/repair.ts';
import { CATEGORIES, type Category } from '../src/types.ts';

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'fixtures');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

interface PlanEntry {
  slug: string;
  intended_anchor: number | null;
  intended_categories: Category[];
}
interface Pair {
  a: string;
  b: string;
  category: Category;
  label: 'a' | 'b' | 'close';
}

// ajv ships CommonJS: Node gives an ESM importer `module.exports` (the class itself, which also carries
// `.default`), while TypeScript types the default import as the module namespace. Resolve both the same way.
const Ajv2020 = ((ajv2020 as unknown as { default?: unknown }).default ?? ajv2020) as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateAnalysis = ajv.compile(ANALYSIS_SCHEMA as object);
const cardSchema = { $ref: '#/$defs/Card', $defs: (ANALYSIS_SCHEMA as { $defs: Record<string, unknown> }).$defs };
const validateCard = ajv.compile(cardSchema);

const analysisFiles = existsSync(join(FIXTURES, 'analyses')) ? readdirSync(join(FIXTURES, 'analyses')).filter((f) => f.endsWith('.json')).sort() : [];
const plan = readJson(join(FIXTURES, 'plan.json')) as PlanEntry[];

describe('fixture analyses', () => {
  it('exist for every plan entry that is expected to be analyzed or held', () => {
    const expected = (readJson(join(FIXTURES, 'plan.json')) as (PlanEntry & { expect: { status: string } })[]).filter((e) => e.expect.status === 'analyzed' || e.expect.status === 'held');
    for (const e of expected) expect(analysisFiles, `analyses/${e.slug}.json`).toContain(`${e.slug}.json`);
  });

  it.each(analysisFiles)('%s passes the JSON schema and the Zod mirror without repairs', (file) => {
    const raw = readJson(join(FIXTURES, 'analyses', file));
    const ok = validateAnalysis(raw);
    expect(ok, ajv.errorsText(validateAnalysis.errors)).toBe(true);
    const parsed = parseWithRepairs(ResumeAnalysisZ, raw);
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    if (parsed.ok) expect(parsed.repairs).toBe(0);
  });
});

describe('fixture anchors', () => {
  it.each(CATEGORIES)('%s has twelve schema-valid cards at 1000…2100', (cat) => {
    const raw = readJson(join(FIXTURES, 'anchors', `${cat}.json`));
    const file = AnchorsFileZ.parse(raw);
    expect(file.category).toBe(cat);
    expect(file.anchors.map((a) => a.rating)).toEqual(Array.from({ length: 12 }, (_, i) => 1000 + 100 * i));
    for (const a of file.anchors) {
      expect(a.id).toBe(`anchr${cat[0]}${'bcdefghijklm'[(a.rating - 1000) / 100]}aaa`);
      expect(validateCard(a.card), `${a.id}: ${ajv.errorsText(validateCard.errors)}`).toBe(true);
    }
  });
});

describe('fixture pairs', () => {
  const pairs = readJson(join(FIXTURES, 'pairs.json')) as Pair[];
  const bySlug = new Map(plan.map((e) => [e.slug, e]));

  it('holds 200 distinct pairs of anchor-level fixtures with committed analyses', () => {
    expect(pairs).toHaveLength(200);
    const seen = new Set<string>();
    for (const p of pairs) {
      expect(p.a).not.toBe(p.b);
      const key = `${[p.a, p.b].sort().join('|')}:${p.category}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      for (const slug of [p.a, p.b]) {
        expect(analysisFiles).toContain(`${slug}.json`);
        expect(bySlug.get(slug)?.intended_anchor, slug).not.toBeNull();
      }
    }
  });

  it('labels follow intended_anchor and categories are shared by both sides', () => {
    for (const p of pairs) {
      const a = bySlug.get(p.a) as PlanEntry;
      const b = bySlug.get(p.b) as PlanEntry;
      expect(a.intended_categories).toContain(p.category);
      expect(b.intended_categories).toContain(p.category);
      const gap = (a.intended_anchor as number) - (b.intended_anchor as number);
      expect(p.label).toBe(gap >= 200 ? 'a' : gap <= -200 ? 'b' : 'close');
    }
  });

  it('covers every category with both decided and close pairs', () => {
    for (const cat of CATEGORIES) {
      const inCat = pairs.filter((p) => p.category === cat);
      expect(inCat.length, cat).toBeGreaterThanOrEqual(40);
      expect(inCat.some((p) => p.label === 'close'), `${cat} close`).toBe(true);
      expect(inCat.some((p) => p.label === 'a'), `${cat} a`).toBe(true);
      expect(inCat.some((p) => p.label === 'b'), `${cat} b`).toBe(true);
    }
  });
});
