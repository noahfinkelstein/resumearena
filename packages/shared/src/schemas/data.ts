// Zod mirrors of the §4 on-disk documents (§5.4). The engine validates every read with these; tests
// validate every fixture. No repairs here: a malformed document is an error, not something to patch.
import { z } from 'zod';
import { CardZ } from './analysis.ts';
import { GateVerdictZ } from './gate.ts';
import { ResumeAnalysisZ } from './analysis.ts';
import { CLIENT_VERSION_RE } from '../constants.ts';
import { HANDLE_RE } from '../handles.ts';
import type {
  AnchorsFile, ArenaPool, HistoryDoc, LayoutMetrics, MatchLine, PlacementTicket, RatingRow, RatingsFile, RowEntry, RowsShard, Settings, Status,
  SubmissionPayload, UserDoc,
} from '../types.ts';

export const CategoryZ = z.enum(['general', 'finance', 'tech', 'academia']);
export const StageZ = z.enum(['student', 'new_grad', 'early', 'mid', 'senior', 'executive']);
export const VisibilityZ = z.enum(['handle', 'anonymous']);
export const SubmitActionZ = z.enum(['submit', 'delete', 'set_visibility']);
export const SourceKindZ = z.enum(['pdf', 'docx', 'paste']);
export const ResumeStatusZ = z.enum(['queued', 'analyzed', 'held', 'needs_review', 'rejected', 'duplicate', 'superseded', 'deleted']);
export const RejectCodeZ = z.enum(['bad_payload', 'too_short', 'too_long', 'text_not_scrubbed', 'handle_taken', 'resubmit_too_soon', 'not_a_resume', 'spam', 'unsupported_language', 'gate_refused']);
export const MatchKindZ = z.enum(['placement', 'revision', 'refine', 'crosscheck', 'anchor']);
export const SpendPurposeZ = z.enum(['gate', 'analysis', 'judge_place', 'judge_refine', 'judge_anchor', 'reanalysis', 'fixtures']);
export const OutcomeZ = z.union([z.literal(1), z.literal(0.5), z.literal(0)]);

const nonNegInt = z.number().int().nonnegative();
const nonNeg = z.number().nonnegative();
const IdZ = z.string().regex(/^[a-z2-7]{10}$/);
const HexZ = z.string().regex(/^[0-9a-f]{64}$/);

// ---- client-side ingestion ------------------------------------------------------------------------
/** Unknown keys dropped, missing numbers 0, missing source paste (§7.1). */
export const LayoutMetricsZ = z.object({
  source: SourceKindZ.default('paste'),
  pages: nonNegInt.default(0),
  columns_detected: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0),
  font_count: nonNegInt.default(0),
  image_count: nonNegInt.default(0),
  char_count: nonNegInt.default(0),
  word_count: nonNegInt.default(0),
  extraction_quality: z.number().min(0).max(1).default(0),
  redactions: z
    .object({
      name: nonNegInt.default(0),
      email: nonNegInt.default(0),
      phone: nonNegInt.default(0),
      url: nonNegInt.default(0),
      address: nonNegInt.default(0),
      manual: nonNegInt.default(0),
    })
    .default({ name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 }),
});

// ---- write channel --------------------------------------------------------------------------------
export const SubmissionPayloadZ = z.object({
  action: z.string(),
  submission_id: z.string(),
  handle: z.string(),
  owner_hash: z.string(),
  visibility: z.string(),
  text: z.string(),
  metrics_json: z.string(),
  ladder_hint: z.string(),
  client_version: z.string(),
  owner_key: z.string(),
});

// Shapes that reach the public data branch carry only validated identifiers: a handle that passed the
// format check and a client_version that matches the wire regex, so unvalidated input can never be written.
export const HandleZ = z.string().regex(HANDLE_RE);
export const ClientVersionZ = z.string().regex(CLIENT_VERSION_RE);

