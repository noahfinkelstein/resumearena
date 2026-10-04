// packages/shared/src/types.ts — the one set of shapes shared by web, engine and tests.
// On-disk keys are snake_case. Every id is 10 lowercase base32 chars. Timestamps are ISO-8601 UTC.
export type { ResumeAnalysis, Card, GateVerdict, PairwiseVerdict } from './schemas/index.ts';

// ---- enums ---------------------------------------------------------------------------------------
export type Category = 'general' | 'finance' | 'tech' | 'academia';
export const CATEGORIES = ['general', 'finance', 'tech', 'academia'] as const satisfies readonly Category[];
export type Domain = Exclude<Category, 'general'>;
export type CareerStage = 'student' | 'new_grad' | 'early' | 'mid' | 'senior' | 'executive';
export const STAGES = ['student', 'new_grad', 'early', 'mid', 'senior', 'executive'] as const satisfies readonly CareerStage[];
export type Visibility = 'handle' | 'anonymous';
export type SubmitAction = 'submit' | 'delete' | 'set_visibility';
export type Source = 'pdf' | 'docx' | 'paste';
export type TierKey = 'entrant' | 'contender' | 'challenger' | 'candidate' | 'expert' | 'master' | 'grandmaster' | 'laureate';
export type Outcome = 1 | 0.5 | 0;                         // for side a
export type MatchKind = 'placement' | 'revision' | 'refine' | 'crosscheck' | 'anchor';
export type ResumeStatus = 'queued' | 'analyzed' | 'held' | 'needs_review' | 'rejected' | 'duplicate' | 'superseded' | 'deleted';
export type HeldReason = 'pii' | 'injection';
export type RejectCode =
  | 'bad_payload' | 'too_short' | 'too_long' | 'text_not_scrubbed' | 'handle_taken' | 'resubmit_too_soon'
  | 'not_a_resume' | 'spam' | 'unsupported_language' | 'gate_refused';
export type ReviewReason = 'refusal' | 'not_a_resume' | 'low_confidence' | 'invalid_output';
export type QueueReason = 'budget' | 'paused';
export type RedactionKind = 'name' | 'email' | 'phone' | 'url' | 'address' | 'manual';
export type SpendPurpose = 'gate' | 'analysis' | 'judge_place' | 'judge_refine' | 'judge_anchor' | 'reanalysis' | 'fixtures';

// ---- client-side ingestion -----------------------------------------------------------------------
export interface LayoutMetrics {
  source: Source;
  pages: number;                 // pdf: page count; docx/paste: ceil(char_count / 3000)
  columns_detected: 0 | 1 | 2 | 3; // 0 = not measurable (docx/paste)
  font_count: number;            // 0 = not measurable
  image_count: number;           // 0 = not measurable
  char_count: number;            // of the submitted text, after scrub and edits
  word_count: number;
  extraction_quality: number;    // 0..1; paste 1.0; docx 0.95 (0.7 with mammoth warnings); 0 = unmeasurable/scanned
  redactions: Record<RedactionKind, number>;
}
export interface Redaction { kind: RedactionKind; original: string; token: string; index: number }
export interface ScrubResult { text: string; redactions: Redaction[]; counts: Record<RedactionKind, number> }

// ---- write channel -------------------------------------------------------------------------------
/** Exactly the ten workflow_dispatch inputs; the Issue Forms carry the same ids. All strings. */
export interface SubmissionPayload {
  action: SubmitAction;
  submission_id: string;
  handle: string;
  owner_hash: string;            // 64 lowercase hex
  visibility: Visibility | '';   // '' allowed for delete
  text: string;                  // '' for delete / set_visibility
  metrics_json: string;          // JSON LayoutMetrics; '{}' when absent
  ladder_hint: Category | '';    // '' = general
  client_version: string;        // ^[a-z0-9.-]{0,24}$
  owner_key: string;             // canonical or rak- form; '' when not needed
}
export type SubmissionSource =
  | { kind: 'dispatch'; run_id: number; issue_number: null; client_version: string }
  | { kind: 'issue'; run_id: number; issue_number: number; client_version: string; author: string; node_id: string };
