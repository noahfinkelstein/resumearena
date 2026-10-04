// One submission from normalized input to a committed outcome (§9.3 steps 1–11). Shared by the submit
// command and the analysis-queue drain in rerank/maintenance, so a deferred payload takes the same path.
import {
  ENGINE_VERSION,
  type GateVerdict, type RejectCode, type ResumeDoc, type Settings, type SubmissionInput, type SubmissionPayload, type TokenCounts, type UsageLine,
} from '@resumearena/shared';
import type { Context } from '../context.ts';
import { runGate } from '../llm/gate.ts';
import { runAnalysis } from '../llm/analyst.ts';
import { LlmConfigError } from '../llm/client.ts';
import type { UsageEvent } from '../llm/calls.ts';
import { decide } from '../store/commit.ts';
import { analysisQueuePath } from '../store/paths.ts';
import { openLedger, usageLine, type Ledger } from '../rank/budget.ts';
import { postValidate, type PostValidated } from './analysis.ts';
import { analysisQueueEntry, analyzedDoc, duplicateStub, needsReviewStub, queuedStub, rejectedStub, type GateRecord } from './docs.ts';
import { isOwnQueuedStub, precheckManage, precheckSubmit, readResumeDoc, type Precheck, type PrecheckOptions } from './precheck.ts';
import { appendUsage, submitPaths, writeAnalyzed, writeDelete, writeStub, writeVisibility } from './writes.ts';

export type SubmitOutcome = 'analyzed' | 'held' | 'needs_review' | 'rejected' | 'duplicate' | 'queued' | 'noop' | 'key_mismatch' | 'deleted' | 'visibility_set';

export interface SubmitReport {
  outcome: SubmitOutcome;
  id: string;
  handle: string;
  anonymous: boolean;
  source: SubmissionInput['source']['kind'];
  /** Reject code, held reason, review reason, duplicate kind or queue reason. */
  code: string | null;
  gate: GateVerdict | null;
  tok: TokenCounts;
  usd: number;
  latency_ms: number;
  commit: 'pushed' | 'noop' | 'none';
  cardScrubbed: number;
  supersedes: string | null;
}

export class IdCollisionError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`id_collision: resumes/${id} exists with another owner`);
    this.name = 'IdCollisionError';
    this.id = id;
  }
}

export interface PipelineDeps {
  ctx: Context;
  settings: Settings;
  wf: UsageLine['wf'];
  /** Set when draining queue/analysis: the entry is removed in the same commit and the pause check is skipped. */
  drainedFrom?: string;
  /** Reuse the caller's ledger so a drain sees its own spend. */
  ledger?: Ledger;
}

const zeroTok = (): TokenCounts => ({ in: 0, cr: 0, cw: 0, out: 0 });

function sumTok(events: readonly UsageEvent[]): TokenCounts {
  return events.reduce<TokenCounts>((a, e) => ({ in: a.in + e.tok.in, cr: a.cr + e.tok.cr, cw: a.cw + e.tok.cw, out: a.out + e.tok.out }), zeroTok());
}

