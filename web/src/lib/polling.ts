// Result-page phase machine (§11.2). A pure reducer over local-clock events and fetch results, plus a
// small runner that owns the one timer. Sources: the doc (raw, or the contents API for the submitter's
// first ten minutes, see `docSource`), the manifest, the rank shard and status.json.
import { RANK_KEY, type Category, type PublicStatus, type RankEntry, type RankTuple, type ResumeDoc } from '@resumearena/shared';
import type { DocSource } from './data.ts';

export type Phase =
  | 'dispatched'
  | 'not_seen'
  | 'stale'
  | 'publishing'
  | 'not_found'
  | 'queued'
  | 'analysed'
  | 'placing'
  | 'budget_wait'
  | 'rated'
  | 'held'
  | 'held_injection'
  | 'needs_review'
  | 'rejected'
  | 'duplicate'
  | 'superseded'
  | 'deleted'
  | 'collision';

export type Mode = 'submitter' | 'visitor';

export interface PollConfig {
  id: string;
  mode: Mode;
  /** The submitter's own owner_hash; null in visitor mode. */
  ownerHash: string | null;
  /** ms epoch of the dispatch (submitter) or of opening the page (visitor). */
  submittedAt: number;
  via: 'dispatch' | 'issue';
}

export interface Placement {
  done: number;
  total: number;
}

export interface PollState {
  cfg: PollConfig;
  now: number;
  hidden: boolean;
  doc: ResumeDoc | null;
  /** Doc fetches that came back empty. */
  misses: number;
  buildId: string | null;
  rank: RankEntry | null;
  rankBuildId: string | null;
  status: PublicStatus | null;
  phase: Phase;
  placement: Placement | null;
  due: { doc: number | null; manifest: number | null; status: number | null };
  inflight: { doc: boolean; manifest: boolean; rank: boolean; status: boolean };
  reminted: boolean;
  /** The remint effect was emitted; it is never emitted twice for one id. */
  remintRequested: boolean;
  done: boolean;
  /** Set once the reveal should run (general placed) so the page can act once. */
  ratedAt: number | null;
}

export type PollEvent =
  | { type: 'start'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'doc'; now: number; doc: ResumeDoc | null }
  | { type: 'doc_error'; now: number }
  | { type: 'manifest'; now: number; buildId: string | null }
  | { type: 'manifest_error'; now: number }
  | { type: 'rank'; now: number; buildId: string; entry: RankEntry | null }
  | { type: 'rank_error'; now: number }
  | { type: 'status'; now: number; status: PublicStatus | null }
  | { type: 'visibility'; now: number; hidden: boolean }
  | { type: 'reminted'; now: number; id: string; ownerHash: string };

export type PollEffect =
  | { type: 'fetch_doc'; id: string; polling: boolean; source: DocSource }
  | { type: 'fetch_manifest' }
  | { type: 'fetch_rank'; id: string; buildId: string }
  | { type: 'fetch_status' }
  | { type: 'remint' }
  | { type: 'redirect'; to: string }
  | { type: 'rated' };

export const T = {
  silent: 90_000,
  docEvery: 45_000,
  /** Contents API cadence while it is the source (≤ 7 requests per submission). */
  docEveryApi: 90_000,
  /** How long after submission the contents API is used (then raw, as before). */
  apiWindow: 600_000,
  docEveryStale: 60_000,
  docEveryQueued: 300_000,
  visitorRetry: 30_000,
  manifestEvery: 60_000,
  manifestEveryRated: 300_000,
  statusEvery: 300_000,
  errorRetry: 60_000,
  notSeenAt: 600_000,
  staleAt: 1_800_000,
} as const;

export const PLACEMENT_TOTAL: Record<Category, number> = { general: 8, finance: 6, tech: 6, academia: 6 };

export function initialState(cfg: PollConfig, now: number): PollState {
  return {
    cfg,
    now,
    hidden: false,
    doc: null,
    misses: 0,
    buildId: null,
    rank: null,
    rankBuildId: null,
    status: null,
    phase: cfg.mode === 'submitter' ? 'dispatched' : 'publishing',
    placement: null,
    due: { doc: null, manifest: null, status: null },
    inflight: { doc: false, manifest: false, rank: false, status: false },
    reminted: false,
    remintRequested: false,
    done: false,
    ratedAt: null,
  };
}

const tupleFor = (entry: RankEntry | null, cat: Category): RankTuple | null => entry?.[RANK_KEY[cat]] ?? null;