export const SubmissionSourceZ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dispatch'), run_id: z.number(), issue_number: z.null(), client_version: ClientVersionZ }),
  z.object({ kind: z.literal('issue'), run_id: z.number(), issue_number: z.number(), client_version: ClientVersionZ, author: z.string(), node_id: z.string() }),
]);

// ---- submit-owned documents -----------------------------------------------------------------------
export const ResumeDocZ = z.object({
  schema: z.literal(1),
  id: IdZ,
  kind: z.literal('user'),
  status: ResumeStatusZ,
  handle: HandleZ,
  visibility: VisibilityZ,
  owner_hash: HexZ,
  primary: CategoryZ,
  created_at: z.string(),
  updated_at: z.string(),
  source: SubmissionSourceZ,
  text: z.string().optional(),
  text_sha256: HexZ,
  metrics: LayoutMetricsZ.optional(),
  gate: z.object({ model: z.string(), prompt: z.string(), verdict: GateVerdictZ }).optional(),
  analysis: ResumeAnalysisZ.optional(),
  card_sha256: HexZ.optional(),
  category_relevance: z.object({ general: z.number(), finance: z.number(), tech: z.number(), academia: z.number() }).optional(),
  scores: z.partialRecord(CategoryZ, z.number()).optional(),
  stage: StageZ.optional(),
  top_signal: z.string().optional(),
  held_reason: z.enum(['pii', 'injection']).nullable().optional(),
  rejected_reason: RejectCodeZ.nullable().optional(),
  review_reason: z.enum(['refusal', 'not_a_resume', 'low_confidence', 'invalid_output']).nullable().optional(),
  queue_reason: z.enum(['budget', 'paused']).nullable().optional(),
  duplicate_of: z.string().nullable().optional(),
  duplicate_kind: z.enum(['text', 'card']).nullable().optional(),
  supersedes: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
  superseded_at: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
  versions: z.object({ analyst_model: z.string(), analyst_prompt: z.string(), gate_prompt: z.string(), schema: z.string(), taxonomy: z.string(), fell_back: z.boolean() }).optional(),
  usage: z.object({ gate_usd: nonNeg, analysis_usd: nonNeg, latency_ms: nonNeg }).optional(),
});

export const UserDocZ = z.object({
  schema: z.literal(1),
  handle: HandleZ,
  owner_hash: HexZ,
  created_at: z.string(),
  state: z.enum(['active', 'tombstone']),
  key_exposed: z.boolean(),
  resumes: z.array(z.object({ id: IdZ, created_at: z.string(), current: z.boolean() })),
});

const SixZ = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
// `partialRecord` types absent keys as absent (Partial<Record<…>>), which is what RowEntry declares under
// exactOptionalPropertyTypes; an object of `.optional()` fields would type them as `number | undefined`.
const PerCategoryNumber = z.partialRecord(CategoryZ, z.number());

export const RowEntryZ = z.object({
  h: z.string(),
  v: VisibilityZ,
  p: CategoryZ,
  st: StageZ,
  sig: z.string(),
  s: ResumeStatusZ,
  c: PerCategoryNumber,
  sc: PerCategoryNumber,
  ss: z.partialRecord(CategoryZ, SixZ),
  ch: z.string(),
  t: nonNegInt,
});
export const RowsShardZ = z.record(z.string(), RowEntryZ);
export const CardsShardZ = z.record(z.string(), z.object({ card: CardZ, st: StageZ }));
export const DedupeEntryZ = z.object({ id: IdZ, owner_hash: HexZ, t: z.string() });
export const PlacementTicketZ = z.object({ schema: z.literal(1), id: IdZ, handle: z.string(), owner_hash: HexZ, primary: CategoryZ, supersedes: z.string().nullable(), queued_at: z.string() });
export const AnalysisQueueEntryZ = z.object({ schema: z.literal(1), id: IdZ, reason: z.enum(['budget', 'paused']), enqueued_at: z.string(), source: SubmissionSourceZ, payload: SubmissionPayloadZ });
export const DeleteRequestZ = z.object({ schema: z.literal(1), id: IdZ, requested_at: z.string(), handle: z.string() });
export const UsageLineZ = z.object({
  t: z.string(),
  run: z.string(),
  wf: z.enum(['submit', 'rerank', 'maintenance', 'fixtures']),
  purpose: SpendPurposeZ,
  model: z.string(),
  in: nonNegInt,
  cr: nonNegInt,
  cw: nonNegInt,
  out: nonNegInt,
  usd: nonNeg,
  ref: z.string(),
});
export const FailureLineZ = z.object({ t: z.string(), wf: z.string(), run: z.string(), step: z.string(), code: z.string(), ref: z.string().optional() });

