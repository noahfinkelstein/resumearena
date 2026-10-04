// The fold (§9.4): ratings are a deterministic function of the match log. Single-game periods update
// both sides from the line's `pre`; placement/revision periods give the subject one m-game period and
// each opponent a one-game update against the subject's pre-period values. The opposing side's values
// always come from the line, never from current rows; a row's own starting point is the line's `pre`
// unless an earlier line of the same wave already moved it, in which case its games chain (F04).
import { glickoUpdate, seedDomain, type HistoryPoint, type MatchLine, type PeriodGame, type RatingRow, type RecentMatch } from '@resumearena/shared';
import { invalidate, roundsSpecFor, type CatState, type EngineState } from './state.ts';
import { pushPoint, pushRecent } from './history.ts';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const isPeriodKind = (kind: MatchLine['kind']): boolean => kind === 'placement' || kind === 'revision';

/** Consecutive lines with the same period form one rating period. */
export function groupByPeriod(lines: readonly MatchLine[]): MatchLine[][] {
  const groups: MatchLine[][] = [];
  let current: MatchLine[] = [];
  for (const line of lines) {
    const prev = current[current.length - 1];
    if (prev && (prev.period !== line.period || prev.cat !== line.cat)) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups;
}

interface Start {
  r: number;
  rd: number;
}

const waveKeyOf = (line: MatchLine): string => `${line.run}|${line.wave}`;
const movedKey = (cs: CatState, id: string): string => `${cs.cat}:${id}`;

/** A new (run, wave) starts a fresh set of moved rows; a wave is always folded whole and in log order. */
function enterWave(state: EngineState, line: MatchLine): void {
  const k = waveKeyOf(line);
  if (state.waveMoved.key !== k) {
    state.waveMoved.key = k;
    state.waveMoved.ids.clear();
  }
}

/**
 * Where a row's update starts: the plan-time `pre` from the line, or the row's current rating when an
 * earlier line of this wave already moved it. All lines of a wave are planned before any is judged, so a
 * shared opponent carries the same `pre` in every line; applying each from `pre` would keep only the last game.
 */
function startOf(state: EngineState, cs: CatState, row: RatingRow, linePre: Start): Start {
  return row.r !== null && state.waveMoved.ids.has(movedKey(cs, row.id)) ? { r: row.r, rd: row.rd } : linePre;
}

/** One rating-period update for a present, unlocked row; returns false when the row does not move. */
function moveRow(state: EngineState, cs: CatState, row: RatingRow, linePre: Start, games: readonly { oppR: number; oppRd: number; score: number }[]): boolean {
  if (row.locked || row.r === null) return false;
  const start = startOf(state, cs, row, linePre);
  const upd = glickoUpdate(start.r, start.rd, games, state.settings.rating.rd_floor);
  row.r = upd.r;
  row.rd = upd.rd;
  state.waveMoved.ids.add(movedKey(cs, row.id));
  return true;
}

function sideOf(line: MatchLine, id: string): { pre: { r: number; rd: number }; score: number; oppId: string; oppPre: { r: number; rd: number } } | null {
  if (line.a === id) return { pre: { r: line.pre.ar, rd: line.pre.ard }, score: line.o, oppId: line.b, oppPre: { r: line.pre.br, rd: line.pre.brd } };
  if (line.b === id) return { pre: { r: line.pre.br, rd: line.pre.brd }, score: 1 - line.o, oppId: line.a, oppPre: { r: line.pre.ar, rd: line.pre.ard } };
  return null;
}

/** Record-keeping that every match does for a present row, locked or not. */
async function sideEffects(state: EngineState, cs: CatState, row: RatingRow, line: MatchLine, score: number, oppId: string, oppR: number, dr: number, point: HistoryPoint | null): Promise<void> {
  row.g++;
  if (score === 1) row.w++;
  else if (score === 0) row.l++;
  else row.d++;
  row.last = line.at;
  if (row.r !== null && row.r > row.peak) {
    row.peak = row.r;
    row.peak_at = line.at.slice(0, 10);
  }
  const snapshot = row.days[row.days.length - 1];
  row.mv = snapshot && row.r !== null ? round2(Math.abs(row.r - snapshot[1])) : 0;
  row.opp = [...row.opp.filter((o) => o !== oppId), oppId].slice(-10);
  if (row.kind === 'anchor') return;
  const doc = await state.history.get(cs.cat, row.id, row.lin);
  doc.lin = row.lin;
  if (point) pushPoint(doc, point);
  const recent: RecentMatch = { m: line.id, at: line.at, o: score === 1 ? 'W' : score === 0 ? 'L' : 'D', opp: oppId, opp_r: oppR, dr: round2(dr), note: line.p1.reasoning, k: line.kind };
  pushRecent(doc, recent, state.settings.retention.history_recent);
  state.history.touch(cs.cat, row.id);
}

/** When the general row places, domain rows waiting on it are seeded (§9.4 step 6, §6.2). */
export function seedWaitingDomains(state: EngineState, id: string): string[] {
  const general = state.cats.general.rows.get(id);
  if (!general || !general.placed || general.r === null) return [];
  const seeded: string[] = [];
  for (const cat of ['finance', 'tech', 'academia'] as const) {
    const row = state.cats[cat].rows.get(id);
    if (!row || row.round !== -1 || !row.elig) continue;
    row.r = seedDomain(general.r, row.score);
    row.seed = row.r;
    row.rd = state.settings.rating.rd_initial_domain;
    row.round = 0;
    row.peak = row.r;
    row.peak_at = general.last ? general.last.slice(0, 10) : row.created.slice(0, 10);
    invalidate(state.cats[cat]);
    seeded.push(cat);
  }
  return seeded;
}

async function applySingle(state: EngineState, cs: CatState, line: MatchLine): Promise<void> {
  enterWave(state, line);
  const date = line.at.slice(0, 10);
  const a: Start = { r: line.pre.ar, rd: line.pre.ard };
  const b: Start = { r: line.pre.br, rd: line.pre.brd };
  for (const [id, own, score, oppId, opp] of [
    [line.a, a, line.o, line.b, b],
    [line.b, b, 1 - line.o, line.a, a],
  ] as const) {
    const row = cs.rows.get(id);
    if (!row) continue;
    const before = row.r ?? 0;
    moveRow(state, cs, row, own, [{ oppR: opp.r, oppRd: opp.rd, score }]);
    const dr = (row.r ?? before) - before;
    await sideEffects(state, cs, row, line, score, oppId, opp.r, dr, row.locked ? null : [date, row.r as number, row.rd, 'm']);
  }
}

async function applyPeriodGroup(state: EngineState, cs: CatState, group: MatchLine[]): Promise<void> {
  const first = group[0] as MatchLine;
  enterWave(state, first);
  const subjId = first.subj;
  const subjSide = sideOf(first, subjId);
  if (!subjSide) {
    // Malformed period (subject not on either side): treat each line as a single match.
    for (const line of group) await applySingle(state, cs, line);
    return;
  }
  const subjPre = subjSide.pre;
  const games: (PeriodGame & { line: MatchLine })[] = group.flatMap((line) => {
    const s = sideOf(line, subjId);
    if (!s) return [];
    const oppRow = cs.rows.get(s.oppId);
    return [{ oppId: s.oppId, oppR: s.oppPre.r, oppRd: s.oppPre.rd, score: s.score, locked: oppRow?.locked === true, line }];
  });
  const date = first.at.slice(0, 10);

  // Opponents: one-game updates against the subject's pre-period values.
  for (const game of games) {
    const row = cs.rows.get(game.oppId);
    if (!row) continue;
    const before = row.r ?? 0;
    moveRow(state, cs, row, { r: game.oppR, rd: game.oppRd }, [{ oppR: subjPre.r, oppRd: subjPre.rd, score: 1 - game.score }]);
    await sideEffects(state, cs, row, game.line, 1 - game.score, subjId, subjPre.r, (row.r ?? before) - before, row.locked ? null : [date, row.r as number, row.rd, 'm']);
  }

  const key = `${cs.cat}:${subjId}`;
  const met = state.placementOpps.get(key) ?? new Set<string>();
  for (const g of games) met.add(g.oppId);
  state.placementOpps.set(key, met);
  const subject = cs.rows.get(subjId);
  if (!subject) return;
  const before = subject.r ?? subjPre.r;
  // The subject's one m-game period, every game at the opponents' plan-time values.
  moveRow(state, cs, subject, subjPre, games);
  const total = (subject.r ?? before) - before;
  // Share the period's delta across games by surprise, so each recent entry carries a sensible number.
  const surprises = games.map((g) => g.score - 1 / (1 + Math.pow(10, (-(subjPre.r - g.oppR)) / 400)));
  const sumAbs = surprises.reduce((a, s) => a + Math.abs(s), 0);
  for (let i = 0; i < games.length; i++) {
    const g = games[i] as (typeof games)[number];
    const share = sumAbs > 0 ? total * (Math.abs(surprises[i] as number) / sumAbs) * Math.sign(surprises[i] as number) * Math.sign(total || 1) : total / games.length;
    const isLast = i === games.length - 1;
    await sideEffects(state, cs, subject, g.line, g.score, g.oppId, g.oppR, share, isLast && !subject.locked ? [date, subject.r as number, subject.rd, first.kind === 'revision' ? 'v' : 'p'] : null);
  }
  const spec = roundsSpecFor(state.settings, cs.cat, subject);
  subject.round++;
  if (subject.round >= spec.length) {
    subject.placed = true;
    const doc = await state.history.get(cs.cat, subject.id, subject.lin);
    doc.placed = true;
    state.history.touch(cs.cat, subject.id);
    if (cs.cat === 'general') seedWaitingDomains(state, subject.id);
  }
}

/** One sparse-checkout add per category for every history doc these lines will touch (§9.2). */
export async function prefetchHistory(state: EngineState, lines: readonly MatchLine[]): Promise<void> {
  const byCat = new Map<MatchLine['cat'], Set<string>>();
  for (const l of lines) {
    const ids = byCat.get(l.cat) ?? new Set<string>();
    for (const id of [l.a, l.b]) if (!id.startsWith('anchr')) ids.add(id);
    byCat.set(l.cat, ids);
  }
  for (const [cat, ids] of byCat) await state.history.prefetch(cat, ids);
}

/** Apply lines in log order; the caller advances cursors. */
export async function applyLines(state: EngineState, lines: readonly MatchLine[]): Promise<number> {
  let applied = 0;
  await prefetchHistory(state, lines);
  for (const group of groupByPeriod(lines)) {
    const first = group[0] as MatchLine;
    const cs = state.cats[first.cat];
    if (state.ensureRow) {
      for (const id of new Set(group.flatMap((l) => [l.a, l.b]))) if (!cs.rows.has(id) && !id.startsWith('anchr')) await state.ensureRow(id);
    }
    if (isPeriodKind(first.kind)) await applyPeriodGroup(state, cs, group);
    else for (const line of group) await applySingle(state, cs, line);
    invalidate(cs);
    applied += group.length;
  }
  return applied;
}