/** Every category the analysis included has a tuple with placed = 1. */
export function allPlaced(doc: ResumeDoc, entry: RankEntry | null): boolean {
  const cats = Object.keys(doc.scores ?? { general: 0 }) as Category[];
  return cats.every((c) => tupleFor(entry, c)?.[9] === 1);
}

function derive(s: PollState): { phase: Phase; placement: Placement | null } {
  const { doc, cfg, now } = s;
  if (!doc) {
    if (cfg.mode === 'visitor') return { phase: s.misses >= 2 ? 'not_found' : 'publishing', placement: null };
    const elapsed = now - cfg.submittedAt;
    if (elapsed >= T.staleAt) return { phase: 'stale', placement: null };
    if (elapsed >= T.notSeenAt) return { phase: 'not_seen', placement: null };
    return { phase: 'dispatched', placement: null };
  }
  if (cfg.mode === 'submitter' && cfg.ownerHash && doc.owner_hash && doc.owner_hash !== cfg.ownerHash && doc.status !== 'deleted') {
    return { phase: 'collision', placement: null };
  }
  switch (doc.status) {
    case 'queued':
      return { phase: 'queued', placement: null };
    case 'held':
      return { phase: doc.held_reason === 'injection' ? 'held_injection' : 'held', placement: null };
    case 'needs_review':
      return { phase: 'needs_review', placement: null };
    case 'rejected':
      return { phase: 'rejected', placement: null };
    case 'duplicate':
      return { phase: 'duplicate', placement: null };
    case 'superseded':
      return { phase: 'superseded', placement: null };
    case 'deleted':
      return { phase: 'deleted', placement: null };
    case 'analyzed': {
      const g = tupleFor(s.rank, 'general');
      if (!g) return { phase: s.status?.budget.exhausted ? 'budget_wait' : 'analysed', placement: null };
      if (g[9] === 0) {
        const placement = { done: Math.min(g[4], PLACEMENT_TOTAL.general), total: PLACEMENT_TOTAL.general };
        return { phase: s.status?.budget.exhausted ? 'budget_wait' : 'placing', placement };
      }
      return { phase: 'rated', placement: { done: PLACEMENT_TOTAL.general, total: PLACEMENT_TOTAL.general } };
    }
  }
}

const TERMINAL: ReadonlySet<Phase> = new Set(['held', 'held_injection', 'needs_review', 'rejected', 'duplicate', 'deleted', 'not_found', 'superseded']);

/**
 * Where the next doc poll reads from. raw.githubusercontent.com serves a document up to five minutes
 * stale, so the submitter's wait for the doc to appear (and, if it is queued, for its status to change)
 * reads the contents API instead for the first ten minutes after submission. Visitors, and every read
 * after that window, use raw.
 */
export function docSource(s: Pick<PollState, 'cfg' | 'now' | 'doc'>): DocSource {
  if (s.cfg.mode !== 'submitter') return 'raw';
  if (s.now - s.cfg.submittedAt >= T.apiWindow) return 'raw';
  if (s.doc && s.doc.status !== 'queued') return 'raw';
  return 'api';
}

/** How long to wait between doc polls in a given phase (§11.2). */
export function docCadence(phase: Phase, mode: Mode, source: DocSource = 'raw'): number {
  if (source === 'api') return T.docEveryApi;
  if (phase === 'stale') return T.docEveryStale;
  if (phase === 'queued') return T.docEveryQueued;
  if (mode === 'visitor') return T.visitorRetry;
  return T.docEvery;
}

/** Recompute phase and the next due times from the current facts. */
function settle(prev: PollState, effects: PollEffect[]): PollState {
  const { phase, placement } = derive(prev);
  const s: PollState = { ...prev, phase, placement, due: { ...prev.due } };
  const now = s.now;

  if (phase === 'collision') {
    if (!s.reminted && !s.remintRequested) {
      s.remintRequested = true;
      effects.push({ type: 'remint' });
    }
    s.due = { doc: null, manifest: null, status: null };
    return s;
  }
  if (phase === 'superseded' && s.doc?.superseded_by) effects.push({ type: 'redirect', to: s.doc.superseded_by });
  if (TERMINAL.has(phase)) {
    s.due = { doc: null, manifest: null, status: null };
    s.done = true;
    return s;
  }

  if (!s.doc) {
    if (s.due.doc === null) {
      // Visitors look straight away; submitters give the workflow its silent 90 s first.
      s.due.doc = s.cfg.mode === 'visitor' ? now : Math.max(now, s.cfg.submittedAt + T.silent);
    }
    s.due.manifest = null;
    if (s.cfg.mode === 'submitter' && s.due.status === null) s.due.status = now;
    return s;
  }

  if (phase === 'queued') {
    if (s.due.doc === null) s.due.doc = now + T.docEveryQueued;
    if (s.due.status === null) s.due.status = now;
    s.due.manifest = null;
    return s;
  }

  // analyzed: the doc is settled; the manifest tells us when a new rank shard exists.
  s.due.doc = null;
  if (phase === 'rated') {
    if (s.ratedAt === null) {
      s.ratedAt = now;
      effects.push({ type: 'rated' });
    }
    if (s.doc && allPlaced(s.doc, s.rank)) {
      s.due = { doc: null, manifest: null, status: null };
      s.done = true;
      return s;
    }
    if (s.due.manifest === null) s.due.manifest = now + T.manifestEveryRated;
    s.due.status = null;
    return s;
  }
  if (s.due.manifest === null) s.due.manifest = s.buildId === null ? now : now + T.manifestEvery;
  if (s.due.status === null) s.due.status = now;
  return s;
}