// ---- engine-owned ---------------------------------------------------------------------------------
export const RatingRowZ = z.object({
  id: z.string(),
  own: z.string(),
  lin: z.string(),
  r: z.number().nullable(),
  rd: z.number(),
  vol: z.number(),
  seed: z.number(),
  score: z.number(),
  g: nonNegInt,
  w: nonNegInt,
  d: nonNegInt,
  l: nonNegInt,
  round: z.number().int(),
  placed: z.boolean(),
  kind: z.enum(['user', 'anchor']),
  locked: z.boolean(),
  elig: z.boolean(),
  rank: z.number().int().nullable(),
  top: z.number().nullable(),
  peak: z.number(),
  peak_at: z.string(),
  last: z.string().nullable(),
  days: z.array(z.tuple([z.string(), z.number(), z.number().nullable()])),
  opp: z.array(z.string()),
  mv: z.number(),
  created: z.string(),
});

export const RatingsFileZ = z.object({
  schema: z.literal(1),
  category: CategoryZ,
  updated_at: z.string(),
  run_id: z.string(),
  cursor: z.record(z.string(), nonNegInt),
  shift: z.number(),
  rows: z.record(z.string(), RatingRowZ),
});

export const VerdictZ = z.object({ winner: z.enum(['first', 'second']), confidence: z.number(), factors: z.array(z.string()), reasoning: z.string(), model: z.string().optional() });

export const MatchLineZ = z.object({
  v: z.literal(1),
  id: z.string(),
  run: z.string(),
  wave: nonNegInt,
  seq: nonNegInt,
  at: z.string(),
  cat: CategoryZ,
  kind: MatchKindZ,
  period: z.string(),
  subj: z.string(),
  a: z.string(),
  b: z.string(),
  pre: z.object({ ar: z.number(), ard: z.number(), br: z.number(), brd: z.number() }),
  p1: VerdictZ,
  p2: VerdictZ,
  o: OutcomeZ,
  agree: z.boolean(),
  model: z.string(),
  pv: z.string(),
  tok: z.object({ in: nonNegInt, cr: nonNegInt, cw: nonNegInt, out: nonNegInt }),
  usd: nonNeg,
});

export const HistoryPointZ = z.tuple([z.string(), z.number(), z.number(), z.enum(['p', 'm', 'v', 'd', 's'])]);
export const RecentMatchZ = z.object({ m: z.string(), at: z.string(), o: z.enum(['W', 'D', 'L']), opp: z.string(), opp_r: z.number(), dr: z.number(), note: z.string(), k: MatchKindZ });
export const HistoryDocZ = z.object({ id: z.string(), cat: CategoryZ, lin: z.string(), placed: z.boolean(), points: z.array(HistoryPointZ), recent: z.array(RecentMatchZ) });

export const ArenaSideZ = z.object({ id: z.string(), card: CardZ, stage: StageZ, r_before: z.number(), delta: z.number() });
export const ArenaPairZ = z.object({ m: z.string(), at: z.string(), kind: MatchKindZ, a: ArenaSideZ, b: ArenaSideZ, w: z.enum(['A', 'B', 'draw']), c: z.number(), reason: z.string() });
export const ArenaPoolZ = z.object({ schema: z.literal(1), category: CategoryZ, updated_at: z.string(), pairs: z.array(ArenaPairZ) });

