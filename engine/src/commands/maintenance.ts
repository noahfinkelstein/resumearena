// `maintenance <action>` (§9.5, D-26, D-54, D-58): nightly, drain-queue, squash-data-history,
// rebuild-indexes, reanalyze, rotate-anchors, validate-anchors.
import {
  ANALYSIS_SCHEMA, ANCHOR_RATINGS, CATEGORIES, ResumeDocZ, UserDocZ, anchorId, inflateRd, parseCard, sweepCard,
  type Anchor, type AnchorsFile, type Card, type CardsShard, type Category, type CareerStage, type HistoryPoint, type ResumeDoc, type RowsShard, type Status, type UsageLine,
} from '@resumearena/shared';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../context.ts';
import { addDays, daysBetween, hoursBetween, isoOf, parseIso } from '../clock.ts';
import { enableWorkflows, isWorkflowEnabled } from '../github/runs.ts';
import { runAnalysis } from '../llm/analyst.ts';
import { interpret } from '../llm/calls.ts';
import { priceResponse } from '../llm/client.ts';
import { createJudge, type MatchRequest } from '../llm/judge.ts';
import { adjacentAnchorPairs, anchorsFileProblems, driftReport, farAnchorPairs, judgeHealth, loadAnchorsFile, type DriftReport, type JudgeHealth } from '../rank/anchors.ts';
import { openLedger, usageLine, type Ledger } from '../rank/budget.ts';
import { compactPoints } from '../rank/history.ts';
import { invalidate, loadState, type EngineState } from '../rank/state.ts';
import { readLinesSince, replayWal } from '../rank/wal.ts';
import { createRng } from '../rng.ts';
import { loadSettings, loadStatus } from '../settings.ts';
import { buildStatus, deployDecision } from '../status.ts';
import { appendLines, decide, writeJson, type Mutation } from '../store/commit.ts';
import { hasRemote, squashDataHistory } from '../store/git.ts';
import { FAILURES_DIR, USAGE_DIR, anchorValidationPath, anchorsPath, auditPath, cardsPath, dedupeCardPath, rebumpPath, resumePath, rowsPath, usagePath } from '../store/paths.ts';
import { writeOutputs, writeSummary } from '../summary.ts';
import { postValidate } from '../submit/analysis.ts';
import { cardsEntry, rowEntry } from '../submit/docs.ts';
import { computeRanks, finalizeMutations, readTokenExpiry, runRerank } from './rerank.ts';

export const MAINTENANCE_ACTIONS = ['nightly', 'drain-queue', 'squash-data-history', 'rebuild-indexes', 'reanalyze', 'rotate-anchors', 'validate-anchors'] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

export interface MaintenanceResult {
  action: MaintenanceAction;
  deploy: boolean;
  exitCode: 0 | 1;
  report: Record<string, unknown>;
}

export interface MaintenanceOptions {
  summaryPath?: string;
  outPath?: string;
}

export const ARCHIVE_AFTER_DAYS = 400;
export const REANALYZE_CAP = 200;
export const DRIFT_PERSISTENT_NIGHTS = 3;

