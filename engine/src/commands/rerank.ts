// `rerank` (§9.4): load → replay WAL → deletes → drain → ingest → placement waves → refinement → ranks →
// arena → finalize. Every wave is a WAL commit before it is applied; the apply commit comes last.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnalysisQueueEntryZ, CATEGORIES, DeleteRequestZ, PlacementTicketZ, rankAndPercentile, normalizePayload,
  type ArenaPair, type Category, type MatchLine, type RatingRow, type Settings, type Status,
} from '@resumearena/shared';
import type { Context } from '../context.ts';
import { numericRunId } from '../env.ts';
import { isWorkflowEnabled, runsLast24h, submissionsLastHour, submitPathCounts } from '../github/runs.ts';
import { createJudge, JudgeFatal, type Judge, type MatchRequest, type MatchResult } from '../llm/judge.ts';
import { openLedger, usageLine, type Ledger } from '../rank/budget.ts';
import { applyLines, seedWaitingDomains } from '../rank/fold.ts';
import { arenaPairFrom, isArenaKind, updateArena } from '../rank/arena.ts';
import type { PairingContext } from '../rank/pairing.ts';
import { categoriesForWave, GENERAL_WAVES, isPlacementCandidate, planPlacementRound } from '../rank/placement.ts';
import { planRefinement, refinementCandidates, sampleRefinement } from '../rank/refine.ts';
import { cardLookup, invalidate, loadState, newDomainRow, newGeneralRow, ownOf, serializeRatings, sortedRows, type CatState, type EngineState } from '../rank/state.ts';
import { buildMatchLine, currentWalFile, replayWal } from '../rank/wal.ts';
import { createRng, type Rng } from '../rng.ts';
import { loadSettings, loadStatus } from '../settings.ts';
import { buildStatus, deployDecision } from '../status.ts';
import { appendLines, decide, PushRejectedError, removeFile, writeJson, type Mutation } from '../store/commit.ts';
import { ANALYSIS_QUEUE_DIR, DELETE_QUEUE_DIR, PLACEMENT_QUEUE_DIR, REBUMP_QUEUE_DIR, STATUS_PATH, analysisQueuePath, arenaPath, placementTicketPath, ratingsPath, usagePath } from '../store/paths.ts';
import { markdownTable, writeOutputs, writeSummary } from '../summary.ts';
import { processSubmission } from '../submit/pipeline.ts';

export interface RerankOptions {
  maxWaves?: number;
  dryRun?: boolean;
  summaryPath?: string;
  outPath?: string;
  settings?: Settings;
  judge?: Judge;
  trigger?: string;
  /** maintenance drain-queue: no per-run cap on deferred analyses. */
  drainAll?: boolean;
  /** Skip placement/refinement entirely (drain-queue action). */
  drainOnly?: boolean;
}

export interface RerankReport {
  state: 'ok' | 'failed' | 'aborted_budget' | 'aborted_judge';
  waves: number;
  matches: number;
  placementMatches: number;
  refineMatches: number;
  placed: number;
  ingested: number;
  drained: number;
  deleted: number;
  replayed: number;
  usd: number;
  changed: boolean;
  deploy: boolean;
  error: string | null;
  durationS: number;
}

interface RunCtx {
  ctx: Context;
  settings: Settings;
  state: EngineState;
  ledger: Ledger;
  judge: Judge;
  /** The engine's own judge ledgers each call as it happens; an injected judge (tests, simulation) is billed from its results. */
  usageViaCallback: boolean;
  rng: Rng;
  report: RerankReport;
  playedThisWave: Map<string, number>;
}

const pairRef = (req: MatchRequest): string => (req.a < req.b ? `${req.a}|${req.b}` : `${req.b}|${req.a}`);

const REFINE_WAVE_OFFSET = 1;
const REBUMP_RD = 120;

