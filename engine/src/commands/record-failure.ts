// `record-failure --workflow <name> --run <id> [--event <path>]`: one line in failures/<day>.jsonl (§3.3).
import { readFile } from 'node:fs/promises';
import type { FailureLine } from '@resumearena/shared';
import type { Context } from '../context.ts';
import { appendLines } from '../store/commit.ts';
import { failuresPath } from '../store/paths.ts';

export interface RecordFailureArgs {
  workflow: string;
  run: string;
  event?: string;
  step?: string;
  code?: string;
}

export async function refFromEvent(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { inputs?: { submission_id?: string }; issue?: { number?: number } };
    if (raw.inputs?.submission_id) return raw.inputs.submission_id;
    if (raw.issue?.number) return `issue#${raw.issue.number}`;
  } catch {
    // An unreadable event is not a reason to lose the failure line.
  }
  return null;
}

export async function recordFailure(ctx: Context, args: RecordFailureArgs): Promise<FailureLine> {
  const ref = await refFromEvent(args.event);
  const line: FailureLine = { t: ctx.clock.iso(), wf: args.workflow, run: args.run, step: args.step ?? 'run', code: args.code ?? 'failed', ...(ref ? { ref } : {}) };
  await ctx.commit(`failure ${args.workflow} ${args.run}`, [appendLines(failuresPath(ctx.clock.day()), [line])]);
  return line;
}