export async function maintenanceCommand(ctx: Context, action: string, args: Record<string, unknown>, opts: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  if (!(MAINTENANCE_ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown maintenance action "${action}" (expected ${MAINTENANCE_ACTIONS.join('|')})`);
  let result: MaintenanceResult;
  switch (action as MaintenanceAction) {
    case 'nightly':
      result = await nightly(ctx, args);
      break;
    case 'drain-queue': {
      const r = await runRerank(ctx, { drainOnly: true, drainAll: true, trigger: 'maintenance' });
      result = { action: 'drain-queue', deploy: r.deploy, exitCode: r.state === 'failed' ? 1 : 0, report: { drained: r.drained, state: r.state } };
      break;
    }
    case 'squash-data-history':
      result = await squash(ctx);
      break;
    case 'rebuild-indexes':
      result = { action: 'rebuild-indexes', deploy: true, exitCode: 0, report: { note: 'engine no-op; the workflow deploy step rebuilds' } };
      break;
    case 'reanalyze':
      result = await reanalyze(ctx, args);
      break;
    case 'rotate-anchors':
      result = await rotateAnchors(ctx, args);
      break;
    case 'validate-anchors':
      result = await validateAnchors(ctx, args);
      break;
  }
  await writeOutputs(opts.outPath, { deploy: result.deploy });
  await writeSummary(opts.summaryPath, `### maintenance ${result.action}\n\n\`\`\`json\n${JSON.stringify(result.report, null, 2)}\n\`\`\`\n`);
  return result;
}

// ---- nightly ------------------------------------------------------------------------------------------

export interface AuditDoc {
  date: string;
  drift: Partial<Record<Category, DriftReport>>;
  judge: Partial<Record<Category, { disagreement_rate_7d: number | null; anchor_accuracy_7d: number | null }>>;
  inflated: number;
  compacted: number;
  squashed: boolean;
  anchor_validation: Record<string, unknown>;
  alerts: string[];
}

async function nightly(ctx: Context, args: Record<string, unknown>): Promise<MaintenanceResult> {
  await enableWorkflows(ctx.github);
  const now = ctx.clock.iso();
  const today = ctx.clock.day();
  const settings = await loadSettings(ctx.store);
  const prev = await loadStatus(ctx.store, now, settings);
  const state = await loadState(ctx.store, { settings, status: prev, runId: ctx.runId, now });
  const ledger = await openLedger(ctx.store, settings, today);
  const replayed = (await replayWal(state, ctx.store)).applied;
  computeRanks(state);

  // Days ring and RD inflation.
  let inflated = 0;
  for (const cat of CATEGORIES) {
    const cs = state.cats[cat];
    for (const row of cs.rows.values()) {
      if (row.kind !== 'user' || row.r === null || !row.elig) continue;
      row.days = [...row.days.filter((d) => d[0] !== today), [today, row.r, row.rank] as [string, number, number | null]].slice(-8);
      row.mv = 0;
      const idleDays = daysBetween(parseIso(row.last ?? row.created), ctx.clock.now());
      if (!row.locked && idleDays > 7) {
        const next = inflateRd(row.rd, settings.rating.rd_inflation_c, settings.rating.rd_ceiling);
        if (next !== row.rd) {
          row.rd = next;
          inflated++;
        }
      }
    }
    invalidate(cs);
  }

  // Drift and judge health over the last 7 days.
  const since = isoOf(new Date(ctx.clock.now().getTime() - 7 * 86_400_000));
  const drift: Partial<Record<Category, DriftReport>> = {};
  const health: Partial<Record<Category, JudgeHealth>> = {};
  const residual: Partial<Record<Category, number | null>> = {};
  for (const cat of CATEGORIES) {
    const lines = await readLinesSince(ctx.store, cat, since);
    const rep = driftReport(lines, { minGames: settings.rating.drift_min_games, maxShift: settings.rating.drift_max_shift });
    drift[cat] = rep;
    residual[cat] = rep.n ? rep.res : null;
    health[cat] = judgeHealth(lines);
    if (rep.shift !== 0 && settings.rating.drift_mode === 'anchors') {
      const cs = state.cats[cat];
      for (const row of cs.rows.values()) {
        if (row.locked || row.kind !== 'user' || row.r === null || !row.elig) continue;
        row.r = Math.round((row.r + rep.shift) * 100) / 100;
        if (row.r > row.peak) {
          row.peak = row.r;
          row.peak_at = today;
        }
        const doc = await state.history.get(cat, row.id, row.lin);
        doc.points.push([today, row.r, row.rd, 'd'] as HistoryPoint);
        state.history.touch(cat, row.id);
      }
      cs.shift = Math.round((cs.shift + rep.shift) * 100) / 100;
      invalidate(cs);
      state.notes.push(`${cat}: drift shift ${rep.shift} applied (n ${rep.n}, res ${rep.res})`);
    }
  }
  computeRanks(state);

  // Persistent drift: three nights running beyond the alert residual.
  const prevAudits = await Promise.all([1, 2].map((d) => ctx.store.readJson<AuditDoc>(auditPath(addDays(today, -d)))));
  const extraAlerts: string[] = [];
  for (const cat of CATEGORIES) {
    const over = (r: DriftReport | undefined): boolean => !!r && r.n > 0 && Math.abs(r.res) > settings.rating.drift_alert_residual;
    if (over(drift[cat]) && prevAudits.every((a) => over(a?.drift?.[cat]))) extraAlerts.push(`drift_persistent:${cat}`);
  }
  for (const cat of CATEGORIES) {
    const latest = await latestAnchorValidation(ctx, cat);
    if (latest && latest.ok === false) extraAlerts.push(`anchor_validation_failed:${cat}`);
  }

  // History compaction for rows touched in the last 24 h.
  let compacted = 0;
  for (const cat of CATEGORIES) {
    for (const row of state.cats[cat].rows.values()) {
      if (row.kind !== 'user' || !row.last || hoursBetween(parseIso(row.last), ctx.clock.now()) > 24) continue;
      const doc = await state.history.get(cat, row.id, row.lin);
      const next = compactPoints(doc.points, today, settings.retention.history_points);
      if (next.length !== doc.points.length) {
        doc.points = next;
        state.history.touch(cat, row.id);
        compacted++;
      }
    }
  }

  const archived = await archiveOld(ctx, today, ARCHIVE_AFTER_DAYS);
  const counts = args.recount === false ? {} : await recount(ctx);
  const healthPatch: Partial<Status['health']> = { token_expires: readTokenExpiry(ctx) ?? prev.health.token_expires };
  if (ctx.github.enabled) {
    const enabled = await isWorkflowEnabled(ctx.github, 'rerank.yml');
    if (enabled !== null) healthPatch.schedule_enabled = enabled;
  }
  const deploy = deployDecision(prev, true, now, settings.retention.min_deploy_interval_minutes);
  const status = buildStatus({
    prev, settings, now, ledger, cats: state.cats, prompts: ctx.prompts, counts,
    queue: prev.queue, health: healthPatch, perCategoryHealth: health, perCategoryResidual: residual, extraAlerts,
    lastDeployRequestedAt: deploy.last_deploy_requested_at, deployPending: deploy.deploy_pending,
  });
  const sunday = ctx.clock.now().getUTCDay() === 0;
  const audit: AuditDoc = {
    date: today,
    drift,
    judge: Object.fromEntries(CATEGORIES.map((c) => [c, { disagreement_rate_7d: health[c]?.disagreement_rate_7d ?? null, anchor_accuracy_7d: health[c]?.anchor_accuracy_7d ?? null }])),
    inflated,
    compacted,
    squashed: false,
    anchor_validation: {},
    alerts: status.health.alerts,
  };
  const mutations = await finalizeMutations(ctx, state, ledger, status, true);
  mutations.push(writeJson(auditPath(today), audit));
  for (const m of archived) mutations.push(m);
  await ctx.commit(`maintenance nightly ${today}`, mutations);

  let squashed = false;
  if (sunday && ctx.store.kind === 'fs' && (await hasRemote(ctx.store.root)) && !ctx.env.noGit) {
    await squashDataHistory(ctx.store.root, { date: today });
    squashed = true;
  }
  return {
    action: 'nightly',
    deploy: deploy.deploy,
    exitCode: 0,
    report: { replayed, inflated, compacted, archived: archived.length, drift, alerts: status.health.alerts, squashed, counts: status.counts, notes: state.notes },
  };
}

async function latestAnchorValidation(ctx: Context, cat: Category): Promise<{ ok: boolean } | null> {
  await ctx.store.materialize(['/audits/']);
  const files = (await ctx.store.list('audits/')).filter((f) => f.startsWith(`anchor-validation-${cat}-`)).sort();
  const last = files[files.length - 1];
  return last ? ctx.store.readJson<{ ok: boolean }>(`audits/${last}`) : null;
}

/** usage/ and failures/ older than `days` move under archive/ (one read, one write, one remove each). */
async function archiveOld(ctx: Context, today: string, days: number): Promise<Mutation[]> {
  const cutoff = addDays(today, -days);
  const out: Mutation[] = [];
  for (const dir of [USAGE_DIR, FAILURES_DIR]) {
    await ctx.store.materialize([`/${dir}`]);
    for (const name of await ctx.store.list(dir)) {
      const day = name.replace(/\.jsonl$/, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
      const src = `${dir}${name}`;
      out.push(
        decide([`/${src}`, `/archive/${dir}`], async (store) => {
          const text = await store.readText(src);
          if (text === null) return;
          await store.writeText(`archive/${src}`, text);
          await store.remove(src);
        }),
      );
    }
  }
  return out;
}

/** Full recount of resumes/ and users/ (§9.5 nightly). */
export async function recount(ctx: Context): Promise<Partial<Status['counts']>> {
  await ctx.store.materialize(['/resumes/', '/users/']);
  const counts: Partial<Status['counts']> = { resumes: 0, analyzed: 0, queued: 0, held: 0, needs_review: 0, rejected: 0, duplicate: 0, superseded: 0, deleted: 0, users: 0 };
  for (const file of await ctx.store.listFiles('resumes')) {
    if (!file.endsWith('.json')) continue;
    const parsed = ResumeDocZ.safeParse(await ctx.store.readJson(file));
    if (!parsed.success) continue;
    counts.resumes = (counts.resumes ?? 0) + 1;
    const key = parsed.data.status as keyof Status['counts'];
    if (key in counts) counts[key] = (counts[key] ?? 0) + 1;
  }
  for (const file of await ctx.store.listFiles('users')) {
    if (!file.endsWith('.json')) continue;
    const parsed = UserDocZ.safeParse(await ctx.store.readJson(file));
    if (parsed.success && parsed.data.state === 'active') counts.users = (counts.users ?? 0) + 1;
  }
  return counts;
}

// ---- squash ----------------------------------------------------------------------------------------------

async function squash(ctx: Context): Promise<MaintenanceResult> {
  if (ctx.store.kind !== 'fs' || !(await hasRemote(ctx.store.root)) || ctx.env.noGit) {
    ctx.log.warn('squash-data-history: no remote, nothing to squash');
    return { action: 'squash-data-history', deploy: false, exitCode: 0, report: { squashed: false } };
  }
  const sha = await squashDataHistory(ctx.store.root, { date: ctx.clock.day() });
  return { action: 'squash-data-history', deploy: false, exitCode: 0, report: { squashed: true, sha } };
}

// ---- reanalyze ---------------------------------------------------------------------------------------

async function reanalyze(ctx: Context, args: Record<string, unknown>): Promise<MaintenanceResult> {
  const settings = await loadSettings(ctx.store);
  const ledger = await openLedger(ctx.store, settings, ctx.clock.day());
  const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
  const since = typeof args.since === 'string' ? args.since : null;
  const all = args.all === true;
  const rebump = args.rebump === true;
  await ctx.store.materialize(['/resumes/']);
  const targets: ResumeDoc[] = [];
  const files = ids.length && !all && !since ? ids.map(resumePath) : await ctx.store.listFiles('resumes');
  for (const file of files) {
    const parsed = ResumeDocZ.safeParse(await ctx.store.readJson(file));
    if (!parsed.success) continue;
    const doc = parsed.data as ResumeDoc;
    if (doc.status !== 'analyzed' || !doc.text || !doc.gate) continue;
    if (!doc.text) continue;
    if (since && doc.created_at < since) continue;
    targets.push(doc);
    if (targets.length >= REANALYZE_CAP) break;
  }
  let done = 0;
  let skipped = 0;
  const notes: string[] = [];
  for (const doc of targets) {
    const text = doc.text as string;
    const gate = doc.gate as NonNullable<ResumeDoc['gate']>;
    if (ledger.spentToday() + settings.est_submission_cost_usd > settings.daily_budget_usd) {
      notes.push('budget reached');
      break;
    }
    const res = await runAnalysis({ transport: ctx.transport, settings, prompts: ctx.prompts, prices: settings.prices_usd_per_mtok, log: ctx.log }, { text, metrics: doc.metrics ?? emptyMetrics() });
    const lines: UsageLine[] = res.usage.map((e) => usageLine({ at: ctx.clock.iso(), run: ctx.runId, wf: 'maintenance', purpose: 'reanalysis', model: e.model, tok: e.tok, usd: e.usd, ref: doc.id }));
    for (const l of lines) ledger.record(l);
    if (!res.ok) {
      skipped++;
      notes.push(`${doc.id}: ${res.reason}`);
      await ctx.commit(`reanalyze ${doc.id}`, [appendLines(usagePath(ledger.day), lines)]);
      continue;
    }
    const post = postValidate(res.value, gate.verdict, settings.rating.category_relevance_min);
    if (post.status !== 'analyzed') {
      skipped++;
      notes.push(`${doc.id}: reanalysis would be ${post.status}; left untouched`);
      await ctx.commit(`reanalyze ${doc.id}`, [appendLines(usagePath(ledger.day), lines)]);
      continue;
    }
    const now = ctx.clock.iso();
    const next: ResumeDoc = {
      ...doc, updated_at: now, analysis: post.analysis, card_sha256: post.cardSha256, category_relevance: post.categoryRelevance, scores: post.scores, stage: post.stage, top_signal: post.topSignal,
      versions: { analyst_model: res.model, analyst_prompt: ctx.prompts.analyst.version, gate_prompt: gate.prompt, schema: settings.prompts.schema, taxonomy: settings.prompts.taxonomy, fell_back: res.fell_back },
    };
    const paths = [`/${resumePath(doc.id)}`, `/${rowsPath(doc.id)}`, `/${cardsPath(doc.id)}`, '/dedupe/card/', `/${usagePath(ledger.day)}`, `/${rebumpPath(doc.id)}`];
    await ctx.commit(`reanalyze ${doc.id}`, [
      decide(paths, async (store) => {
        const current = ResumeDocZ.safeParse(await store.readJson(resumePath(doc.id)));
        if (!current.success || current.data.status !== 'analyzed') return;
        await store.writeJson(resumePath(doc.id), next);
        const rows = (await store.readJson<RowsShard>(rowsPath(doc.id))) ?? {};
        const old = rows[doc.id];
        rows[doc.id] = { ...rowEntry(next, post), v: old?.v ?? next.visibility, s: 'analyzed' };
        await store.writeJson(rowsPath(doc.id), rows);
        const cards = (await store.readJson<CardsShard>(cardsPath(doc.id))) ?? {};
        cards[doc.id] = cardsEntry(post.analysis.card, post.stage);
        await store.writeJson(cardsPath(doc.id), cards);
        if (doc.card_sha256 && doc.card_sha256 !== post.cardSha256) {
          const dedupe = await store.readJson<{ id: string }>(dedupeCardPath(doc.card_sha256));
          if (dedupe?.id === doc.id) await store.remove(dedupeCardPath(doc.card_sha256));
          await store.writeJson(dedupeCardPath(post.cardSha256), { id: doc.id, owner_hash: doc.owner_hash, t: now });
        }
        if (rebump) await store.writeJson(rebumpPath(doc.id), { schema: 1, id: doc.id, requested_at: now });
        await store.appendLines(usagePath(ledger.day), lines.map((l) => JSON.stringify(l)));
      }),
    ]);
    done++;
  }
  return { action: 'reanalyze', deploy: done > 0, exitCode: 0, report: { targets: targets.length, done, skipped, usd: ledger.pendingUsd(), notes } };
}

const emptyMetrics = () => ({ source: 'paste' as const, pages: 0, columns_detected: 0 as const, font_count: 0, image_count: 0, char_count: 0, word_count: 0, extraction_quality: 0, redactions: { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 } });

// ---- anchors -----------------------------------------------------------------------------------------

/** ranking-system.md §3.5 authoring guide, filled monotonically; stages spread across the ladder. */
export const ANCHOR_BRIEFS: Record<number, { stage: CareerStage; spec: string }> = {
  1000: { stage: 'student', spec: 'minimal: coursework, one unrelated job' },
  1100: { stage: 'new_grad', spec: 'minimal plus: a vocational credential, one entry-level role, tutorial-grade projects' },
  1200: { stage: 'early', spec: 'below typical: two years at a small firm, duty-only bullets, no selective signal' },
  1300: { stage: 'early', spec: 'typical: one relevant internship at a non-selective firm, a class project' },
  1400: { stage: 'student', spec: 'typical plus: a known mid-tier employer, one quantified outcome, a regional award' },
  1500: { stage: 'mid', spec: 'solid: competitive internship or B-tier role, concrete outcomes' },
  1600: { stage: 'new_grad', spec: 'solid plus: A-tier new-grad offer or promotion ahead of ladder, two quantified outcomes' },
  1700: { stage: 'senior', spec: 'strong: top firm, measurable scope, one independent signal' },
  1800: { stage: 'mid', spec: 'strong plus: A-tier staff-level scope or first-author strong venue, a highly selective fellowship' },
  1900: { stage: 'senior', spec: 'exceptional: multiple top-tier roles, leadership, awards' },
  2000: { stage: 'student', spec: 'exceptional plus: S-tier selection as a student, an elite competition result' },
  2100: { stage: 'executive', spec: 'rare: founder with outcome / first-author at top venue / IMO-level competition' },
};

const ANCHOR_GEN_SYSTEM = [
  'You write one anonymized résumé card for the ResumeArena calibration scale. The user message names the leaderboard category, the target rating (1000 = minimal, 1500 = solid, 2100 = rare), the career stage and a short brief.',
  'Return exactly one JSON object matching the Card schema. Invent a plausible but fictional person: real employer, school and venue names are fine (the rubric tiers them); never a person’s name, contact detail, URL or exact date. Strength must match the rating: a 1900 card is strictly more impressive than an 1800 card in the same category.',
].join('\n');

function cardSchema(): Record<string, unknown> {
  const root = ANALYSIS_SCHEMA as unknown as { $defs: Record<string, unknown> };
  return { ...(root.$defs.Card as Record<string, unknown>), $defs: root.$defs };
}

async function rotateAnchors(ctx: Context, args: Record<string, unknown>): Promise<MaintenanceResult> {
  const cat = args.category as Category;
  if (!CATEGORIES.includes(cat)) throw new Error('rotate-anchors needs args.category');
  const settings = await loadSettings(ctx.store);
  const ledger = await openLedger(ctx.store, settings, ctx.clock.day());
  const now = ctx.clock.iso();
  let anchors: Anchor[];
  let usd = 0;
  if (Array.isArray(args.cards)) {
    anchors = (args.cards as { rating: number; stage: CareerStage; spec: string; card: unknown }[]).map((c) => {
      const parsed = parseCard(c.card);
      if (!parsed.ok) throw new Error(`rotate-anchors: card for ${c.rating} invalid: ${parsed.message}`);
      return { id: anchorId(cat, c.rating), rating: c.rating, stage: c.stage, spec: c.spec, card: sweepCard(parsed.value).card };
    });
  } else if (args.generate === true) {
    anchors = [];
    for (const rating of ANCHOR_RATINGS) {
      const brief = ANCHOR_BRIEFS[rating] as { stage: CareerStage; spec: string };
      const res = await ctx.transport.call({
        purpose: 'anchor_gen', model: settings.models.analyst, max_tokens: 8000, system: ANCHOR_GEN_SYSTEM, cache_ttl: '5m',
        user: `category: ${cat}\nrating: ${rating}\nstage: ${brief.stage}\nspec: ${brief.spec}`,
        schema: cardSchema(), effort: 'high', thinking: true, fallbacks: true, stream: false,
      });
      const priced = priceResponse(res, settings.prices_usd_per_mtok, ctx.log);
      usd += priced.usd;
      ledger.record(usageLine({ at: now, run: ctx.runId, wf: 'maintenance', purpose: 'fixtures', model: res.model, tok: priced.tok, usd: priced.usd, ref: anchorId(cat, rating) }));
      const out = interpret(res, parseCard);
      if (out.kind !== 'ok') throw new Error(`rotate-anchors: generation for ${cat} ${rating} failed: ${out.detail}`);
      anchors.push({ id: anchorId(cat, rating), rating, stage: brief.stage, spec: brief.spec, card: sweepCard(out.value).card });
    }
  } else {
    const fixture = join(ctx.env.fixturesDir, 'anchors', `${cat}.json`);
    if (!existsSync(fixture)) throw new Error('rotate-anchors needs args.cards, args.generate or fixtures/anchors/<cat>.json');
    anchors = (JSON.parse(readFileSync(fixture, 'utf8')) as AnchorsFile).anchors;
  }
  const file: AnchorsFile = { schema: 1, category: cat, prompt_version: ctx.prompts.judge.version, validated_at: null, anchors: [...anchors].sort((a, b) => a.rating - b.rating) };
  const problems = anchorsFileProblems(file);
  if (problems.length) throw new Error(`rotate-anchors: ${problems.join('; ')}`);
  const mutations: Mutation[] = [writeJson(anchorsPath(cat), file)];
  if (ledger.pending.length) mutations.push(appendLines(usagePath(ledger.day), ledger.pending));
  await ctx.commit(`anchors: rotate ${cat}`, mutations);
  const validation = await validateAnchors(ctx, { category: cat });
  return { action: 'rotate-anchors', deploy: false, exitCode: validation.exitCode, report: { category: cat, generated: args.generate === true, usd, validation: validation.report } };
}

export interface AnchorValidationReport {
  category: Category;
  date: string;
  prompt_version: string;
  adjacent: { lower: string; higher: string; wins: number; draws: number; losses: number; ok: boolean }[];
  far: { lower: string; higher: string; lost: boolean }[];
  matches: number;
  usd: number;
  ok: boolean;
}

async function validateAnchors(ctx: Context, args: Record<string, unknown>): Promise<MaintenanceResult> {
  const cat = args.category as Category;
  if (!CATEGORIES.includes(cat)) throw new Error('validate-anchors needs args.category');
  const settings = await loadSettings(ctx.store);
  const file = await loadAnchorsFile(ctx.store, cat);
  if (!file) throw new Error(`validate-anchors: anchors/${cat}.json missing`);
  const ledger = await openLedger(ctx.store, settings, ctx.clock.day());
  const now = ctx.clock.iso();
  const judge = createJudge({ transport: ctx.transport, settings, prompts: ctx.prompts, prices: settings.prices_usd_per_mtok, rng: createRng(`${ctx.seed}|validate|${cat}`), purposeOverride: 'judge_anchor', log: ctx.log });
  const req = (lower: Anchor, higher: Anchor): MatchRequest => {
    const [a, b] = lower.id < higher.id ? [lower, higher] : [higher, lower];
    return { cat, kind: 'anchor', period: `${higher.id}:${cat}:validate`, subj: higher.id, a: a.id, b: b.id, cardA: a.card, cardB: b.card, pre: { ar: a.rating, ard: 30, br: b.rating, brd: 30 } };
  };
  const adjacent = adjacentAnchorPairs(file);
  const far = farAnchorPairs(file);
  const plan: MatchRequest[] = [];
  for (const p of adjacent) for (let i = 0; i < 5; i++) plan.push(req(p.lower, p.higher));
  for (const p of far) plan.push(req(p.lower, p.higher));
  const results = await judge.judgeMany(plan);
  let usd = 0;
  for (const [i, res] of results.entries()) {
    for (const ev of res.usage) {
      usd += ev.usd;
      ledger.record(usageLine({ at: now, run: ctx.runId, wf: 'maintenance', purpose: 'judge_anchor', model: ev.model, tok: ev.tok, usd: ev.usd, ref: `${plan[i]!.a}|${plan[i]!.b}` }));
    }
  }
  const higherScore = (i: number): number | null => {
    const res = results[i];
    const r = plan[i] as MatchRequest;
    if (!res || !res.ok) return null;
    return r.subj === r.a ? res.o : 1 - res.o;
  };
  const report: AnchorValidationReport = { category: cat, date: ctx.clock.day(), prompt_version: ctx.prompts.judge.version, adjacent: [], far: [], matches: plan.length, usd: Math.round(usd * 1e6) / 1e6, ok: true };
  let idx = 0;
  for (const p of adjacent) {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    for (let i = 0; i < 5; i++, idx++) {
      const s = higherScore(idx);
      if (s === 1) wins++;
      else if (s === 0.5) draws++;
      else if (s === 0) losses++;
    }
    const ok = wins / 5 >= 0.6;
    if (!ok) report.ok = false;
    report.adjacent.push({ lower: p.lower.id, higher: p.higher.id, wins, draws, losses, ok });
  }
  for (const p of far) {
    const lost = higherScore(idx++) === 0;
    if (lost) report.ok = false;
    report.far.push({ lower: p.lower.id, higher: p.higher.id, lost });
  }
  const mutations: Mutation[] = [writeJson(anchorValidationPath(cat, report.date), report)];
  if (report.ok) mutations.push(writeJson(anchorsPath(cat), { ...file, validated_at: now, prompt_version: ctx.prompts.judge.version }));
  if (ledger.pending.length) mutations.push(appendLines(usagePath(ledger.day), ledger.pending));
  await ctx.commit(`anchors: validate ${cat}`, mutations);
  return { action: 'validate-anchors', deploy: false, exitCode: 0, report: report as unknown as Record<string, unknown> };
}

export type { Card, EngineState, Ledger };