export async function runRerank(ctx: Context, opts: RerankOptions = {}): Promise<RerankReport> {
  const startedMs = Date.now();
  const now = ctx.clock.iso();
  const settings = opts.settings ?? (await loadSettings(ctx.store));
  const prevStatus = await loadStatus(ctx.store, now, settings);
  const state = await loadState(ctx.store, { settings, status: prevStatus, runId: ctx.runId, now });
  const ledger = await openLedger(ctx.store, settings, ctx.clock.day());
  const rng = createRng(ctx.seed);
  const report: RerankReport = { state: 'ok', waves: 0, matches: 0, placementMatches: 0, refineMatches: 0, placed: 0, ingested: 0, drained: 0, deleted: 0, replayed: 0, usd: 0, changed: false, deploy: false, error: null, durationS: 0 };
  const shouldStop = (): boolean => ledger.hardStop() || ctx.clock.elapsedMs() > settings.rating.soft_wall_clock_minutes * 60_000;
  // Spend reaches the ledger per call, so the hard stop (checked before every call) sees it mid-wave.
  const judge =
    opts.judge ??
    createJudge({
      transport: ctx.transport, settings, prompts: ctx.prompts, prices: settings.prices_usd_per_mtok, rng: rng.derive('judge'), shouldStop, log: ctx.log,
      onUsage: (purpose, ev, req) => ledger.record(usageLine({ at: ctx.clock.iso(), run: ctx.runId, wf: 'rerank', purpose, model: ev.model, tok: ev.tok, usd: ev.usd, ref: pairRef(req) })),
    });
  const run: RunCtx = { ctx, settings, state, ledger, judge, usageViaCallback: opts.judge === undefined, rng, report, playedThisWave: new Map() };
  const maxWaves = opts.maxWaves ?? 5;

  // 2. Replay. Rows a dead run created but never persisted are re-ingested from their tickets on demand.
  const ticketsAtStart = await listTickets(ctx);
  const byId = new Map(ticketsAtStart.map((t) => [t.ticket.id, t]));
  state.ensureRow = async (id) => {
    const t = byId.get(id);
    if (t && !state.cats.general.rows.has(id)) {
      if (await ingestOne(run, t.ticket, t.path)) report.ingested++;
    }
  };
  const replay = await replayWal(state, ctx.store);
  delete state.ensureRow;
  report.replayed = replay.applied;
  if (replay.applied) report.changed = true;

  if (opts.dryRun) {
    const tickets = await listTickets(ctx);
    ctx.log.info(`dry-run: replayed ${replay.applied} lines; ${tickets.length} tickets waiting; allowance ${ledger.allowance(ctx.clock.now())}`);
    report.durationS = (Date.now() - startedMs) / 1000;
    return report;
  }

  let judgeFatal: JudgeFatal | null = null;
  try {
    // 3. Delete requests.
    report.deleted = await applyDeleteRequests(run);
    // 4. Drain the analysis queue.
    if (!settings.paused) report.drained = await drainAnalysisQueue(run, opts.drainAll === true);
    if (!opts.drainOnly) {
      // 5. Ingest tickets, then honour reanalyze rebump markers (§9.5).
      report.ingested = await ingestTickets(run);
      await applyRebumps(run);
      // 6. Placement waves, resuming the wave count after a restart.
      let wave = replay.ownMaxWave;
      for (let w = wave + 1; w <= maxWaves; w++) {
        if (shouldStop()) break;
        wave = w;
        if (w === GENERAL_WAVES + 1) for (const id of generalPlacedIds(state)) seedWaitingDomains(state, id);
        const plan = await planPlacementWave(run, w);
        if (plan.length === 0) continue;
        report.waves = w;
        const ok = await judgeAndApply(run, plan, w, 'placement');
        if (!ok) break;
      }
      // 7. Refinement.
      if (report.state === 'ok' && !shouldStop()) {
        const refineWave = Math.max(wave, maxWaves) + REFINE_WAVE_OFFSET;
        const plan = await planRefinementWave(run, refineWave);
        if (plan.length) {
          report.waves = refineWave;
          await judgeAndApply(run, plan, refineWave, 'refine');
        }
      }
    }
  } catch (e) {
    if (e instanceof JudgeFatal) {
      judgeFatal = e;
      report.state = e.code === 'config' ? 'failed' : 'aborted_judge';
      report.error = e.message;
      ctx.log.error(e.message);
    } else if (e instanceof PushRejectedError) {
      report.state = 'failed';
      report.error = e.message;
      ctx.log.error(e.message);
    } else throw e;
  }
  if (report.state === 'ok' && ledger.hardStop() && (report.ingested || report.matches)) report.state = report.matches ? 'ok' : 'aborted_budget';

  // 8. Ranks.
  computeRanks(state);
  // 9. Arena pools are updated as matches apply; eligibility re-check happens in finalize.
  // 10. Finalize.
  const changed = report.changed || report.ingested > 0 || report.deleted > 0 || report.matches > 0 || report.drained > 0;
  report.changed = changed;
  report.usd = ledger.runUsd();
  const judgeHealthy = judgeFatal?.code === 'judge_unavailable' ? false : judge.healthy() || (judge.stats().calls === 0 ? prevStatus.health.judge_healthy : judge.healthy());
  const deploy = deployDecision(prevStatus, changed, now, settings.retention.min_deploy_interval_minutes);
  report.deploy = deploy.deploy;
  report.durationS = Math.round((Date.now() - startedMs) / 1000);
  const status = await assembleStatus(run, prevStatus, {
    judgeHealthy,
    lastRerank: { run_id: numericRunId(ctx.runId), at: now, trigger: opts.trigger ?? ctx.env.trigger, waves: report.waves, matches: report.matches, placements_completed: report.placed, duration_s: report.durationS, changed, state: report.state },
    deploy,
  });
  try {
    await finalize(run, status, changed);
  } catch (e) {
    if (!(e instanceof PushRejectedError)) throw e;
    report.state = 'failed';
    report.error = e.message;
    report.deploy = false;
    ctx.log.error(e.message);
  }
  await writeOutputs(opts.outPath, { deploy: report.deploy });
  await writeSummary(
    opts.summaryPath,
    markdownTable(
      ['state', 'waves', 'matches', 'placed', 'ingested', 'drained', 'deleted', 'replayed', 'usd', 'duration_s', 'deploy'],
      [[report.state, report.waves, report.matches, report.placed, report.ingested, report.drained, report.deleted, report.replayed, report.usd.toFixed(4), report.durationS, report.deploy]],
    ) + (state.notes.length ? `\n${state.notes.map((n) => `- ${n}`).join('\n')}\n` : ''),
  );
  return report;
}

