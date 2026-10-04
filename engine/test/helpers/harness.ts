// Shared test harness: an in-memory data tree with fixture anchors, a mock LLM, a frozen clock and
// helpers to submit fixture slugs and run the engine commands without touching the network or git.
import { join } from 'node:path';
import { normalizePayload, type RatingSettings, type Settings, type SubmissionInput, type SubmissionPayload } from '@resumearena/shared';
import { createClock, type MutableClock } from '../../src/clock.ts';
import { createContext, type Context, type ContextOverrides } from '../../src/context.ts';
import { readEnv, repoRootFromHere, type Env } from '../../src/env.ts';
import { createMockTransport, type MockOptions } from '../../src/llm/mock.ts';
import { loadPrompts, type PromptSet } from '../../src/llm/prompts.ts';
import { openMemoryStore, type MemoryStore } from '../../src/store/store.ts';
import { silentLogger } from '../../src/summary.ts';
import { dataInit } from '../../src/commands/data.ts';
import { loadFixture, payloadForFixture, readPlan } from '../../src/commands/fixtures.ts';
import type { PlanEntry } from '../../src/llm/mock.ts';
import { processManage, processSubmission, type SubmitReport } from '../../src/submit/pipeline.ts';
import { loadSettings } from '../../src/settings.ts';

export const REPO_ROOT = repoRootFromHere();
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
export const FROZEN_NOW = '2026-10-03T12:00:00Z';

let promptsCache: PromptSet | null = null;
export const prompts = (): PromptSet => (promptsCache ??= loadPrompts(join(REPO_ROOT, 'engine', 'prompts'), join(REPO_ROOT, 'docs', 'prompts')));

export function testEnv(overrides: Partial<Env> = {}): Env {
  const base = readEnv({ GITHUB_ACTIONS: 'false' });
  return { ...base, llmMode: 'mock', raEnv: 'local', githubToken: null, noGit: true, inActions: false, fixturesDir: FIXTURES_DIR, seed: 'test', runId: 'test-1', now: FROZEN_NOW, ...overrides };
}

export interface Harness {
  store: MemoryStore;
  clock: MutableClock;
  ctx: Context;
  settings: Settings;
  plan: PlanEntry[];
  /** Context for another run id / seed sharing the same store and clock. */
  fork(o: Partial<ContextOverrides> & { runId?: string; seed?: string }): Context;
  submitSlug(slug: string, o?: { visibility?: 'handle' | 'anonymous'; handle?: string; ownerKey?: string; text?: string; id?: string }): Promise<{ report: SubmitReport; input: SubmissionInput; payload: SubmissionPayload; ownerKey: string }>;
  submitPayload(payload: SubmissionPayload): Promise<{ report: SubmitReport; input: SubmissionInput }>;
  manage(payload: SubmissionPayload, o?: { exposeKey?: boolean }): Promise<SubmitReport>;
}

export type SettingsPatch = Partial<Omit<Settings, 'rating'>> & { rating?: Partial<RatingSettings> };

export async function createHarness(o: { settings?: SettingsPatch; anchors?: boolean; now?: string; seed?: string; mock?: Partial<MockOptions>; context?: Partial<ContextOverrides> } = {}): Promise<Harness> {
  const store = openMemoryStore();
  const clock = createClock(o.now ?? FROZEN_NOW);
  const { DEFAULT_SETTINGS } = await import('@resumearena/shared');
  const { rating: ratingPatch, ...rest } = o.settings ?? {};
  const settings: Settings = { ...DEFAULT_SETTINGS, ...rest, rating: { ...DEFAULT_SETTINGS.rating, ...(ratingPatch ?? {}) } };
  await dataInit(store, { now: clock.iso(), settings, anchorsDir: o.anchors === false ? null : join(FIXTURES_DIR, 'anchors') });
  const env = testEnv({ seed: o.seed ?? 'test' });
  const seed = o.seed ?? 'test';
  const transport = createMockTransport({ fixturesDir: FIXTURES_DIR, seed, ...(o.mock ?? {}) });
  const make = (extra: Partial<ContextOverrides> = {}): Context => createContext({ env, store, clock, transport, prompts: prompts(), seed, runId: 'test-1', log: silentLogger, ...o.context, ...extra });
  const ctx = make();
  const plan = await readPlan(FIXTURES_DIR);
  const loaded = await loadSettings(store);

  const submitPayload = async (payload: SubmissionPayload) => {
    const normalized = await normalizePayload(payload, { kind: 'dispatch', run_id: 1, issue_number: null, client_version: payload.client_version });
    if (!normalized.ok) throw new Error(`payload invalid: ${normalized.code} ${normalized.message}`);
    const report = await processSubmission({ ctx, settings: await loadSettings(store), wf: 'submit' }, normalized.input, payload);
    return { report, input: normalized.input };
  };

  return {
    store,
    clock,
    ctx,
    settings: loaded,
    plan,
    fork: (extra) => make(extra),
    async submitSlug(slug, so = {}) {
      const entry = plan.find((e) => e.slug === slug);
      if (!entry) throw new Error(`unknown slug ${slug}`);
      const f = await loadFixture(FIXTURES_DIR, entry);
      const fp = payloadForFixture(f, seed);
      const ownerKey = so.ownerKey ?? fp.owner_key;
      const payload: SubmissionPayload = {
        ...fp.payload,
        owner_key: ownerKey,
        owner_hash: '',
        ...(so.visibility ? { visibility: so.visibility } : {}),
        ...(so.handle ? { handle: so.handle } : {}),
        ...(so.text !== undefined ? { text: so.text } : {}),
        ...(so.id ? { submission_id: so.id } : {}),
      };
      const r = await submitPayload(payload);
      return { ...r, payload: { ...payload, owner_hash: r.input.owner_hash }, ownerKey };
    },
    submitPayload,
    async manage(payload, mo = {}) {
      const normalized = await normalizePayload(payload, { kind: 'dispatch', run_id: 1, issue_number: null, client_version: payload.client_version });
      if (!normalized.ok) throw new Error(`payload invalid: ${normalized.code} ${normalized.message}`);
      return processManage({ ctx, settings: await loadSettings(store), wf: 'submit' }, normalized.input, { exposeKey: mo.exposeKey === true });
    },
  };
}

/** Every file path ever written or removed on a memory store, for ownership assertions. */
export function trackWrites(store: MemoryStore): { paths: Set<string> } {
  const paths = new Set<string>();
  const wrap = <K extends 'writeJson' | 'writeText' | 'appendLines' | 'remove'>(k: K): void => {
    const orig = store[k] as (rel: string, ...rest: unknown[]) => Promise<void>;
    (store as unknown as Record<string, unknown>)[k] = (rel: string, ...rest: unknown[]) => {
      paths.add(rel.replace(/^\/+/, ''));
      return orig.call(store, rel, ...rest);
    };
  };
  wrap('writeJson');
  wrap('writeText');
  wrap('appendLines');
  wrap('remove');
  return { paths };
}
