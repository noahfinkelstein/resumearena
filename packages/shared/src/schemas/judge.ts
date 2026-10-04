// Zod mirror of judge.schema.json (§5.3, §5.4). Forced choice; the draw comes from disagreement across orderings.
import { z } from 'zod';
import { cappedString, clampedNumber, noteRepair, parseWithRepairs, type ParseResult } from './repair.ts';

export const PairwiseVerdictZ = z.object({
  winner: z.enum(['first', 'second']),
  confidence: clampedNumber(0.5, 1),
  decisive_factors: z.array(cappedString(60)).transform((a) => {
    if (a.length === 0) {
      noteRepair();
      return ['(none given)'];
    }
    if (a.length > 3) {
      noteRepair();
      return a.slice(0, 3);
    }
    return a;
  }),
  reasoning: cappedString(200),
});

export type PairwiseVerdict = z.output<typeof PairwiseVerdictZ>;

export const parsePairwiseVerdict = (input: unknown): ParseResult<PairwiseVerdict> => parseWithRepairs(PairwiseVerdictZ, input);