// ---- step 3: delete requests ----------------------------------------------------------------------

async function applyDeleteRequests(run: RunCtx): Promise<number> {
  const { ctx, state } = run;
  await ctx.store.materialize([`/${DELETE_QUEUE_DIR}`]);
  const names = (await ctx.store.list(DELETE_QUEUE_DIR)).filter((n) => n.endsWith('.json'));
  let n = 0;
  for (const name of names) {
    const path = `${DELETE_QUEUE_DIR}${name}`;
    const parsed = DeleteRequestZ.safeParse(await ctx.store.readJson(path));
    if (!parsed.success) {
      state.removed.add(path);
      continue;
    }
    const id = parsed.data.id;
    for (const cat of CATEGORIES) {
      const cs = state.cats[cat];
      if (cs.rows.delete(id)) invalidate(cs);
      state.history.remove(cat, id);
    }
    state.removed.add(placementTicketPath(id));
    state.removed.add(analysisQueuePath(id));
    state.removed.add(path);
    n++;
  }
  return n;
}

// ---- step 4: drain queue/analysis -----------------------------------------------------------------

async function drainAnalysisQueue(run: RunCtx, all: boolean): Promise<number> {
  const { ctx, settings, ledger } = run;
  await ctx.store.materialize([`/${ANALYSIS_QUEUE_DIR}`]);
  const entries: { path: string; enqueued_at: string; raw: unknown }[] = [];
  for (const name of await ctx.store.list(ANALYSIS_QUEUE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const path = `${ANALYSIS_QUEUE_DIR}${name}`;
    const raw = await ctx.store.readJson<unknown>(path);
    const parsed = AnalysisQueueEntryZ.safeParse(raw);
    if (parsed.success) entries.push({ path, enqueued_at: parsed.data.enqueued_at, raw: parsed.data });
  }
  entries.sort((a, b) => (a.enqueued_at < b.enqueued_at ? -1 : a.enqueued_at > b.enqueued_at ? 1 : a.path < b.path ? -1 : 1));
  const cap = all ? Infinity : settings.rating.max_deferred_analyses_per_run;
  let drained = 0;
  for (const entry of entries) {
    if (drained >= cap) break;
    if (ledger.spentToday() + settings.est_submission_cost_usd > settings.daily_budget_usd) break;
    const e = entry.raw as { payload: Parameters<typeof normalizePayload>[0]; source: Parameters<typeof normalizePayload>[1] };
    const normalized = await normalizePayload(e.payload, e.source);
    if (!normalized.ok) {
      // Only a hand-edited or pre-fix entry fails here; dropping it is the safe choice, and the summary says so.
      ctx.log.warn(`queue/analysis ${entry.path}: stored payload no longer validates (${normalized.code}: ${normalized.message}); dropped`);
      run.state.notes.push(`${entry.path}: dropped (payload ${normalized.code})`);
      run.state.removed.add(entry.path);
      continue;
    }
    await processSubmission({ ctx, settings, wf: 'rerank', drainedFrom: entry.path, ledger }, normalized.input, e.payload as Parameters<typeof processSubmission>[2]);
    drained++;
  }
  return drained;
}

// ---- rebump markers (maintenance reanalyze --rebump) ------------------------------------------------

async function applyRebumps(run: RunCtx): Promise<void> {
  const { ctx, state } = run;
  await ctx.store.materialize([`/${REBUMP_QUEUE_DIR}`]);
  for (const name of await ctx.store.list(REBUMP_QUEUE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    for (const cat of CATEGORIES) {
      const row = state.cats[cat].rows.get(id);
      if (row && !row.locked && row.r !== null && row.rd < REBUMP_RD) {
        row.rd = REBUMP_RD;
        invalidate(state.cats[cat]);
        run.report.changed = true;
      }
    }
    state.removed.add(`${REBUMP_QUEUE_DIR}${name}`);
  }
}

// ---- step 5: tickets -------------------------------------------------------------------------------

async function listTickets(ctx: Context): Promise<{ path: string; ticket: ReturnType<typeof PlacementTicketZ.parse> }[]> {
  await ctx.store.materialize([`/${PLACEMENT_QUEUE_DIR}`]);
  const out: { path: string; ticket: ReturnType<typeof PlacementTicketZ.parse> }[] = [];
  for (const name of await ctx.store.list(PLACEMENT_QUEUE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const path = `${PLACEMENT_QUEUE_DIR}${name}`;
    const parsed = PlacementTicketZ.safeParse(await ctx.store.readJson(path));
    if (parsed.success) out.push({ path, ticket: parsed.data });
  }
  out.sort((a, b) => (a.ticket.queued_at < b.ticket.queued_at ? -1 : a.ticket.queued_at > b.ticket.queued_at ? 1 : a.ticket.id < b.ticket.id ? -1 : 1));
  return out;
}

async function ingestTickets(run: RunCtx): Promise<number> {
  const { ctx, settings, ledger } = run;
  const tickets = await listTickets(ctx);
  if (!ledger.placementAllowed()) return 0;
  const batch = tickets.slice(0, settings.rating.max_placements_per_run);
  // One sparse-checkout add for the whole batch's rows/ and cards/ shards instead of one per ticket.
  const shards = batch.map((t) => t.ticket.id.slice(0, 2));
  await run.state.rowsShards.prefetch(shards);
  await run.state.cards.prefetch(shards);
  let ingested = 0;
  for (const { path, ticket } of batch) if (await ingestOne(run, ticket, path)) ingested++;
  return ingested;
}

/** Create the rating rows for one ticket; false when the ticket is stale or its rows already exist. */
async function ingestOne(run: RunCtx, ticket: ReturnType<typeof PlacementTicketZ.parse>, path: string): Promise<boolean> {
  const { settings, state } = run;
  const id = ticket.id;
  state.removed.add(path);
  if (state.cats.general.rows.has(id)) return false; // re-ingest after a dead run: rows already there
  const rowsShard = await state.rowsShards.get(id.slice(0, 2));
  const cardsShard = await state.cards.get(id.slice(0, 2));
  const row = rowsShard?.[id];
  const card = cardsShard?.[id];
  if (!row || !card || row.s !== 'analyzed') return false; // deleted or superseded meanwhile
  {
    const created = ticket.queued_at;
    const own = ownOf(ticket.owner_hash);
    const oldId = ticket.supersedes;
    const oldGeneral = oldId ? state.cats.general.rows.get(oldId) : undefined;
    // Only a live lineage is inherited: rows the person already superseded or deleted stay retired.
    const revision = !!oldId && !!oldGeneral && oldGeneral.own === own && oldGeneral.elig;
    for (const cat of CATEGORIES) {
      const score = row.sc[cat];
      const included = cat === 'general' || (score !== undefined && cat in row.c);
      const cs = state.cats[cat];
      const old = revision && oldId ? cs.rows.get(oldId) : undefined;
      const inheritable = old !== undefined && old.elig && old.r !== null && old.round >= 0;
      if (old) old.elig = false;
      if (!included) continue;
      const fresh = cat === 'general' ? newGeneralRow(id, ticket.owner_hash, score ?? 0, settings, created) : newDomainRow(id, ticket.owner_hash, score ?? 0, settings, created);
      if (old && inheritable) {
        // Revision (D-42, ranking-engine.md §5.7): inherit the rating, keep the lineage, re-place with the short rounds.
        fresh.r = old.r;
        fresh.rd = Math.max(old.rd, settings.rating.rd_revision_min);
        fresh.g = old.g;
        fresh.w = old.w;
        fresh.d = old.d;
        fresh.l = old.l;
        fresh.lin = old.lin;
        fresh.peak = old.peak;
        fresh.peak_at = old.peak_at;
        fresh.days = [...old.days];
        fresh.round = 0;
        await state.history.rename(cat, old.id, id);
        const doc = await state.history.get(cat, id, old.lin);
        doc.lin = old.lin;
        doc.placed = false;
        state.history.touch(cat, id);
      }
      cs.rows.set(id, fresh);
      invalidate(cs);
    }
  }
  return true;
}

// ---- waves ------------------------------------------------------------------------------------------

function generalPlacedIds(state: EngineState): string[] {
  const out: string[] = [];
  for (const row of state.cats.general.rows.values()) if (row.kind === 'user' && row.placed && row.elig) out.push(row.id);
  return out;
}

function pairingContext(run: RunCtx, cs: CatState, rng: Rng, priorityOf?: Map<string, number>): PairingContext {
  const today = run.ctx.clock.day();
  const ctx: PairingContext = {
    cat: cs.cat,
    rows: cs.rows,
    byRating: sortedRows(cs),
    anchors: cs.anchors?.anchors ?? [],
    playedToday: (id) => (run.playedThisWave.get(id) ?? 0) + (cs.rows.get(id)?.last?.startsWith(today) ? 1 : 0),
    pendingPairs: new Set(),
    rng,
  };
  if (priorityOf) ctx.priorityOf = priorityOf;
  return ctx;
}

const zeroRounds = new WeakMap<EngineState, Map<string, number>>();

async function planPlacementWave(run: RunCtx, wave: number): Promise<MatchRequest[]> {
  const { state, rng } = run;
  const cards = cardLookup(state);
  const plan: MatchRequest[] = [];
  run.playedThisWave = new Map();
  for (const cat of categoriesForWave(wave)) {
    const cs = state.cats[cat];
    const pctx = pairingContext(run, cs, rng.derive(`wave:${wave}:${cat}`));
    const subjects = [...cs.rows.values()].filter(isPlacementCandidate).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
    for (const subject of subjects) {
      const reqs = await planPlacementRound(state, pctx, subject, cards);
      if (reqs.length === 0) {
        noteZeroRound(run, cs, subject, 'no opponents');
        continue;
      }
      for (const r of reqs) {
        run.playedThisWave.set(r.a, (run.playedThisWave.get(r.a) ?? 0) + 1);
        run.playedThisWave.set(r.b, (run.playedThisWave.get(r.b) ?? 0) + 1);
      }
      plan.push(...reqs);
    }
  }
  return plan;
}

/** A round with zero successes is retried once next wave; a second zero marks the subject placed as is. */
function noteZeroRound(run: RunCtx, cs: CatState, subject: RatingRow, why: string): void {
  let map = zeroRounds.get(run.state);
  if (!map) zeroRounds.set(run.state, (map = new Map()));
  const key = `${cs.cat}:${subject.id}:${subject.round}`;
  const n = (map.get(key) ?? 0) + 1;
  map.set(key, n);
  if (n >= 2) {
    subject.placed = true;
    invalidate(cs);
    run.state.notes.push(`${cs.cat}/${subject.id}: placed after two empty rounds (${why}) at rd ${subject.rd}`);
    if (cs.cat === 'general') seedWaitingDomains(run.state, subject.id);
  }
}

async function planRefinementWave(run: RunCtx, wave: number): Promise<MatchRequest[]> {
  const { state, settings, ledger, ctx } = run;
  const allowance = ledger.allowance(ctx.clock.now());
  if (allowance < settings.rating.min_refine_batch) return [];
  const rng = run.rng.derive(`wave:${wave}:refine`);
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, [...state.cats[c].rows.values()].filter((r) => r.rank !== null).length])) as Record<Category, number>;
  const cands = refinementCandidates(state, ctx.clock.now(), rng.derive('priority'), totals);
  const sample = sampleRefinement(cands, allowance, rng.derive('sample'));
  const priorityOf = new Map(cands.map((c) => [c.row.id, c.priority]));
  const cards = cardLookup(state);
  const busy = new Set<string>();
  const plan: MatchRequest[] = [];
  const ctxs = new Map<Category, PairingContext>();
  run.playedThisWave = new Map();
  for (const c of sample) {
    if (busy.has(c.row.id)) continue;
    let pctx = ctxs.get(c.cat);
    if (!pctx) ctxs.set(c.cat, (pctx = pairingContext(run, state.cats[c.cat], rng.derive(`pair:${c.cat}`), priorityOf)));
    const req = await planRefinement(state, pctx, c.row, cards, busy, ctx.clock.now());
    if (!req) continue;
    busy.add(req.a);
    busy.add(req.b);
    run.playedThisWave.set(req.a, 1);
    run.playedThisWave.set(req.b, 1);
    plan.push(req);
  }
  return plan;
}

