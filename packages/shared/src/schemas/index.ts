// LLM output schemas: the JSON sent to the API verbatim (§5.1–§5.3) and their Zod mirrors (§5.4).
import analysisSchema from './analysis.schema.json' with { type: 'json' };
import gateSchema from './gate.schema.json' with { type: 'json' };
import judgeSchema from './judge.schema.json' with { type: 'json' };

export const ANALYSIS_SCHEMA = analysisSchema;
export const GATE_SCHEMA = gateSchema;
export const JUDGE_SCHEMA = judgeSchema;

export * from './analysis.ts';
export * from './gate.ts';
export * from './judge.ts';
export * from './data.ts';
export { truncateAtWord, parseWithRepairs, countRepairs, type ParseResult } from './repair.ts';