export async function processSubmission(deps: PipelineDeps, input: SubmissionInput, payload: SubmissionPayload): Promise<SubmitReport> {
  const { ctx, settings } = deps;
  const started = Date.now();
  const now = ctx.clock.iso();
  const day = ctx.clock.day();
  const base = { id: input.id, handle: input.handle, anonymous: input.visibility === 'anonymous', source: input.source.kind, supersedes: null as string | null };
  const report = (outcome: SubmitOutcome, extra: Partial<SubmitReport> = {}): SubmitReport => ({
    outcome, ...base, code: null, gate: null, tok: zeroTok(), usd: 0, latency_ms: Date.now() - started, commit: 'none', cardScrubbed: 0, ...extra,
  });
  const paths = submitPaths(input, { day });
  await ctx.store.materialize(paths);
  // A drain completes the id's own queued stub; a fresh submit never overwrites a document that exists.
  const checkOpts: PrecheckOptions = deps.drainedFrom ? { resumeQueued: true } : {};
  const mayWriteOver = async (store: Parameters<typeof writeStub>[0]): Promise<boolean> => {
    const existing = await readResumeDoc(store, input.id);
    return existing === null || (deps.drainedFrom !== undefined && isOwnQueuedStub(existing, input));
  };

  // The caller's ledger (a drain) must see this submission's spend; lines are written by this run's own
  // commits, so they are observed (counted) rather than recorded (appended again by the caller's finalize).
  const ledger = deps.ledger ?? (await openLedger(ctx.store, settings, day));
  const usageLines: UsageLine[] = [];
  const bill = (purpose: 'gate' | 'analysis', events: readonly UsageEvent[]): void => {
    for (const e of events) usageLines.push(usageLine({ at: now, run: ctx.runId, wf: deps.wf, purpose, model: e.model, tok: e.tok, usd: e.usd, ref: input.id }));
  };
  const commitStub = async (doc: ResumeDoc, extraWrite?: (store: Parameters<typeof writeStub>[0]) => Promise<void>): Promise<'pushed' | 'noop'> => {
    let wrote = false;
    const c = await ctx.commit(`submit ${input.id}`, [
      decide(paths, async (store) => {
        wrote = false;
        if (!(await mayWriteOver(store))) return;
        await writeStub(store, doc);
        if (extraWrite) await extraWrite(store);
        // A re-queued drain rewrites the same queue entry; removing it here would drop the payload.
        if (deps.drainedFrom && doc.status !== 'queued') await store.remove(deps.drainedFrom);
        await appendUsage(store, day, usageLines);
        wrote = true;
      }),
    ]);
    if (wrote) for (const line of usageLines) ledger.observe(line);
    return c;
  };

  // 1. Paused: queue and stop (manage actions do not come here).
  if (settings.paused && !deps.drainedFrom) {
    const c = await commitStub(queuedStub(input, now, 'paused'), (s) => s.writeJson(analysisQueuePath(input.id), analysisQueueEntry(input, payload, 'paused', now)));
    return report('queued', { code: 'paused', commit: c });
  }

  // 4–6. Idempotency, ownership, text dedupe.
  const pre = await precheckSubmit(ctx.store, input, checkOpts);
  const early = await actOnPrecheck(pre, null);
  if (early) return early;
  base.supersedes = pre.kind === 'proceed' ? pre.supersedes : null;

  // 7. Budget.
  if (ledger.spentToday() + settings.est_submission_cost_usd > settings.daily_budget_usd) {
    const c = await commitStub(queuedStub(input, now, 'budget'), (s) => s.writeJson(analysisQueuePath(input.id), analysisQueueEntry(input, payload, 'budget', now)));
    return report('queued', { code: 'budget', commit: c });
  }

  // 8. Gate.
  const gateRes = await runGate({ transport: ctx.transport, settings, prompts: ctx.prompts, prices: settings.prices_usd_per_mtok, log: ctx.log }, { text: input.text, metrics: input.metrics });
  bill('gate', gateRes.usage);
  if (!gateRes.ok) {
    const c = await commitStub(rejectedStub(input, now, 'gate_refused'));
    return report('rejected', { code: 'gate_refused', tok: sumTok(gateRes.usage), usd: gateRes.usd, commit: c });
  }
  const verdict = gateRes.value;
  const gate: GateRecord = { model: gateRes.model, prompt: ctx.prompts.gate.version, verdict };
  const gateReject: RejectCode | null = !verdict.is_resume ? 'not_a_resume' : verdict.spam_or_abuse ? 'spam' : verdict.language !== 'en' ? 'unsupported_language' : null;
  if (gateReject) {
    const c = await commitStub(rejectedStub(input, now, gateReject, gate));
    return report('rejected', { code: gateReject, gate: verdict, tok: sumTok(gateRes.usage), usd: gateRes.usd, commit: c });
  }

  // 9. Analysis and post-validation.
  const anaRes = await runAnalysis({ transport: ctx.transport, settings, prompts: ctx.prompts, prices: settings.prices_usd_per_mtok, log: ctx.log }, { text: input.text, metrics: input.metrics });
  bill('analysis', anaRes.usage);
  const allEvents = [...gateRes.usage, ...anaRes.usage];
  const tok = sumTok(allEvents);
  const usd = Math.round((gateRes.usd + anaRes.usd) * 1e6) / 1e6;
  if (!anaRes.ok) {
    const reason = anaRes.reason === 'refusal' ? 'refusal' : 'invalid_output';
    const c = await commitStub(needsReviewStub(input, now, reason, gate));
    return report('needs_review', { code: reason, gate: verdict, tok, usd, commit: c });
  }
  const post: PostValidated = postValidate(anaRes.value, verdict, settings.rating.category_relevance_min);
  if (post.cardScrubbed) ctx.log.warn(`card_scrubbed: ${post.cardScrubbed} field(s) replaced for ${input.id}`);
  const versions: ResumeDoc['versions'] = { analyst_model: anaRes.model, analyst_prompt: ctx.prompts.analyst.version, gate_prompt: ctx.prompts.gate.version, schema: settings.prompts.schema, taxonomy: settings.prompts.taxonomy, fell_back: anaRes.fell_back };
  const docUsage: ResumeDoc['usage'] = { gate_usd: gateRes.usd, analysis_usd: anaRes.usd, latency_ms: gateRes.latency_ms + anaRes.latency_ms };

  if (post.status === 'needs_review') {
    const c = await commitStub(needsReviewStub(input, now, post.reviewReason ?? 'low_confidence', gate));
    return report('needs_review', { code: post.reviewReason, gate: verdict, tok, usd, commit: c, cardScrubbed: post.cardScrubbed });
  }
  if (post.status === 'held') {
    const doc = analyzedDoc(input, now, { post, gate, versions, usage: docUsage, supersedes: null });
    const c = await commitStub(doc);
    return report('held', { code: post.heldReason, gate: verdict, tok, usd, commit: c, cardScrubbed: post.cardScrubbed });
  }

  // 10. Card dedupe, then 11. the decide mutation re-checks everything on the fresh tree.
  const cardPre = await precheckSubmit(ctx.store, input, { ...checkOpts, cardSha256: post.cardSha256 });
  const dupEarly = await actOnPrecheck(cardPre, gate, { tok, usd, gateVerdict: verdict });
  if (dupEarly) return dupEarly;

  let finalOutcome: SubmitOutcome = 'analyzed';
  let finalCode: string | null = null;
  const fullPaths = submitPaths(input, { day, cardSha256: post.cardSha256, supersedes: base.supersedes, oldDoc: pre.kind === 'proceed' ? pre.oldDoc : null });
  const c = await ctx.commit(`submit ${input.id}`, [
    decide(fullPaths, async (store) => {
      const fresh = await precheckSubmit(store, input, { ...checkOpts, cardSha256: post.cardSha256 });
      if (fresh.kind === 'noop') {
        finalOutcome = 'noop';
        return;
      }
      if (fresh.kind === 'collision') throw new IdCollisionError(input.id);
      if (fresh.kind === 'reject') {
        finalOutcome = 'rejected';
        finalCode = fresh.code;
        await writeStub(store, rejectedStub(input, now, fresh.code, gate));
      } else if (fresh.kind === 'duplicate') {
        finalOutcome = 'duplicate';
        finalCode = fresh.dupKind;
        await writeStub(store, duplicateStub(input, now, fresh.dupKind, fresh.of, gate));
      } else {
        finalOutcome = 'analyzed';
        base.supersedes = fresh.supersedes;
        const doc = analyzedDoc(input, now, { post, gate, versions, usage: docUsage, supersedes: fresh.supersedes });
        await writeAnalyzed(store, input, doc, post, fresh.user, fresh.supersedes, now);
      }
      if (deps.drainedFrom) await store.remove(deps.drainedFrom);
      await appendUsage(store, day, usageLines);
    }),
  ]);
  // The lines are on disk in this commit already: the caller's ledger counts them, never appends them again.
  for (const line of usageLines) ledger.observe(line);
  return report(finalOutcome, { code: finalCode, gate: verdict, tok, usd, commit: c, cardScrubbed: post.cardScrubbed, supersedes: base.supersedes });

  async function actOnPrecheck(p: Precheck, gateRecord: GateRecord | null, paid?: { tok: TokenCounts; usd: number; gateVerdict: GateVerdict }): Promise<SubmitReport | null> {
    const paidPart = paid ? { tok: paid.tok, usd: paid.usd, gate: paid.gateVerdict } : {};
    switch (p.kind) {
      case 'noop':
        return report('noop', { ...paidPart });
      case 'collision':
        throw new IdCollisionError(input.id);
      case 'reject': {
        const c2 = await commitStub(rejectedStub(input, now, p.code, gateRecord ?? undefined));
        return report('rejected', { code: p.code, commit: c2, ...paidPart });
      }
      case 'duplicate': {
        const c2 = await commitStub(duplicateStub(input, now, p.dupKind, p.of, gateRecord ?? undefined));
        return report('duplicate', { code: p.dupKind, commit: c2, ...paidPart });
      }
      case 'proceed':
        return null;
    }
  }
}