/**
 * Judge a wave, WAL-commit the decided lines, then apply them in memory. Returns false when the run must
 * stop. A tripped breaker still commits and applies the verdicts that were paid for before it tripped,
 * then propagates the fatal (§9.4: "finalize what exists").
 */
async function judgeAndApply(run: RunCtx, plan: MatchRequest[], wave: number, phase: 'placement' | 'refine'): Promise<boolean> {
  const { ctx, state, ledger, report } = run;
  let results: MatchResult[];
  let fatal: JudgeFatal | null = null;
  try {
    results = await run.judge.judgeMany(plan);
  } catch (e) {
    if (!(e instanceof JudgeFatal) || e.partial.length === 0) throw e;
    fatal = e;
    results = e.partial;
  }
  const at = ctx.clock.iso();
  const lines: MatchLine[] = [];
  const bySubjectPeriod = new Map<string, { ok: number; subject: RatingRow | undefined; cs: CatState }>();
  results.forEach((res, i) => {
    const req = plan[i] as MatchRequest;
    if (!run.usageViaCallback) {
      for (const ev of res.usage) ledger.record(usageLine({ at, run: ctx.runId, wf: 'rerank', purpose: req.kind === 'placement' || req.kind === 'revision' ? 'judge_place' : 'judge_refine', model: ev.model, tok: ev.tok, usd: ev.usd, ref: pairRef(req) }));
    }
    if (req.kind === 'placement' || req.kind === 'revision') {
      const key = `${req.cat}:${req.period}`;
      const entry = bySubjectPeriod.get(key) ?? { ok: 0, subject: state.cats[req.cat].rows.get(req.subj), cs: state.cats[req.cat] };
      if (res.ok) entry.ok++;
      bySubjectPeriod.set(key, entry);
    }
    if (res.ok) lines.push(buildMatchLine(req, res, { run: ctx.runId, wave, seq: i, at, pv: ctx.prompts.judge.version }));
    else if (res.reason !== 'stopped') ctx.log.warn(`match ${req.cat} ${req.a}|${req.b} failed: ${res.reason} ${res.detail}`);
  });
  for (const [, entry] of bySubjectPeriod) if (entry.ok === 0 && entry.subject) noteZeroRound(run, entry.cs, entry.subject, 'all games failed');
  if (lines.length === 0) {
    if (fatal) throw fatal;
    return report.state === 'ok';
  }

  // WAL commit: only matches/** is touched; a rejected push ends the run before anything is applied.
  const byFile = new Map<string, MatchLine[]>();
  for (const cat of CATEGORIES) {
    const catLines = lines.filter((l) => l.cat === cat);
    if (!catLines.length) continue;
    byFile.set(await currentWalFile(ctx.store, cat, ctx.clock.month()), catLines);
  }
  const mutations: Mutation[] = [...byFile.entries()].map(([file, ls]) => appendLines(file, ls));
  await ctx.commit(`[wal] run ${ctx.runId} wave ${wave}: ${lines.length} matches`, mutations);
  for (const [file, ls] of byFile) {
    const cs = state.cats[ls[0]!.cat];
    cs.cursor[file] = (cs.cursor[file] ?? 0) + ls.length;
  }

  const preRows = new Map<string, number>();
  for (const l of lines) {
    for (const id of [l.a, l.b]) {
      const r = state.cats[l.cat].rows.get(id)?.r;
      if (r !== undefined && r !== null) preRows.set(`${l.cat}:${id}`, r);
    }
  }
  const placedBefore = countPlaced(state);
  await applyLines(state, lines);
  report.placed += countPlaced(state) - placedBefore;
  report.matches += lines.length;
  if (phase === 'placement') report.placementMatches += lines.length;
  else report.refineMatches += lines.length;
  report.changed = true;
  if (phase === 'refine') await collectArenaPairs(run, lines);
  if (fatal) throw fatal;
  return report.state === 'ok';
}