export interface SubmissionInput {
  action: SubmitAction; id: string; handle: string; owner_hash: string; owner_key: string | null;
  visibility: Visibility; text: string; text_sha256: string; metrics: LayoutMetrics; ladder_hint: Category;
  source: SubmissionSource;
}

// ---- data branch: submit-owned documents ---------------------------------------------------------
export interface ResumeDoc {
  schema: 1;
  id: string;
  kind: 'user';
  status: ResumeStatus;
  handle: string;
  visibility: Visibility;
  owner_hash: string;
  primary: Category;
  created_at: string;
  updated_at: string;
  source: SubmissionSource;
  text?: string;                 // present only when status === 'analyzed'
  text_sha256: string;
  metrics?: LayoutMetrics;
  gate?: { model: string; prompt: string; verdict: import('./schemas/index.ts').GateVerdict };
  analysis?: import('./schemas/index.ts').ResumeAnalysis;   // analyzed, held
  card_sha256?: string;
  category_relevance?: Record<Category, number>;
  scores?: Partial<Record<Category, number>>;              // included categories only, engine-computed
  stage?: CareerStage;
  top_signal?: string;
  held_reason?: HeldReason | null;
  rejected_reason?: RejectCode | null;
  review_reason?: ReviewReason | null;
  queue_reason?: QueueReason | null;
  duplicate_of?: string | null;
  duplicate_kind?: 'text' | 'card' | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  superseded_at?: string | null;
  deleted_at?: string | null;
  versions?: { analyst_model: string; analyst_prompt: string; gate_prompt: string; schema: string; taxonomy: string; fell_back: boolean };
  usage?: { gate_usd: number; analysis_usd: number; latency_ms: number };
}
export interface UserDoc {
  schema: 1; handle: string; owner_hash: string; created_at: string;
  state: 'active' | 'tombstone'; key_exposed: boolean;
  resumes: { id: string; created_at: string; current: boolean }[];
}
export interface RowEntry {
  h: string; v: Visibility; p: Category; st: CareerStage; sig: string; s: ResumeStatus;
  c: Partial<Record<Category, number>>;                   // relevance, included categories only
  sc: Partial<Record<Category, number>>;                  // headline scores
  ss: Partial<Record<Category, [number, number, number, number, number, number]>>; // pedigree, trajectory, impact, selectivity, breadth, stage_relative
  ch: string;                                             // card_sha256
  t: number;                                              // created_at, unix seconds
}
export type RowsShard = Record<string, RowEntry>;
export type CardsShard = Record<string, { card: import('./schemas/index.ts').Card; st: CareerStage }>;
export interface DedupeEntry { id: string; owner_hash: string; t: string }
export interface PlacementTicket { schema: 1; id: string; handle: string; owner_hash: string; primary: Category; supersedes: string | null; queued_at: string }
export interface AnalysisQueueEntry { schema: 1; id: string; reason: QueueReason; enqueued_at: string; source: SubmissionSource; payload: SubmissionPayload }
export interface DeleteRequest { schema: 1; id: string; requested_at: string; handle: string }
export interface UsageLine { t: string; run: string; wf: 'submit' | 'rerank' | 'maintenance' | 'fixtures'; purpose: SpendPurpose; model: string; in: number; cr: number; cw: number; out: number; usd: number; ref: string }
export interface FailureLine { t: string; wf: string; run: string; step: string; code: string; ref?: string }

