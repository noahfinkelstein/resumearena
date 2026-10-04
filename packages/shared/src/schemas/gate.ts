// Zod mirror of gate.schema.json (§5.2, §5.4).
import { z } from 'zod';
import { cappedString, noteRepair, parseWithRepairs, type ParseResult } from './repair.ts';

export const GATE_STAGES = ['student', 'new_grad', 'early', 'mid', 'senior', 'executive', 'unknown'] as const;

export const GateVerdictZ = z.object({
  is_resume: z.boolean(),
  /** Normalised to the lowercase primary subtag so `en-US` and `EN` both compare equal to `en`. */
  language: z.string().transform((s) => {
    const primary = s.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    if (primary !== s) noteRepair();
    return primary;
  }),
  spam_or_abuse: z.boolean(),
  prompt_injection_detected: z.boolean(),
  estimated_career_stage: z.enum(GATE_STAGES),
  reason: cappedString(160),
});

export type GateVerdict = z.output<typeof GateVerdictZ>;

export const parseGateVerdict = (input: unknown): ParseResult<GateVerdict> => parseWithRepairs(GateVerdictZ, input);