function countPlaced(state: EngineState): number {
  let n = 0;
  for (const cat of CATEGORIES) for (const row of state.cats[cat].rows.values()) if (row.kind === 'user' && row.placed) n++;
  return n;
}

async function collectArenaPairs(run: RunCtx, lines: MatchLine[]): Promise<void> {
  const { state, ctx } = run;
  const cards = cardLookup(state);
  const fresh = new Map<Category, ArenaPair[]>();
  for (const l of lines) {
    if (!isArenaKind(l.kind)) continue;
    const cs = state.cats[l.cat];
    const a = cs.rows.get(l.a);
    const b = cs.rows.get(l.b);
    if (!a || !b || a.kind !== 'user' || b.kind !== 'user' || a.r === null || b.r === null) continue;
    const ca = await cards(l.cat, l.a);
    const cb = await cards(l.cat, l.b);
    if (!ca || !cb) continue;
    const pair = arenaPairFrom(l, { id: l.a, card: ca.card, stage: ca.stage, r_before: l.pre.ar, r_after: a.r }, { id: l.b, card: cb.card, stage: cb.stage, r_before: l.pre.br, r_after: b.r });
    const list = fresh.get(l.cat) ?? [];
    list.push(pair);
    fresh.set(l.cat, list);
  }
  for (const [cat, pairs] of fresh) {
    const cs = state.cats[cat];
    state.arena[cat] = updateArena(state.arena[cat], pairs.reverse(), (id) => cs.rows.get(id)?.elig === true && cs.rows.get(id)?.kind === 'user', run.settings.retention.arena_pool_size, ctx.clock.iso());
  }
}

