// `fixtures generate | web-data | payload` (§13.1–§13.2).
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayoutMetricsZ, buildPayload, jsonFileText, newId, normalizePayload, type LayoutMetrics, type SubmissionPayload, type Visibility } from '@resumearena/shared';
import { createClock } from '../clock.ts';
import { createContext, type Context } from '../context.ts';
import { MS_PER_DAY, parseIso } from '../clock.ts';
import type { PlanEntry } from '../llm/mock.ts';
import { createMockTransport } from '../llm/mock.ts';
import { createRng } from '../rng.ts';
import { openStore } from '../store/store.ts';
import { silentLogger } from '../summary.ts';
import { processSubmission } from '../submit/pipeline.ts';
import { placeholderMetrics, placeholderText } from '../fixtures/texts.ts';
import { buildIndexes } from './build-indexes.ts';
import { dataInit } from './data.ts';
import { maintenanceCommand } from './maintenance.ts';
import { runRerank } from './rerank.ts';
import { loadSettings } from '../settings.ts';

export interface FixtureSet {
  slug: string;
  entry: PlanEntry;
  text: string;
  metrics: LayoutMetrics;
  synthesized: boolean;
}

export async function readPlan(fixturesDir: string): Promise<PlanEntry[]> {
  const path = join(fixturesDir, 'plan.json');
  if (!existsSync(path)) throw new Error(`fixtures plan missing at ${path}`);
  return JSON.parse(await readFile(path, 'utf8')) as PlanEntry[];
}

/** The committed text and meta when present, otherwise a placeholder synthesized from the brief. */
export async function loadFixture(fixturesDir: string, entry: PlanEntry): Promise<FixtureSet> {
  const textPath = join(fixturesDir, 'resumes', `${entry.slug}.txt`);
  const metaPath = join(fixturesDir, 'resumes', `${entry.slug}.meta.json`);
  if (existsSync(textPath)) {
    const text = await readFile(textPath, 'utf8');
    let metrics: LayoutMetrics | null = null;
    if (existsSync(metaPath)) {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { metrics?: unknown };
      const parsed = LayoutMetricsZ.safeParse(meta.metrics ?? {});
      if (parsed.success) metrics = parsed.data;
    }
    return { slug: entry.slug, entry, text, metrics: metrics ?? placeholderMetrics(text, entry), synthesized: false };
  }
  const text = placeholderText(entry);
  return { slug: entry.slug, entry, text, metrics: placeholderMetrics(text, entry), synthesized: true };
}

/** Handles are ≤ 20 chars of [a-z0-9-]; derive one from the slug deterministically. */
export function handleForSlug(slug: string): string {
  const parts = slug.split('-').filter((p) => p && !['anchor', 'weak', 'gamed', 'pii', 'edge'].includes(p));
  let h = parts.join('-').replace(/[^a-z0-9-]/g, '').slice(0, 20).replace(/-+$/, '');
  if (h.length < 3) h = `fx-${slug.slice(0, 10)}`;
  return h;
}

export interface FixturePayload {
  payload: SubmissionPayload;
  owner_key: string;
  slug: string;
}

export function payloadForFixture(f: FixtureSet, seed: string): FixturePayload {
  const rng = createRng(`${seed}|fixture|${f.slug}`);
  const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rng.int(256));
  const id = newId(bytes);
  const ownerKey = Array.from({ length: 52 }, () => 'abcdefghijklmnopqrstuvwxyz234567'[rng.int(32)]).join('');
  const visibility: Visibility = rng.next() < 0.5 ? 'handle' : 'anonymous';
  // owner_hash is sha256(canonical key); computed by the caller through normalizePayload when the key is present.
  const payload = buildPayload({ action: 'submit', id, handle: handleForSlug(f.slug), owner_hash: '', visibility, text: f.text, metrics: f.metrics, ladder_hint: f.entry.category, client_version: 'fixtures', owner_key: ownerKey });
  return { payload, owner_key: ownerKey, slug: f.slug };
}

export async function fixturesPayloadCommand(env: Context['env'], slug: string): Promise<string> {
  const plan = await readPlan(env.fixturesDir);
  const entry = plan.find((e) => e.slug === slug);
  if (!entry) throw new Error(`unknown fixture slug ${slug}`);
  const f = await loadFixture(env.fixturesDir, entry);
  const { payload } = payloadForFixture(f, env.seed ?? 'fixtures');
  const normalized = await normalizePayload(payload, { kind: 'dispatch', run_id: 0, issue_number: null, client_version: 'fixtures' });
  const ownerHash = normalized.ok ? normalized.input.owner_hash : payload.owner_hash;
  return jsonFileText({ ...payload, owner_hash: ownerHash });
}

export interface WebDataReport {
  submitted: Record<string, number>;
  reranks: number;
  matches: number;
  files: number;
  out: string;
}