// ---- data branch: engine-owned -------------------------------------------------------------------
export interface RatingRow {
  id: string;
  own: string;                   // owner_hash.slice(0, 12); 'anchor' for anchors. Same-own pairs never meet.
  lin: string;                   // lineage id (first id of this handle's lineage)
  r: number | null;              // null while a domain row waits for general placement
  rd: number;
  vol: number;                   // stored, frozen at 0.06
  seed: number;
  score: number;                 // rubric headline score for this category
  g: number; w: number; d: number; l: number;
  round: number;                 // placement rounds completed; -1 = waiting for general
  placed: boolean;
  kind: 'user' | 'anchor';
  locked: boolean;
  elig: boolean;                 // false: superseded, deleted
  rank: number | null;           // dense rank among board rows
  top: number | null;            // rank / total, 4 dp
  peak: number; peak_at: string;
  last: string | null;
  days: [date: string, r: number, rank: number | null][];  // ring of 8 nightly snapshots
  opp: string[];                 // last 10 opponent ids in this category
  mv: number;                    // |r − today's snapshot r|
  created: string;
}
export interface RatingsFile {
  schema: 1; category: Category; updated_at: string; run_id: string;
  cursor: Record<string, number>;   // 'matches/<cat>/<file>.jsonl' → lines applied
  shift: number;                    // cumulative drift shift (audit)
  rows: Record<string, RatingRow>;
}
export interface Verdict { winner: 'first' | 'second'; confidence: number; factors: string[]; reasoning: string; model?: string }
export interface MatchLine {
  v: 1; id: string; run: string; wave: number; seq: number; at: string;
  cat: Category; kind: MatchKind; period: string; subj: string;
  a: string; b: string;                          // a < b
  pre: { ar: number; ard: number; br: number; brd: number };
  p1: Verdict;                                   // saw (first = a, second = b)
  p2: Verdict;                                   // saw (first = b, second = a)
  o: Outcome; agree: boolean;
  model: string; pv: string;
  tok: { in: number; cr: number; cw: number; out: number };
  usd: number;
}
export type HistoryPoint = [date: string, r: number, rd: number, reason: 'p' | 'm' | 'v' | 'd' | 's'];
export interface RecentMatch { m: string; at: string; o: 'W' | 'D' | 'L'; opp: string; opp_r: number; dr: number; note: string; k: MatchKind }
export interface HistoryDoc { id: string; cat: Category; lin: string; placed: boolean; points: HistoryPoint[]; recent: RecentMatch[] }
export interface ArenaSide { id: string; card: import('./schemas/index.ts').Card; stage: CareerStage; r_before: number; delta: number }
export interface ArenaPair { m: string; at: string; kind: MatchKind; a: ArenaSide; b: ArenaSide; w: 'A' | 'B' | 'draw'; c: number; reason: string }
export interface ArenaPool { schema: 1; category: Category; updated_at: string; pairs: ArenaPair[] }
export interface Anchor { id: string; rating: number; stage: CareerStage; spec: string; card: import('./schemas/index.ts').Card }
export interface AnchorsFile { schema: 1; category: Category; prompt_version: string; validated_at: string | null; anchors: Anchor[] }

// ---- settings and status -------------------------------------------------------------------------
export interface ModelPrices { input: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; output: number }
export interface RatingSettings {
  rd_initial: number; rd_initial_with_prior: number; rd_initial_domain: number; rd_floor: number; rd_ceiling: number;
  rd_inflation_c: number; rd_revision_min: number;
  placement_rounds_general: number[]; placement_rounds_domain: number[]; revision_rounds_general: number[]; revision_rounds_domain: number[];
  category_relevance_min: number;
  opponent_mix: { local: number; crosscheck: number; anchor: number };
  drift_mode: 'anchors' | 'mean1500'; drift_max_shift: number; drift_alert_residual: number; drift_min_games: number;
  max_placements_per_run: number; max_refine_matches_per_run: number; min_refine_batch: number; max_deferred_analyses_per_run: number;
  refine_cooldown_hours: number; judge_concurrency: number; soft_wall_clock_minutes: number;
  priority_weights: { U: number; S: number; T: number; A: number; V: number; J: number };
  est_cost_per_match_usd: number;
}
export interface Settings {
  schema: 1; paused: boolean; pause_message: string;
  daily_budget_usd: number; refine_budget_share: number; hard_stop_multiplier: number; est_submission_cost_usd: number;
  max_submissions_per_hour: number; max_text_chars: number; min_text_chars: number;
  models: { gate: string; analyst: string; judge: string; analyst_effort: 'medium' | 'high'; judge_effort: 'low' | 'medium' };
  prompts: { gate: string; analyst: string; judge: string; schema: string; taxonomy: string };
  prices_usd_per_mtok: Record<string, ModelPrices>;
  rating: RatingSettings;
  retention: { arena_pool_size: number; history_points: number; history_recent: number; min_deploy_interval_minutes: number };
}
export interface CategoryStats { rated: number; mean: number; sd: number; anchor_residual_7d: number | null; anchor_n_7d: number; anchor_accuracy_7d: number | null; disagreement_rate_7d: number | null }
export interface Status {
  schema: 1; updated_at: string; paused: boolean;
  budget: { day: string; daily_usd: number; spent_usd: number; analysis_usd: number; refine_spent_usd: number; exhausted: boolean; hard_stopped: boolean };
  queue: { placement: number; analysis: number; delete: number; oldest_queued_at: string | null };
  last_rerank: { run_id: number; at: string; trigger: string; waves: number; matches: number; placements_completed: number; duration_s: number; changed: boolean; state: 'ok' | 'failed' | 'aborted_budget' | 'aborted_judge' } | null;
  last_submission_at: string | null;
  last_deploy_requested_at: string | null;
  deploy_pending: boolean;
  counts: Record<'resumes' | 'analyzed' | 'rated' | 'placing' | 'queued' | 'held' | 'needs_review' | 'rejected' | 'duplicate' | 'superseded' | 'deleted' | 'users' | 'matches' | 'anchors', number>;
  per_category: Record<Category, CategoryStats>;
  health: { judge_healthy: boolean; schedule_enabled: boolean; token_expires: string | null; submissions_last_hour: number; failed_runs_24h: number; cancelled_runs_24h: number; issue_path_24h: number; dispatch_path_24h: number; alerts: string[] };
  versions: { engine: string; gate_prompt: string; analyst_prompt: string; judge_prompt: string; schema: string; taxonomy: string };
}
export interface PublicStatus extends Status { deployed_at: string; build_id: string }