// ---- ranks and finalize -----------------------------------------------------------------------------

export function computeRanks(state: EngineState): void {
  for (const cat of CATEGORIES) {
    const cs = state.cats[cat];
    const ranks = rankAndPercentile(cs.rows.values());
    for (const row of cs.rows.values()) {
      const info = ranks.get(row.id);
      row.rank = info ? info.rank : null;
      row.top = info ? info.top : null;
    }
  }
}

async function assembleStatus(run: RunCtx, prev: Status, extra: { judgeHealthy: boolean; lastRerank: Status['last_rerank']; deploy: ReturnType<typeof deployDecision> }): Promise<Status> {
  const { ctx, state, settings, ledger } = run;
  const now = ctx.clock.now();
  const tickets = await listTickets(ctx);
  const remainingTickets = tickets.filter((t) => !state.removed.has(t.path));
  await ctx.store.materialize([`/${ANALYSIS_QUEUE_DIR}`, `/${DELETE_QUEUE_DIR}`]);
  const analysisQueue = (await ctx.store.list(ANALYSIS_QUEUE_DIR)).filter((n) => n.endsWith('.json') && !state.removed.has(`${ANALYSIS_QUEUE_DIR}${n}`)).length;
  const deleteQueue = (await ctx.store.list(DELETE_QUEUE_DIR)).filter((n) => n.endsWith('.json') && !state.removed.has(`${DELETE_QUEUE_DIR}${n}`)).length;
  const health: Partial<Status['health']> = { judge_healthy: extra.judgeHealthy };
  if (ctx.github.enabled) {
    const [schedule, failed, cancelled, lastHour, paths] = await Promise.all([isWorkflowEnabled(ctx.github, 'rerank.yml'), runsLast24h(ctx.github, now, 'failure'), runsLast24h(ctx.github, now, 'cancelled'), submissionsLastHour(ctx.github, now), submitPathCounts(ctx.github, now)]);
    if (schedule !== null) health.schedule_enabled = schedule;
    if (failed !== null) health.failed_runs_24h = failed;
    if (cancelled !== null) health.cancelled_runs_24h = cancelled;
    if (lastHour !== null) health.submissions_last_hour = lastHour;
    if (paths) {
      health.issue_path_24h = paths.issue;
      health.dispatch_path_24h = paths.dispatch;
    }
  }
  health.token_expires = readTokenExpiry(ctx) ?? prev.health.token_expires;
  return buildStatus({
    prev,
    settings,
    now: ctx.clock.iso(),
    ledger,
    cats: state.cats,
    queue: { placement: remainingTickets.length, analysis: analysisQueue, delete: deleteQueue, oldest_queued_at: remainingTickets[0]?.ticket.queued_at ?? null },
    prompts: ctx.prompts,
    lastRerank: extra.lastRerank,
    health,
    lastDeployRequestedAt: extra.deploy.last_deploy_requested_at,
    deployPending: extra.deploy.deploy_pending,
  });
}

