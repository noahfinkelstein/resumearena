// Client-side compositions (§11.3): ResumeDoc + RankEntry + HistoryDoc + UserDoc → what the pages render.
import {
  anonIdOf,
  CATEGORIES,
  CATEGORY_WEIGHTS,
  isAnchorId,
  plusMinus,
  RANK_KEY,
  shardOf,
  SUB_SCORE_KEYS,
  tierFor,
  type Category,
  type CareerStage,
  type HistoryDoc,
  type LadderMeta,
  type LayoutMetrics,
  type LadderPage,
  type LadderRowTuple,
  type PublicStatus,
  type RankEntry,
  type RankTuple,
  type ResumeDoc,
  type ResumeAnalysis,
  type TierKey,
  type UserDoc,
  type Visibility,
} from '@resumearena/shared';
import type { RankLookup } from './data.ts';
import { PLACEMENT_TOTAL } from './polling.ts';

export interface Identity {
  kind: 'handle' | 'anon';
  value: string;
}

export const identityOf = (id: string, v: Visibility | undefined, h: string | null | undefined): Identity =>
  v === 'handle' && h ? { kind: 'handle', value: h } : { kind: 'anon', value: anonIdOf(id) };

export interface RatingView {
  category: Category;
  included: boolean;
  /** A rating row exists (seeded); false for excluded categories and domains still waiting. */
  rated: boolean;
  r: number;
  pm: number;
  tier: TierKey;
  provisional: boolean;
  placement: Placement;
  rank: number | null;
  total: number;
  top: number | null;
  delta7: number | null;
  rankDelta1d: number | null;
  record: { w: number; l: number; d: number };
  games: number;
}

export interface Placement {
  done: number;
  total: number;
}

function fromTuple(category: Category, t: RankTuple): RatingView {
  const [rank, total, r, rd, g, w, l, d, delta7, placed, top, rankDelta1d] = t;
  return {
    category,
    included: true,
    rated: true,
    r,
    pm: plusMinus(rd),
    tier: tierFor(r),
    provisional: placed === 0,
    placement: { done: Math.min(g, PLACEMENT_TOTAL[category]), total: PLACEMENT_TOTAL[category] },
    rank,
    total,
    top,
    delta7,
    rankDelta1d,
    record: { w, l, d },
    games: g,
  };
}

const EMPTY_RATING = (category: Category, included: boolean): RatingView => ({
  category,
  included,
  rated: false,
  r: 0,
  pm: 0,
  tier: 'entrant',
  provisional: true,
  placement: { done: 0, total: PLACEMENT_TOTAL[category] },
  rank: null,
  total: 0,
  top: null,
  delta7: null,
  rankDelta1d: null,
  record: { w: 0, l: 0, d: 0 },
  games: 0,
});

/** One row per category, the primary first; excluded categories carry `included: false`. */
export function ratingViews(doc: Pick<ResumeDoc, 'primary' | 'scores'>, entry: RankEntry | null): RatingView[] {
  const included = new Set<Category>(['general', ...(Object.keys(doc.scores ?? {}) as Category[])]);
  const order: Category[] = [doc.primary, ...CATEGORIES.filter((c) => c !== doc.primary)];
  return order.map((c) => {
    const t = entry?.[RANK_KEY[c]];
    return t ? fromTuple(c, t) : EMPTY_RATING(c, included.has(c));
  });
}

export interface MatchView {
  id: string;
  category: Category;
  outcome: 'W' | 'L' | 'D';
  opponentId: string;
  opponentIdentity: string;
  /** null for reference resumes, deleted entries, and opponents whose shard was not read. */
  opponentHref: string | null;
  opponentRating: number;
  delta: number;
  note: string;
  at: string;
  kind: string;
}

export const EMPTY_LOOKUP: RankLookup = { entries: new Map(), fetched: new Set() };

/**
 * Who an opponent is, from what has been read so far. Three cases besides a known entry: a reference
 * resume; a shard that was read and does not hold the id (the entry was deleted); a shard that was not
 * read (not fetched yet, or the request failed), where the label stays neutral and carries no link.
 */
export function opponentLabel(oppId: string, lookup: RankLookup): { label: string; href: string | null } {
  if (isAnchorId(oppId)) return { label: 'reference resume', href: null };
  const entry = lookup.entries.get(oppId);
  if (entry) return { label: identityOf(oppId, entry.v, entry.h).value, href: `/r/${oppId}` };
  if (lookup.fetched.has(shardOf(oppId))) return { label: 'deleted entry', href: null };
  return { label: 'entry', href: null };
}