export const AnchorZ = z.object({ id: z.string().regex(/^anchr[gfta][b-m]aaa$/), rating: z.number(), stage: StageZ, spec: z.string(), card: CardZ });
export const AnchorsFileZ = z.object({ schema: z.literal(1), category: CategoryZ, prompt_version: z.string(), validated_at: z.string().nullable(), anchors: z.array(AnchorZ) });

// ---- settings and status --------------------------------------------------------------------------
export const ModelPricesZ = z.object({ input: nonNeg, cache_read: nonNeg, cache_write_5m: nonNeg, cache_write_1h: nonNeg, output: nonNeg });

export const RatingSettingsZ = z.object({
  rd_initial: z.number().positive(),
  rd_initial_with_prior: z.number().positive(),
  rd_initial_domain: z.number().positive(),
  rd_floor: z.number().positive(),
  rd_ceiling: z.number().positive(),
  rd_inflation_c: nonNeg,
  rd_revision_min: z.number().positive(),
  placement_rounds_general: z.array(z.number().int().positive()),
  placement_rounds_domain: z.array(z.number().int().positive()),
  revision_rounds_general: z.array(z.number().int().positive()),
  revision_rounds_domain: z.array(z.number().int().positive()),
  category_relevance_min: z.number().min(0).max(1),
  opponent_mix: z.object({ local: nonNeg, crosscheck: nonNeg, anchor: nonNeg }),
  drift_mode: z.enum(['anchors', 'mean1500']),
  drift_max_shift: nonNeg,
  drift_alert_residual: nonNeg,
  drift_min_games: nonNegInt,
  max_placements_per_run: nonNegInt,
  max_refine_matches_per_run: nonNegInt,
  min_refine_batch: nonNegInt,
  max_deferred_analyses_per_run: nonNegInt,
  refine_cooldown_hours: nonNeg,
  judge_concurrency: z.number().int().positive(),
  soft_wall_clock_minutes: z.number().positive(),
  priority_weights: z.object({ U: z.number(), S: z.number(), T: z.number(), A: z.number(), V: z.number(), J: z.number() }),
  est_cost_per_match_usd: z.number().positive(),
});

export const SettingsZ = z.object({
  schema: z.literal(1),
  paused: z.boolean(),
  pause_message: z.string(),
  daily_budget_usd: nonNeg,
  refine_budget_share: z.number().min(0).max(1),
  hard_stop_multiplier: z.number().min(1),
  est_submission_cost_usd: nonNeg,
  max_submissions_per_hour: nonNegInt,
  max_text_chars: z.number().int().positive(),
  min_text_chars: nonNegInt,
  models: z.object({ gate: z.string(), analyst: z.string(), judge: z.string(), analyst_effort: z.enum(['medium', 'high']), judge_effort: z.enum(['low', 'medium']) }),
  prompts: z.object({ gate: z.string(), analyst: z.string(), judge: z.string(), schema: z.string(), taxonomy: z.string() }),
  prices_usd_per_mtok: z.record(z.string(), ModelPricesZ),
  rating: RatingSettingsZ,
  retention: z.object({ arena_pool_size: nonNegInt, history_points: nonNegInt, history_recent: nonNegInt, min_deploy_interval_minutes: nonNeg }),
});

export const CategoryStatsZ = z.object({
  rated: nonNegInt,
  mean: z.number(),
  sd: z.number(),
  anchor_residual_7d: z.number().nullable(),
  anchor_n_7d: nonNegInt,
  anchor_accuracy_7d: z.number().nullable(),
  disagreement_rate_7d: z.number().nullable(),
});