export function reduce(prev: PollState, ev: PollEvent): { state: PollState; effects: PollEffect[] } {
  const effects: PollEffect[] = [];
  let s: PollState = { ...prev, now: ev.now };
  switch (ev.type) {
    case 'start':
      s = settle(s, effects);
      return fire(s, effects);
    case 'tick':
      return fire(s, effects);
    case 'visibility':
      s.hidden = ev.hidden;
      // Timers paused while hidden fire once on return.
      return ev.hidden ? { state: s, effects } : fire(s, effects);
    case 'doc': {
      s.inflight = { ...s.inflight, doc: false };
      if (ev.doc === null) s.misses += 1;
      else {
        s.doc = ev.doc;
        s.misses = 0;
      }
      // The next doc poll is one cadence away; settle() clears it for documents that no longer need polling.
      s.due = { ...s.due, doc: ev.now + docCadence(derive(s).phase, s.cfg.mode, docSource(s)) };
      s = settle(s, effects);
      return fire(s, effects);
    }
    case 'doc_error':
      s.inflight = { ...s.inflight, doc: false };
      s.due = { ...s.due, doc: ev.now + T.errorRetry };
      return { state: s, effects };
    case 'manifest': {
      s.inflight = { ...s.inflight, manifest: false };
      s.due = { ...s.due, manifest: null };
      if (ev.buildId !== null) {
        s.buildId = ev.buildId;
        if (ev.buildId !== s.rankBuildId && !s.inflight.rank) {
          s.inflight = { ...s.inflight, rank: true };
          effects.push({ type: 'fetch_rank', id: s.cfg.id, buildId: ev.buildId });
        }
      }
      s = settle(s, effects);
      return fire(s, effects);
    }
    case 'manifest_error':
      s.inflight = { ...s.inflight, manifest: false };
      s.due = { ...s.due, manifest: ev.now + T.errorRetry };
      return { state: s, effects };
    case 'rank': {
      s.inflight = { ...s.inflight, rank: false };
      s.rank = ev.entry;
      s.rankBuildId = ev.buildId;
      // The new tuple may change the manifest cadence (60 s while placing, 5 min once rated).
      s.due = { ...s.due, manifest: null };
      s = settle(s, effects);
      return fire(s, effects);
    }
    case 'rank_error':
      s.inflight = { ...s.inflight, rank: false };
      // Try again with the next manifest poll.
      s.rankBuildId = null;
      s.due = { ...s.due, manifest: ev.now + T.errorRetry };
      return { state: s, effects };
    case 'status': {
      s.inflight = { ...s.inflight, status: false };
      s.status = ev.status;
      s.due = { ...s.due, status: ev.now + T.statusEvery };
      s = settle(s, effects);
      return { state: s, effects };
    }
    case 'reminted': {
      s = initialState({ ...s.cfg, id: ev.id, ownerHash: ev.ownerHash, submittedAt: ev.now }, ev.now);
      s.reminted = true;
      s.hidden = prev.hidden;
      s = settle(s, effects);
      return fire(s, effects);
    }
  }
}

