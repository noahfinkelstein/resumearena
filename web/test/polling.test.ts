import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicStatus, RankEntry, ResumeDoc } from '@resumearena/shared';
import { allPlaced, createPoller, docCadence, docSource, initialState, nextDue, reduce, T, type PollConfig, type PollEffect, type PollerDeps, type PollState } from '../src/lib/polling.ts';

const OWN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const ID = 'k7q2m3xw5a';

const cfg = (over: Partial<PollConfig> = {}): PollConfig => ({ id: ID, mode: 'submitter', ownerHash: OWN, submittedAt: 0, via: 'dispatch', ...over });

const analyzed = (over: Partial<ResumeDoc> = {}): ResumeDoc =>
  ({
    schema: 1,
    id: ID,
    kind: 'user',
    status: 'analyzed',
    handle: 'priya-n',
    visibility: 'anonymous',
    owner_hash: OWN,
    primary: 'tech',
    created_at: '2026-10-03T14:11:02Z',
    updated_at: '2026-10-03T14:13:40Z',
    source: { kind: 'dispatch', run_id: 1, issue_number: null, client_version: '' },
    text_sha256: 'x',
    scores: { general: 71, tech: 78 },
    ...over,
  }) as ResumeDoc;

const entry = (gPlaced: 0 | 1, g = 3, withTech = false, tPlaced: 0 | 1 = 0): RankEntry => {
  const e: RankEntry = { h: null, v: 'anonymous', st: 'mid', sig: 'x', p: 'tech', g: [gPlaced ? 412 : null, 1000, 1500, 100, g, 2, 1, 0, null, gPlaced, gPlaced ? 0.4 : null, null] };
  if (withTech) e.t = [tPlaced ? 50 : null, 200, 1520, 120, 2, 1, 1, 0, null, tPlaced, tPlaced ? 0.25 : null, null];
  return e;
};

const status = (exhausted = false): PublicStatus =>
  ({ budget: { exhausted }, queue: { placement: 3, analysis: 2, delete: 0, oldest_queued_at: null }, paused: false }) as unknown as PublicStatus;