export function readTokenExpiry(ctx: Context): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(ctx.env.repoRoot, 'ops', 'token.json'), 'utf8')) as { expires?: string };
    return typeof raw.expires === 'string' ? raw.expires : null;
  } catch {
    return null;
  }
}

/** The apply commit (§9.4 step 10). Exported for maintenance, which finalizes the same way. */
export async function finalizeMutations(ctx: Context, state: EngineState, ledger: Ledger, status: Status, changed: boolean): Promise<Mutation[]> {
  const now = ctx.clock.iso();
  const mutations: Mutation[] = [];
  if (changed) {
    for (const cat of CATEGORIES) mutations.push(writeJson(ratingsPath(cat), serializeRatings(state.cats[cat], now, ctx.runId)));
    for (const { path, doc } of state.history.dirty()) mutations.push(writeJson(path, doc));
    for (const path of state.history.removed()) mutations.push(removeFile(path));
    for (const cat of CATEGORIES) {
      const cs = state.cats[cat];
      const pool = updateArena(state.arena[cat], [], (id) => cs.rows.get(id)?.elig === true && cs.rows.get(id)?.kind === 'user', state.settings.retention.arena_pool_size, state.arena[cat].updated_at);
      mutations.push(writeJson(arenaPath(cat), pool));
    }
  }
  for (const path of [...state.removed].sort()) mutations.push(removeFile(path));
  if (ledger.pending.length) mutations.push(appendLines(usagePath(ledger.day), ledger.pending));
  mutations.push(decide([`/${STATUS_PATH}`], (store) => store.writeJson(STATUS_PATH, status)));
  return mutations;
}

async function finalize(run: RunCtx, status: Status, changed: boolean): Promise<void> {
  const { ctx, state, ledger, report } = run;
  const mutations = await finalizeMutations(ctx, state, ledger, status, changed);
  await ctx.commit(`rerank run ${ctx.runId}: ${report.matches} matches, ${report.placed} placed`, mutations);
  state.history.clear();
  state.removed.clear();
  ledger.pending.length = 0;
}