// ---- Pages artifact ------------------------------------------------------------------------------
export interface Tier { key: TierKey; label: string; numeral: string; min: number; blurb: string }
export interface Manifest {
  schema: 1; build_id: string; built_at: string; data_sha: string; commit: string;
  counts: { resumes: number; rated: Record<Category, number>; matches: number; users: number };
  page_size: number; partitions: string[];  // ['all', 'stage-student', …]
  pages: Record<Category, number>;
}
export interface PublicSettings {
  tiers: Tier[]; provisional_blurb: string; paused: boolean; pause_message: string;
  limits: { min_chars: number; max_chars: number; max_file_bytes: number; max_submissions_per_hour: number };
  models: Settings['models']; versions: Status['versions']; categories: Category[]; stages: CareerStage[];
}
export interface LadderMeta {
  category: Category; total: number; pages: number; page_size: number; updated_at: string;
  stages: Record<CareerStage, { total: number; pages: number }>;
  medians: { pedigree: number; trajectory: number; impact: number; selectivity: number; breadth: number; stage_relative: number } | null;
}
export const LADDER_COLS = ['rank', 'id', 'identity', 'tier', 'r', 'pm', 'w', 'l', 'd', 'stage', 'sig', 'd7', 'top'] as const;
export type LadderRowTuple = [rank: number, id: string, identity: string, tier: TierKey, r: number, pm: number, w: number, l: number, d: number, stage: CareerStage, sig: string, d7: number | null, top: number];
export interface LadderPage { schema: 1; category: Category; partition: string; page: number; pages: number; total: number; cols: typeof LADDER_COLS; rows: LadderRowTuple[] }
/** [rank, total, r, rd, g, w, l, d, delta7, placed, top, rank_delta_1d]; rank/top/delta null while unplaced. */
export type RankTuple = [rank: number | null, total: number, r: number, rd: number, g: number, w: number, l: number, d: number, delta7: number | null, placed: 0 | 1, top: number | null, rank_delta_1d: number | null];
export interface RankEntry { h: string | null; v: Visibility; st: CareerStage; sig: string; p: Category; g?: RankTuple; f?: RankTuple; t?: RankTuple; a?: RankTuple }
export type RankShard = Record<string, RankEntry>;
export const RANK_KEY: Record<Category, 'g' | 'f' | 't' | 'a'> = { general: 'g', finance: 'f', tech: 't', academia: 'a' };

// ---- browser storage -----------------------------------------------------------------------------
export interface EntryRecord { handle: string; owner_hash: string; submitted_at: string; via: 'dispatch' | 'issue'; ladder_hint: Category }