const run = (s: PollState, evs: Parameters<typeof reduce>[1][]): { state: PollState; effects: PollEffect[] } => {
  let state = s;
  const effects: PollEffect[] = [];
  for (const ev of evs) {
    const r = reduce(state, ev);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
};

describe('polling reducer', () => {
  it('stays silent for 90 s after dispatch, then polls the doc through the contents API every 90 s', () => {
    const { state, effects } = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }]);
    expect(state.phase).toBe('dispatched');
    expect(effects.filter((e) => e.type === 'fetch_doc')).toHaveLength(0);
    expect(state.due.doc).toBe(T.silent);
    const t1 = reduce(state, { type: 'tick', now: T.silent });
    expect(t1.effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'api' });
    const d1 = reduce(t1.state, { type: 'doc', now: T.silent + 100, doc: null });
    expect(d1.effects).toHaveLength(0);
    expect(d1.state.due.doc).toBe(T.silent + 100 + T.docEveryApi);
  });

  it('source selection: the API for the submitter\'s first ten minutes while the doc is missing or queued, raw otherwise', () => {
    const base = initialState(cfg(), 0);
    expect(docSource({ ...base, now: T.silent })).toBe('api');
    expect(docSource({ ...base, now: T.apiWindow - 1 })).toBe('api');
    expect(docSource({ ...base, now: T.apiWindow })).toBe('raw');
    expect(docSource({ ...base, now: T.silent, doc: analyzed({ status: 'queued', queue_reason: 'budget' }) })).toBe('api');
    expect(docSource({ ...base, now: T.silent, doc: analyzed() })).toBe('raw');
    expect(docSource({ ...initialState(cfg({ mode: 'visitor', ownerHash: null }), 0), now: 1 })).toBe('raw');
    // A later submission time shifts the window with it.
    expect(docSource({ ...initialState(cfg({ submittedAt: 3_600_000 }), 3_600_000), now: 3_600_000 + T.apiWindow - 1 })).toBe('api');
    expect(docCadence('dispatched', 'submitter', 'api')).toBe(T.docEveryApi);
    expect(docCadence('dispatched', 'submitter', 'raw')).toBe(T.docEvery);
    expect(docCadence('queued', 'submitter', 'api')).toBe(T.docEveryApi);
    expect(docCadence('queued', 'submitter', 'raw')).toBe(T.docEveryQueued);
  });

  it('after ten minutes the poll falls back to raw at the 45 s cadence', () => {
    let r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: null }]);
    // Inside the window: api, 90 s apart.
    r = run(r.state, [{ type: 'tick', now: T.apiWindow - 60_000 }]);
    expect(r.effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'api' });
    r = run(r.state, [{ type: 'doc', now: T.apiWindow - 59_000, doc: null }]);
    expect(r.state.due.doc).toBe(T.apiWindow - 59_000 + T.docEveryApi);
    // Past the window: raw, 45 s apart; the not_seen row shows at the same moment.
    r = run(r.state, [{ type: 'tick', now: T.apiWindow + 31_000 }]);
    expect(r.effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'raw' });
    expect(r.state.due.doc).toBe(T.apiWindow + 31_000 + T.docEvery);
    r = run(r.state, [{ type: 'doc', now: T.apiWindow + 32_000, doc: null }]);
    expect(r.state.phase).toBe('not_seen');
    expect(r.state.due.doc).toBe(T.apiWindow + 32_000 + T.docEvery);
  });

  it('a queued doc inside the window keeps the API cadence, then the slow raw cadence', () => {
    const queued = analyzed({ status: 'queued', queue_reason: 'budget' });
    let r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: queued }]);
    expect(r.state.phase).toBe('queued');
    expect(r.state.due.doc).toBe(T.silent + 1 + T.docEveryApi);
    r = run(r.state, [{ type: 'tick', now: T.silent + 1 + T.docEveryApi }]);
    expect(r.effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'api' });
    r = run(r.state, [{ type: 'doc', now: T.apiWindow + 5, doc: queued }]);
    expect(r.state.due.doc).toBe(T.apiWindow + 5 + T.docEveryQueued);
  });

  it('visitor mode polls immediately and 404s after two tries', () => {
    const { state, effects } = run(initialState(cfg({ mode: 'visitor', ownerHash: null }), 0), [{ type: 'start', now: 0 }]);
    expect(state.phase).toBe('publishing');
    expect(effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'raw' });
    const a = reduce(state, { type: 'doc', now: 1, doc: null });
    expect(a.state.phase).toBe('publishing');
    expect(a.state.due.doc).toBe(1 + T.visitorRetry);
    const b = run(a.state, [{ type: 'tick', now: 1 + T.visitorRetry }, { type: 'doc', now: 2 + T.visitorRetry, doc: null }]);
    expect(b.state.phase).toBe('not_found');
    expect(b.state.done).toBe(true);
    expect(nextDue(b.state)).toBeNull();
  });

  it('shows not_seen at 10 min and stale at 30 min on the local clock, polling every 60 s when stale', () => {
    let s = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }]).state;
    s = run(s, [{ type: 'tick', now: T.notSeenAt + 1 }, { type: 'doc', now: T.notSeenAt + 2, doc: null }]).state;
    expect(s.phase).toBe('not_seen');
    s = run(s, [{ type: 'tick', now: T.staleAt + 1 }, { type: 'doc', now: T.staleAt + 2, doc: null }]).state;
    expect(s.phase).toBe('stale');
    expect(s.due.doc).toBe(T.staleAt + 2 + T.docEveryStale);
  });

  it('analyzed doc → fetch manifest → new build fetches the rank shard → analysed / placing / rated', () => {
    let r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: analyzed() }]);
    expect(r.state.phase).toBe('analysed');
    expect(r.effects).toContainEqual({ type: 'fetch_manifest' });
    expect(r.state.due.doc).toBeNull();
    r = run(r.state, [{ type: 'manifest', now: T.silent + 2, buildId: 'b1' }]);
    expect(r.effects).toContainEqual({ type: 'fetch_rank', id: ID, buildId: 'b1' });
    r = run(r.state, [{ type: 'rank', now: T.silent + 3, buildId: 'b1', entry: null }]);
    expect(r.state.phase).toBe('analysed');
    expect(r.state.due.manifest).toBe(T.silent + 3 + T.manifestEvery);
    // Same build id again: no rank fetch.
    r = run(r.state, [{ type: 'tick', now: T.silent + 3 + T.manifestEvery }, { type: 'manifest', now: T.silent + 3 + T.manifestEvery + 1, buildId: 'b1' }]);
    expect(r.effects.filter((e) => e.type === 'fetch_rank')).toHaveLength(0);
    // New build with an unplaced tuple: placing 3 of 8.
    r = run(r.state, [{ type: 'manifest', now: 500_000, buildId: 'b2' }, { type: 'rank', now: 500_001, buildId: 'b2', entry: entry(0, 3) }]);
    expect(r.state.phase).toBe('placing');
    expect(r.state.placement).toEqual({ done: 3, total: 8 });
    // General placed: rated once, keep polling every 5 min until tech is placed too.
    r = run(r.state, [{ type: 'manifest', now: 600_000, buildId: 'b3' }, { type: 'rank', now: 600_001, buildId: 'b3', entry: entry(1, 8, true, 0) }]);
    expect(r.state.phase).toBe('rated');
    expect(r.effects).toContainEqual({ type: 'rated' });
    expect(r.state.done).toBe(false);
    expect(r.state.due.manifest).toBe(600_001 + T.manifestEveryRated);
    r = run(r.state, [{ type: 'manifest', now: 900_000, buildId: 'b4' }, { type: 'rank', now: 900_001, buildId: 'b4', entry: entry(1, 8, true, 1) }]);
    expect(r.state.done).toBe(true);
    expect(r.effects.filter((e) => e.type === 'rated')).toHaveLength(0);
    expect(nextDue(r.state)).toBeNull();
  });

  it('budget exhausted shows the queued-for-tomorrow row instead of placing', () => {
    const r = run(initialState(cfg(), 0), [
      { type: 'start', now: 0 },
      { type: 'status', now: 1, status: status(true) },
      { type: 'tick', now: T.silent },
      { type: 'doc', now: T.silent + 1, doc: analyzed() },
      { type: 'manifest', now: T.silent + 2, buildId: 'b1' },
      { type: 'rank', now: T.silent + 3, buildId: 'b1', entry: entry(0, 2) },
    ]);
    expect(r.state.phase).toBe('budget_wait');
  });

  it('queued docs poll slowly and never ask for the manifest', () => {
    // Submitted more than ten minutes ago, so the raw cadence applies (inside the window, see the queued-doc test above).
    const r = run(initialState(cfg({ submittedAt: -T.apiWindow }), 0), [{ type: 'start', now: 0 }, { type: 'doc', now: 1, doc: analyzed({ status: 'queued', queue_reason: 'budget' }) }]);
    expect(r.state.phase).toBe('queued');
    expect(r.state.due.manifest).toBeNull();
    expect(r.state.due.doc).toBe(1 + T.docEveryQueued);
  });

  it.each([
    ['held', { status: 'held', held_reason: 'pii' }, 'held'],
    ['held injection', { status: 'held', held_reason: 'injection' }, 'held_injection'],
    ['needs_review', { status: 'needs_review' }, 'needs_review'],
    ['rejected', { status: 'rejected' }, 'rejected'],
    ['duplicate', { status: 'duplicate' }, 'duplicate'],
    ['deleted', { status: 'deleted' }, 'deleted'],
  ] as const)('%s is terminal', (_name, over, phase) => {
    const r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: analyzed(over as Partial<ResumeDoc>) }]);
    expect(r.state.phase).toBe(phase);
    expect(r.state.done).toBe(true);
    expect(nextDue(r.state)).toBeNull();
  });

  it('superseded redirects to the current version', () => {
    const r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: analyzed({ status: 'superseded', superseded_by: 'x6ppa2a7mq' }) }]);
    expect(r.effects).toContainEqual({ type: 'redirect', to: 'x6ppa2a7mq' });
  });

  it('a doc owned by someone else is a collision: remint once, then continue under the new id', () => {
    const r = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }, { type: 'tick', now: T.silent }, { type: 'doc', now: T.silent + 1, doc: analyzed({ owner_hash: OTHER }) }]);
    expect(r.state.phase).toBe('collision');
    expect(r.effects).toContainEqual({ type: 'remint' });
    const again = reduce(r.state, { type: 'doc', now: T.silent + 2, doc: analyzed({ owner_hash: OTHER }) });
    expect(again.effects.filter((e) => e.type === 'remint')).toHaveLength(0);
    const after = reduce(r.state, { type: 'reminted', now: 200_000, id: 'x6ppa2a7mq', ownerHash: OWN });
    expect(after.state.cfg.id).toBe('x6ppa2a7mq');
    expect(after.state.phase).toBe('dispatched');
    expect(after.state.reminted).toBe(true);
    expect(after.state.due.doc).toBe(200_000 + T.silent);
  });

  it('visitor mode never treats a foreign owner as a collision', () => {
    const r = run(initialState(cfg({ mode: 'visitor', ownerHash: null }), 0), [{ type: 'start', now: 0 }, { type: 'doc', now: 1, doc: analyzed({ owner_hash: OTHER }) }]);
    expect(r.state.phase).toBe('analysed');
  });

  it('pauses while hidden and fires once on return', () => {
    const start = run(initialState(cfg(), 0), [{ type: 'start', now: 0 }]).state;
    const hidden = reduce(start, { type: 'visibility', now: 10, hidden: true });
    expect(nextDue(hidden.state)).toBeNull();
    const tick = reduce(hidden.state, { type: 'tick', now: T.silent + 5 });
    expect(tick.effects).toHaveLength(0);
    const back = reduce(tick.state, { type: 'visibility', now: T.silent + 10, hidden: false });
    expect(back.effects).toContainEqual({ type: 'fetch_doc', id: ID, polling: true, source: 'api' });
  });

  it('allPlaced needs every included category placed', () => {
    expect(allPlaced(analyzed(), entry(1, 8))).toBe(false);
    expect(allPlaced(analyzed(), entry(1, 8, true, 1))).toBe(true);
    expect(allPlaced(analyzed({ scores: { general: 50 } }), entry(1, 8))).toBe(true);
  });
});

