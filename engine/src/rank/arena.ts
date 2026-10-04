// The arena pool (D-17): newest ≤ 80 refine/crosscheck matches between two user rows per category.
import type { ArenaPair, ArenaPool, Card, CareerStage, MatchLine } from '@resumearena/shared';

export interface ArenaSideInput {
  id: string;
  card: Card;
  stage: CareerStage;
  r_before: number;
  r_after: number;
}

/** `first`/`second` → `A`/`B` so the reveal reads naturally against the shuffled cards. */
export function rewriteReason(reasoning: string): string {
  return reasoning.replace(/\bFirst\b/g, 'A').replace(/\bfirst\b/g, 'A').replace(/\bSecond\b/g, 'B').replace(/\bsecond\b/g, 'B');
}

export function arenaPairFrom(line: MatchLine, a: ArenaSideInput, b: ArenaSideInput): ArenaPair {
  return {
    m: line.id,
    at: line.at,
    kind: line.kind,
    a: { id: a.id, card: a.card, stage: a.stage, r_before: Math.round(a.r_before), delta: Math.round(a.r_after - a.r_before) },
    b: { id: b.id, card: b.card, stage: b.stage, r_before: Math.round(b.r_before), delta: Math.round(b.r_after - b.r_before) },
    w: line.o === 1 ? 'A' : line.o === 0 ? 'B' : 'draw',
    c: Math.round(((line.p1.confidence + line.p2.confidence) / 2) * 100) / 100,
    reason: rewriteReason(line.p1.reasoning),
  };
}

export const isArenaKind = (kind: MatchLine['kind']): boolean => kind === 'refine' || kind === 'crosscheck';

/** Prepend new pairs, drop pairs whose ids are no longer eligible, trim to the cap. */
export function updateArena(pool: ArenaPool, fresh: ArenaPair[], eligible: (id: string) => boolean, cap: number, now: string): ArenaPool {
  const seen = new Set<string>();
  const pairs = [...fresh, ...pool.pairs].filter((p) => {
    if (seen.has(p.m)) return false;
    seen.add(p.m);
    return eligible(p.a.id) && eligible(p.b.id);
  });
  return { schema: 1, category: pool.category, updated_at: now, pairs: pairs.slice(0, cap) };
}