/** The newest `limit` matches across the given histories; ties in `at` keep CATEGORIES order so the list is stable. */
export function matchViews(histories: Partial<Record<Category, HistoryDoc>>, opponents: RankLookup = EMPTY_LOOKUP, limit = 10): MatchView[] {
  const out: MatchView[] = [];
  for (const cat of CATEGORIES) {
    const h = histories[cat];
    if (!h) continue;
    for (const m of h.recent) {
      const { label, href } = opponentLabel(m.opp, opponents);
      out.push({ id: m.m, category: cat, outcome: m.o, opponentId: m.opp, opponentIdentity: label, opponentHref: href, opponentRating: m.opp_r, delta: m.dr, note: m.note, at: m.at, kind: m.k });
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}

/** The opponent ids on the rows `matchViews` will show (reference resumes excluded): the only shards the result page needs. */
export function displayedOpponentIds(histories: Partial<Record<Category, HistoryDoc>>, limit = 10): string[] {
  return [...new Set(matchViews(histories, EMPTY_LOOKUP, limit).map((m) => m.opponentId).filter((o) => !isAnchorId(o)))];
}

export interface SubScoreView {
  key: string;
  label: string;
  score: number;
  weight?: number;
  median?: number | null;
  note?: string;
}

const SUB_LABEL: Record<(typeof SUB_SCORE_KEYS)[number], string> = { pedigree: 'Pedigree', trajectory: 'Trajectory', impact: 'Impact', selectivity: 'Selectivity', breadth: 'Breadth' };
const ATS_LABEL: Record<string, string> = {
  parseability: 'Parseability',
  formatting: 'Formatting',
  quantification: 'Quantification',
  keyword_alignment: 'Keyword alignment',
  length: 'Length',
  consistency: 'Consistency',
  contact_info: 'Contact info',
};

/** The schema carries one rationale per category, not per factor, so it is returned once rather than hung on a row. */
export function breakdown(analysis: ResumeAnalysis, primary: Category, medians: LadderMeta['medians'] | null | undefined): { rows: SubScoreView[]; stageRelative: SubScoreView; rationale: string } {
  const cs = analysis.scores[primary];
  const w = CATEGORY_WEIGHTS[primary];
  const rows = SUB_SCORE_KEYS.map((k): SubScoreView => ({ key: k, label: SUB_LABEL[k], score: cs.sub_scores[k], weight: w[k], median: medians ? medians[k] : null }));
  return { rows, stageRelative: { key: 'stage_relative', label: 'Stage-relative', score: cs.stage_relative_score, median: medians ? medians.stage_relative : null }, rationale: cs.rationale };
}

export function atsFactors(analysis: ResumeAnalysis): SubScoreView[] {
  return Object.entries(analysis.ats.factors).map(([k, f]) => ({ key: k, label: ATS_LABEL[k] ?? k, score: f.score, note: f.note }));
}

export interface HeadlineScore {
  category: Category;
  score: number | null;
}

export const headlineScores = (doc: Pick<ResumeDoc, 'scores'>): HeadlineScore[] => CATEGORIES.map((c) => ({ category: c, score: doc.scores?.[c] ?? null }));

export interface SparkPoint {
  date: string;
  r: number;
}

export function sparkline(history: HistoryDoc | null | undefined, last = 40): SparkPoint[] {
  if (!history) return [];
  return history.points.slice(-last).map(([date, r]) => ({ date, r }));
}

export interface ResultView {
  id: string;
  status: ResumeDoc['status'];
  identity: Identity;
  handle: string;
  primary: Category;
  stage: CareerStage | null;
  createdAt: string;
  ratings: RatingView[];
  primaryRating: RatingView | null;
  generalRating: RatingView | null;
  spark: SparkPoint[];
  matches: MatchView[];
  games: number;
  verdict: string | null;
  breakdown: SubScoreView[];
  stageRelative: SubScoreView | null;
  /** The analyst's category-level rationale for the primary ladder. */
  rationale: string | null;
  headline: HeadlineScore[];
  strengths: string[];
  weaknesses: string[];
  ats: { score: number; fixes: ResumeAnalysis['ats']['fixes']; factors: SubScoreView[]; target: string } | null;
  redFlags: ResumeAnalysis['red_flags'];
  text: string | null;
  metrics: LayoutMetrics | null;
  topSignal: string | null;
}

export interface ResultInputs {
  doc: ResumeDoc;
  entry: RankEntry | null;
  histories?: Partial<Record<Category, HistoryDoc>>;
  opponents?: RankLookup;
  medians?: LadderMeta['medians'] | null;
}

export function resultView({ doc, entry, histories = {}, opponents = EMPTY_LOOKUP, medians = null }: ResultInputs): ResultView {
  const ratings = ratingViews(doc, entry);
  const primaryRating = ratings.find((r) => r.category === doc.primary && r.rated) ?? null;
  const generalRating = ratings.find((r) => r.category === 'general' && r.rated) ?? null;
  const a = doc.analysis ?? null;
  const bd = a ? breakdown(a, doc.primary, medians) : null;
  // The big number is the general rating, so the line under it is the general history.
  const sparkSource = histories.general ?? histories[doc.primary] ?? null;
  return {
    id: doc.id,
    status: doc.status,
    identity: identityOf(doc.id, doc.visibility, doc.handle),
    handle: doc.handle,
    primary: doc.primary,
    stage: doc.stage ?? a?.signals.career_stage ?? null,
    createdAt: doc.created_at,
    ratings,
    primaryRating,
    generalRating,
    spark: sparkline(sparkSource),
    matches: matchViews(histories, opponents),
    games: ratings.reduce((n, r) => n + r.games, 0),
    verdict: a?.verdict ?? null,
    breakdown: bd?.rows ?? [],
    stageRelative: bd?.stageRelative ?? null,
    rationale: bd?.rationale ?? null,
    headline: headlineScores(doc),
    strengths: a?.strengths ?? [],
    weaknesses: a?.weaknesses ?? [],
    ats: a ? { score: a.ats.score, fixes: a.ats.fixes, factors: atsFactors(a), target: a.ats.target_role_used } : null,
    redFlags: (a?.red_flags ?? []).filter((f) => f.severity !== 'low'),
    text: doc.text ?? null,
    metrics: doc.metrics ?? null,
    topSignal: doc.top_signal ?? a?.card.top_signal ?? null,
  };
}

export interface ProfileView {
  handle: string;
  ownerHash: string;
  state: UserDoc['state'];
  currentId: string | null;
  versions: number;
  enteredAt: string;
  visibility: Visibility | null;
  stage: CareerStage | null;
  primary: Category | null;
  ratings: RatingView[];
}

export function profileView(user: UserDoc, doc: ResumeDoc | null, entry: RankEntry | null): ProfileView {
  const current = user.resumes.find((r) => r.current) ?? null;
  return {
    handle: user.handle,
    ownerHash: user.owner_hash,
    state: user.state,
    currentId: current?.id ?? null,
    versions: user.resumes.length,
    enteredAt: user.created_at,
    visibility: doc?.visibility ?? entry?.v ?? null,
    stage: doc?.stage ?? entry?.st ?? null,
    primary: doc?.primary ?? entry?.p ?? null,
    ratings: doc ? ratingViews(doc, entry) : entry ? ratingViews({ primary: entry.p, scores: {} }, entry) : [],
  };
}

export interface HistoryEvent {
  date: string;
  r: number;
  rd: number;
  reason: 'p' | 'm' | 'v' | 'd' | 's';
  label: string;
}

const REASON_LABEL: Record<HistoryEvent['reason'], string> = { p: 'placement', m: 'match', v: 'resubmission', d: 'scale adjustment', s: 'daily snapshot' };

export function historyEvents(h: HistoryDoc | null): HistoryEvent[] {
  if (!h) return [];
  return [...h.points].reverse().map(([date, r, rd, reason]) => ({ date, r, rd, reason, label: REASON_LABEL[reason] }));
}

export interface LadderRow {
  rank: number;
  id: string;
  identity: Identity;
  tier: TierKey;
  r: number;
  pm: number;
  w: number;
  l: number;
  d: number;
  stage: CareerStage;
  sig: string;
  d7: number | null;
  top: number;
}

export function ladderRow(t: LadderRowTuple): LadderRow {
  const [rank, id, identity, tier, r, pm, w, l, d, stage, sig, d7, top] = t;
  return { rank, id, identity: identity.startsWith('anon-') ? { kind: 'anon', value: identity } : { kind: 'handle', value: identity }, tier, r, pm, w, l, d, stage, sig, d7, top };
}

export const ladderRows = (page: LadderPage | null): LadderRow[] => (page ? page.rows.map(ladderRow) : []);

/** Page that holds a given rank at the ladder's page size. */
export const pageForRank = (rank: number, pageSize = 100): number => Math.max(1, Math.ceil(rank / pageSize));

export const clampPage = (page: number, pages: number): number => Math.min(Math.max(1, Math.floor(page) || 1), Math.max(1, pages));

export const stagePartition = (stage: CareerStage | null): string => (stage ? `stage-${stage}` : 'all');

/** Which ladder page a rank-shard entry lands on for a category (for find-me links). */
export function focusLink(id: string, category: Category, rank: number | null, pageSize = 100): string {
  const page = rank ? pageForRank(rank, pageSize) : 1;
  return `/leaderboard/${category}?page=${page}&focus=${id}`;
}

/**
 * §7.2 busy warning: null unless `submissions_last_hour` has reached the cap. The count was measured at
 * `status.updated_at`; the oldest counted run ages out at most 60 minutes after that, so the warning
 * quotes the minutes left in that window (never more than 60, never less than 1).
 */
export function busyWindowMinutes(status: Pick<PublicStatus, 'health' | 'updated_at'>, cap: number, now: number): number | null {
  if (status.health.submissions_last_hour < cap) return null;
  const measuredAt = Date.parse(status.updated_at);
  if (!Number.isFinite(measuredAt)) return 60;
  const left = Math.ceil((measuredAt + 60 * 60_000 - now) / 60_000);
  return Math.max(1, Math.min(60, left));
}