describe('createPoller with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deps(over: Partial<PollerDeps> = {}): PollerDeps & { states: PollState[]; calls: string[] } {
    const states: PollState[] = [];
    const calls: string[] = [];
    return {
      states,
      calls,
      fetchDoc: async (_id, _polling, source) => {
        calls.push(`doc:${source}`);
        return null;
      },
      fetchManifest: async () => {
        calls.push('manifest');
        return { build_id: 'b1' };
      },
      fetchRank: async () => {
        calls.push('rank');
        return null;
      },
      fetchStatus: async () => {
        calls.push('status');
        return status();
      },
      remint: async () => null,
      redirect: () => undefined,
      onState: (s) => states.push(s),
      ...over,
    };
  }

  it('schedules the first doc poll at 90 s, reads the API every 90 s for ten minutes, then raw every 45 s', async () => {
    const d = deps();
    const p = createPoller(cfg(), d);
    const docs = (): string[] => d.calls.filter((c) => c.startsWith('doc:'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(docs()).toHaveLength(0);
    expect(d.calls).toContain('status');
    await vi.advanceTimersByTimeAsync(T.silent);
    expect(docs()).toEqual(['doc:api']);
    await vi.advanceTimersByTimeAsync(T.docEvery);
    // 45 s later nothing new: the API cadence is 90 s.
    expect(docs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(T.docEveryApi - T.docEvery);
    expect(docs()).toEqual(['doc:api', 'doc:api']);
    // Through the window: polls at 90, 180, ..., 540 s are the API; the next one (630 s) is raw, then 45 s apart.
    await vi.advanceTimersByTimeAsync(T.apiWindow + 40_000 - (T.silent + T.docEveryApi + 1_000));
    expect(docs()).toEqual([...Array<string>(6).fill('doc:api'), 'doc:raw']);
    expect(docs().filter((c) => c === 'doc:api').length).toBeLessThanOrEqual(7);
    await vi.advanceTimersByTimeAsync(T.docEvery);
    expect(docs().at(-1)).toBe('doc:raw');
    expect(docs()).toHaveLength(8);
    expect(p.state().phase).toBe('not_seen');
    p.stop();
  });

  it('visitors never touch the API', async () => {
    const d = deps();
    const p = createPoller(cfg({ mode: 'visitor', ownerHash: null }), d);
    await vi.advanceTimersByTimeAsync(T.visitorRetry + 10);
    expect(d.calls.filter((c) => c.startsWith('doc:'))).toEqual(['doc:raw', 'doc:raw']);
    p.stop();
  });

  it('moves to not_seen at 10 minutes without a fetch and to stale at 30', async () => {
    const d = deps();
    const p = createPoller(cfg(), d);
    await vi.advanceTimersByTimeAsync(T.notSeenAt + 10);
    expect(p.state().phase).toBe('not_seen');
    await vi.advanceTimersByTimeAsync(T.staleAt - T.notSeenAt);
    expect(p.state().phase).toBe('stale');
    const before = d.calls.filter((c) => c.startsWith('doc:')).length;
    await vi.advanceTimersByTimeAsync(T.docEveryStale * 2);
    expect(d.calls.filter((c) => c.startsWith('doc:')).length).toBe(before + 2);
    expect(d.calls.filter((c) => c.startsWith('doc:')).slice(-2)).toEqual(['doc:raw', 'doc:raw']);
    p.stop();
  });

  it('after the doc arrives it polls the manifest every 60 s and the rank shard on a new build', async () => {
    let build = 'b1';
    const d = deps({
      fetchDoc: async () => analyzed(),
      fetchManifest: async () => ({ build_id: build }),
      fetchRank: async () => entry(0, 2),
    });
    const p = createPoller(cfg({ submittedAt: -T.silent }), d);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state().phase).toBe('placing');
    const rankCalls = (): number => d.states.filter((s) => s.rankBuildId !== null).length;
    expect(rankCalls()).toBeGreaterThan(0);
    build = 'b2';
    d.fetchRank = async () => entry(1, 8, true, 1);
    await vi.advanceTimersByTimeAsync(T.manifestEvery + 10);
    expect(p.state().phase).toBe('rated');
    expect(p.state().done).toBe(true);
    p.stop();
  });

  it('retries a failed doc fetch after 60 s', async () => {
    let fails = 1;
    const d = deps({
      fetchDoc: async () => {
        if (fails-- > 0) throw new Error('boom');
        return null;
      },
    });
    const p = createPoller(cfg({ submittedAt: -T.silent }), d);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state().due.doc).toBeGreaterThanOrEqual(T.errorRetry);
    expect(p.state().due.doc).toBeLessThanOrEqual(T.errorRetry + 10);
    await vi.advanceTimersByTimeAsync(T.errorRetry + 10);
    expect(p.state().misses).toBe(1);
    p.stop();
  });
});