/** delete / set_visibility (§9.3 step 5 manage branch and step 11). */
export async function processManage(deps: PipelineDeps, input: SubmissionInput, opts: { exposeKey: boolean }): Promise<SubmitReport> {
  const { ctx } = deps;
  const started = Date.now();
  const now = ctx.clock.iso();
  const base: SubmitReport = {
    outcome: 'key_mismatch', id: input.id, handle: input.handle, anonymous: input.visibility === 'anonymous', source: input.source.kind, code: null, gate: null,
    tok: zeroTok(), usd: 0, latency_ms: 0, commit: 'none', cardScrubbed: 0, supersedes: null,
  };
  const paths = submitPaths(input, { day: ctx.clock.day() });
  await ctx.store.materialize(paths);
  const check = await precheckManage(ctx.store, input);
  if (check.kind !== 'ok') return { ...base, code: check.reason, latency_ms: Date.now() - started };
  let outcome: SubmitOutcome = 'key_mismatch';
  let code: string | null = null;
  const c = await ctx.commit(`${input.action} ${input.id}`, [
    decide(paths, async (store) => {
      const fresh = await precheckManage(store, input);
      if (fresh.kind !== 'ok') {
        outcome = 'key_mismatch';
        code = fresh.reason;
        return;
      }
      if (input.action === 'delete') {
        await writeDelete(store, fresh.doc, fresh.user, now, opts.exposeKey);
        outcome = 'deleted';
      } else {
        await writeVisibility(store, fresh.doc, input.visibility, now);
        outcome = 'visibility_set';
        code = input.visibility;
      }
    }),
  ]);
  return { ...base, outcome, code, commit: c, latency_ms: Date.now() - started };
}

export const isConfigFailure = (e: unknown): boolean => e instanceof LlmConfigError;
export const ENGINE = ENGINE_VERSION;