/** data init → 60 mock submits → 20 mock reranks → nightly → build-indexes → fixtures/web-data/{pages,raw}. */
export async function fixturesWebData(env: Context['env'], opts: { from: string; out: string; reranks?: number; log?: Context['log'] }): Promise<WebDataReport> {
  const log = opts.log ?? silentLogger;
  const plan = await readPlan(opts.from);
  const seed = env.seed ?? 'fixtures-web-data';
  const clock = createClock(env.now ?? '2026-10-03T12:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'ra-web-data-'));
  try {
    await dataInit(dataDir, { now: clock.iso(), anchorsDir: join(opts.from, 'anchors') });
    const store = openStore(dataDir);
    const envHere: Context['env'] = { ...env, dataDir, noGit: true, raEnv: 'local', llmMode: 'mock', fixturesDir: opts.from, seed };
    const transport = createMockTransport({ fixturesDir: opts.from, seed });
    const ctx = createContext({ env: envHere, store, clock, transport, seed, runId: 'fixtures-1', log });
    const settings = await loadSettings(store);
    const submitted: Record<string, number> = {};
    for (const entry of plan) {
      const f = await loadFixture(opts.from, entry);
      const { payload } = payloadForFixture(f, seed);
      const normalized = await normalizePayload(payload, { kind: 'dispatch', run_id: 1, issue_number: null, client_version: 'fixtures' });
      const outcome = normalized.ok ? (await processSubmission({ ctx, settings, wf: 'submit' }, normalized.input, payload)).outcome : `rejected:${normalized.code}`;
      const key = normalized.ok ? outcome : outcome;
      submitted[key] = (submitted[key] ?? 0) + 1;
      clock.advance(60_000);
    }
    const reranks = opts.reranks ?? 20;
    let matches = 0;
    // One rerank per simulated day at 23:00 UTC: the refine allowance divides the day's remaining budget
    // by runs_left (D-49), so a late-day run may spend it on ≈ one match per rated row, which is what fills
    // the small finance and academia arena pools past the 20-pair floor the SPA needs (§11.5).
    const firstRun = parseIso(clock.day() + 'T23:00:00Z');
    clock.set(firstRun.getTime() > clock.now().getTime() ? firstRun : new Date(firstRun.getTime() + MS_PER_DAY));
    for (let i = 1; i <= reranks; i++) {
      const runCtx = createContext({ env: envHere, store, clock, transport, seed: `${seed}|run${i}`, runId: `fixtures-rerank-${i}`, log });
      const r = await runRerank(runCtx, { trigger: 'fixtures' });
      matches += r.matches;
      clock.advance(MS_PER_DAY);
    }
    const nightlyCtx = createContext({ env: envHere, store, clock, transport, seed: `${seed}|nightly`, runId: 'fixtures-nightly', log });
    await maintenanceCommand(nightlyCtx, 'nightly', {});
    await rm(opts.out, { recursive: true, force: true });
    const pages = join(opts.out, 'pages');
    const raw = join(opts.out, 'raw');
    await mkdir(raw, { recursive: true });
    const built = await buildIndexes({ store, outDir: pages, buildId: 'fixtures', commit: 'fixtures', now: clock.iso() });
    for (const dir of ['resumes', 'users', 'history', 'anchors', 'ratings', 'arena', 'queue', 'rows', 'cards', 'matches', 'audits', 'usage']) {
      if (existsSync(join(dataDir, dir))) await cp(join(dataDir, dir), join(raw, dir), { recursive: true });
    }
    for (const f of ['settings.json', 'status.json']) await cp(join(dataDir, f), join(raw, f));
    await writeFile(join(opts.out, 'README.md'), '# fixtures/web-data\n\nGenerated by `pnpm fixtures:web-data` (mock LLM mode). `pages/` is the Pages data tree; `raw/` stands in for the data branch. Do not edit by hand.\n', 'utf8');
    return { submitted, reranks, matches, files: built.files, out: opts.out };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** `fixtures generate`: texts and meta for every plan entry. Without --live the texts are the offline placeholders. */
export async function fixturesGenerate(ctx: Context, opts: { out: string; live: boolean; n?: number }): Promise<{ written: number }> {
  const plan = (await readPlan(ctx.env.fixturesDir)).slice(0, opts.n ?? 60);
  await mkdir(join(opts.out, 'resumes'), { recursive: true });
  let written = 0;
  for (const entry of plan) {
    let text: string;
    if (opts.live) {
      const res = await ctx.transport.call({
        purpose: 'fixture_text', model: (await loadSettings(ctx.store)).models.analyst, max_tokens: 8000, cache_ttl: '5m',
        system: 'You write synthetic résumés for a test corpus. Plain text only, no markdown. Use the placeholders [name], [email], [phone], [url] where a real document would carry those items. Never describe a real person. Keep the requested length within 10 %. End with a line "fixture: <slug>".',
        user: `slug: ${entry.slug}\ngroup: ${entry.group}\ncategory: ${entry.category}\nstage: ${entry.intended_stage}\ntarget_chars: ${entry.target_chars}\nbrief: ${entry.brief}`,
        thinking: true, fallbacks: false, stream: false,
      });
      text = (res.text ?? '').trim();
      if (!text) throw new Error(`fixtures generate: empty text for ${entry.slug}`);
    } else text = placeholderText(entry);
    const metrics = placeholderMetrics(text, entry);
    await writeFile(join(opts.out, 'resumes', `${entry.slug}.txt`), text, 'utf8');
    await writeFile(join(opts.out, 'resumes', `${entry.slug}.meta.json`), jsonFileText({ ...entry, metrics }), 'utf8');
    written++;
  }
  return { written };
}