/** Emit fetches for every source that is due and not in flight; advance their due times. */
function fire(prev: PollState, effects: PollEffect[]): { state: PollState; effects: PollEffect[] } {
  const s: PollState = { ...prev, due: { ...prev.due }, inflight: { ...prev.inflight } };
  if (s.hidden || s.done) return { state: s, effects };
  const now = s.now;
  if (s.due.doc !== null && s.due.doc <= now && !s.inflight.doc) {
    const source = docSource(s);
    s.inflight.doc = true;
    s.due.doc = now + docCadence(s.phase, s.cfg.mode, source);
    effects.push({ type: 'fetch_doc', id: s.cfg.id, polling: true, source });
  }
  if (s.due.manifest !== null && s.due.manifest <= now && !s.inflight.manifest) {
    s.inflight.manifest = true;
    s.due.manifest = now + (s.phase === 'rated' ? T.manifestEveryRated : T.manifestEvery);
    effects.push({ type: 'fetch_manifest' });
  }
  if (s.due.status !== null && s.due.status <= now && !s.inflight.status) {
    s.inflight.status = true;
    s.due.status = now + T.statusEvery;
    effects.push({ type: 'fetch_status' });
  }
  return { state: s, effects };
}

/** The earliest due time, or null when nothing is scheduled. Phase transitions on the local clock count too. */
export function nextDue(s: PollState): number | null {
  if (s.done || s.hidden) return null;
  const times = [s.due.doc, s.due.manifest, s.due.status].filter((t): t is number => t !== null);
  if (!s.doc && s.cfg.mode === 'submitter') {
    for (const at of [s.cfg.submittedAt + T.notSeenAt, s.cfg.submittedAt + T.staleAt]) if (at > s.now) times.push(at);
  }
  return times.length ? Math.min(...times) : null;
}

/** Re-derive the phase for a clock change without fetching (10/30-minute rows). */
export function refreshPhase(s: PollState, now: number): PollState {
  const next = { ...s, now };
  const { phase, placement } = derive(next);
  return { ...next, phase, placement };
}

// ---- runner --------------------------------------------------------------------------------------

export interface PollerDeps {
  fetchDoc(id: string, polling: boolean, source: DocSource): Promise<ResumeDoc | null>;
  fetchManifest(): Promise<{ build_id: string } | null>;
  fetchRank(id: string, buildId: string): Promise<RankEntry | null>;
  fetchStatus(): Promise<PublicStatus | null>;
  /** Mint and dispatch a new id; resolve with the new id or null when it could not be sent. */
  remint(): Promise<{ id: string; ownerHash: string } | null>;
  redirect(to: string): void;
  onRated?(): void;
  onState(state: PollState): void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface Poller {
  state(): PollState;
  dispatch(ev: PollEvent): void;
  stop(): void;
}

export function createPoller(cfg: PollConfig, deps: PollerDeps): Poller {
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
  let state = initialState(cfg, now());
  let timer: unknown = null;
  let stopped = false;

  const schedule = (): void => {
    if (timer !== null) clearT(timer);
    timer = null;
    const at = nextDue(state);
    if (at === null || stopped) return;
    timer = setT(() => {
      timer = null;
      dispatch({ type: 'tick', now: now() });
    }, Math.max(0, at - now()));
  };

  const run = (effects: PollEffect[]): void => {
    for (const e of effects) {
      switch (e.type) {
        case 'fetch_doc':
          deps.fetchDoc(e.id, e.polling, e.source).then(
            (doc) => dispatch({ type: 'doc', now: now(), doc }),
            () => dispatch({ type: 'doc_error', now: now() }),
          );
          break;
        case 'fetch_manifest':
          deps.fetchManifest().then(
            (m) => dispatch({ type: 'manifest', now: now(), buildId: m?.build_id ?? null }),
            () => dispatch({ type: 'manifest_error', now: now() }),
          );
          break;
        case 'fetch_rank':
          deps.fetchRank(e.id, e.buildId).then(
            (entry) => dispatch({ type: 'rank', now: now(), buildId: e.buildId, entry }),
            () => dispatch({ type: 'rank_error', now: now() }),
          );
          break;
        case 'fetch_status':
          deps.fetchStatus().then(
            (status) => dispatch({ type: 'status', now: now(), status }),
            () => dispatch({ type: 'status', now: now(), status: state.status }),
          );
          break;
        case 'remint':
          deps.remint().then((r) => {
            if (r) dispatch({ type: 'reminted', now: now(), id: r.id, ownerHash: r.ownerHash });
          }, () => undefined);
          break;
        case 'redirect':
          deps.redirect(e.to);
          break;
        case 'rated':
          deps.onRated?.();
          break;
      }
    }
  };

  const dispatch = (ev: PollEvent): void => {
    if (stopped) return;
    const { state: next, effects } = reduce(state, ev);
    // A tick that fetched nothing may still have crossed the 10/30-minute lines.
    state = ev.type === 'tick' ? refreshPhase(next, ev.now) : next;
    deps.onState(state);
    run(effects);
    schedule();
  };

  dispatch({ type: 'start', now: now() });

  return {
    state: () => state,
    dispatch,
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