const CountsZ = z.object({
  resumes: nonNegInt, analyzed: nonNegInt, rated: nonNegInt, placing: nonNegInt, queued: nonNegInt, held: nonNegInt, needs_review: nonNegInt,
  rejected: nonNegInt, duplicate: nonNegInt, superseded: nonNegInt, deleted: nonNegInt, users: nonNegInt, matches: nonNegInt, anchors: nonNegInt,
});

export const StatusZ = z.object({
  schema: z.literal(1),
  updated_at: z.string(),
  paused: z.boolean(),
  budget: z.object({ day: z.string(), daily_usd: nonNeg, spent_usd: nonNeg, analysis_usd: nonNeg, refine_spent_usd: nonNeg, exhausted: z.boolean(), hard_stopped: z.boolean() }),
  queue: z.object({ placement: nonNegInt, analysis: nonNegInt, delete: nonNegInt, oldest_queued_at: z.string().nullable() }),
  last_rerank: z
    .object({
      run_id: z.number(), at: z.string(), trigger: z.string(), waves: nonNegInt, matches: nonNegInt, placements_completed: nonNegInt, duration_s: nonNeg, changed: z.boolean(),
      state: z.enum(['ok', 'failed', 'aborted_budget', 'aborted_judge']),
    })
    .nullable(),
  last_submission_at: z.string().nullable(),
  last_deploy_requested_at: z.string().nullable(),
  deploy_pending: z.boolean(),
  counts: CountsZ,
  per_category: z.object({ general: CategoryStatsZ, finance: CategoryStatsZ, tech: CategoryStatsZ, academia: CategoryStatsZ }),
  health: z.object({
    judge_healthy: z.boolean(), schedule_enabled: z.boolean(), token_expires: z.string().nullable(), submissions_last_hour: nonNegInt, failed_runs_24h: nonNegInt,
    cancelled_runs_24h: nonNegInt, issue_path_24h: nonNegInt, dispatch_path_24h: nonNegInt, alerts: z.array(z.string()),
  }),
  versions: z.object({ engine: z.string(), gate_prompt: z.string(), analyst_prompt: z.string(), judge_prompt: z.string(), schema: z.string(), taxonomy: z.string() }),
});

// ---- compile-time agreement with types.ts ----------------------------------------------------------
// Documents with optional fields (ResumeDoc, Verdict.model) are left out: Zod types `.optional()` fields as `T | undefined`,
// which exactOptionalPropertyTypes refuses to equate with `prop?: T`.
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;
export type _SchemaChecks = [
  Assert<Extends<z.output<typeof LayoutMetricsZ>, LayoutMetrics>>,
  Assert<Extends<z.output<typeof SubmissionPayloadZ>, Omit<SubmissionPayload, 'action' | 'visibility' | 'ladder_hint'>>>,
  Assert<Extends<z.output<typeof UserDocZ>, UserDoc>>,
  Assert<Extends<z.output<typeof RowEntryZ>, RowEntry>>,
  Assert<Extends<z.output<typeof RowsShardZ>, RowsShard>>,
  Assert<Extends<z.output<typeof PlacementTicketZ>, PlacementTicket>>,
  Assert<Extends<z.output<typeof RatingRowZ>, RatingRow>>,
  Assert<Extends<z.output<typeof RatingsFileZ>, RatingsFile>>,
  Assert<Extends<z.output<typeof MatchLineZ>, Omit<MatchLine, 'p1' | 'p2'>>>,
  Assert<Extends<z.output<typeof HistoryDocZ>, HistoryDoc>>,
  Assert<Extends<z.output<typeof ArenaPoolZ>, ArenaPool>>,
  Assert<Extends<z.output<typeof AnchorsFileZ>, AnchorsFile>>,
  Assert<Extends<z.output<typeof SettingsZ>, Settings>>,
  Assert<Extends<z.output<typeof StatusZ>, Status>>,
];
