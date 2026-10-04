// Arena behaviour (§11.5): local shuffle, skip seen, hide own entries, streak logic. Pure.
import { CATEGORIES, type ArenaPair, type Category } from '@resumearena/shared';
import type { ArenaState } from './storage.ts';

export type Guess = 'A' | 'B' | 'draw';

export function shuffle<T>(arr: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export interface QueueOptions {
  seen: readonly string[];
  /** Ids this browser submitted; pairs touching them are hidden so nobody guesses on their own resume. */
  ownIds: ReadonlySet<string>;
  rng?: () => number;
}

/** Pairs still worth showing, shuffled. Seen pairs come back only when everything else is exhausted. */
export function prepareQueue(pairs: readonly ArenaPair[], opts: QueueOptions): { fresh: ArenaPair[]; exhausted: boolean } {
  const seen = new Set(opts.seen);
  const visible = pairs.filter((p) => !opts.ownIds.has(p.a.id) && !opts.ownIds.has(p.b.id));
  const fresh = shuffle(
    visible.filter((p) => !seen.has(p.m)),
    opts.rng,
  );
  return { fresh, exhausted: fresh.length === 0 && visible.length > 0 };
}

export const MIN_PAIRS = 20;

export function applyGuess(state: ArenaState, pair: ArenaPair, guess: Guess): { state: ArenaState; agreed: boolean } {
  const agreed = guess === pair.w;
  const next: ArenaState = {
    ...state,
    guesses: state.guesses + 1,
    agreed: state.agreed + (agreed ? 1 : 0),
    streak: agreed ? state.streak + 1 : 0,
    disagreeRun: agreed ? 0 : state.disagreeRun + 1,
    seen: [...state.seen, pair.m].slice(-300),
  };
  next.best = Math.max(next.best, next.streak);
  return { state: next, agreed };
}

export function markSeen(state: ArenaState, matchId: string): ArenaState {
  return { ...state, seen: [...state.seen, matchId].slice(-300) };
}

/** Default category rotates per visit so the rotation is actually a rotation. */
export function nextCategory(last: Category | null): Category {
  if (!last) return 'general';
  const i = CATEGORIES.indexOf(last);
  return CATEGORIES[(i + 1) % CATEGORIES.length] ?? 'general';
}

export const agreementPct = (s: ArenaState): number | null => (s.guesses >= 20 ? s.agreed / s.guesses : null);
