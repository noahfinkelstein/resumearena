// The single validation path (§7.4): both adapters produce a SubmissionPayload and come through here.
import { readFile } from 'node:fs/promises';
import { normalizePayload, type NormalizeResult, type PayloadError, type SubmissionInput, type SubmissionPayload, type SubmissionSource } from '@resumearena/shared';
import { fromDispatch, isDispatchEvent, type DispatchEvent } from './dispatch.ts';
import { fromIssue, isIssueEvent, isSubmissionIssue, type IssueEvent } from './issue.ts';

export class SubmissionError extends Error {
  readonly code: PayloadError['code'];
  readonly field: PayloadError['field'];
  constructor(err: PayloadError) {
    super(`${err.code}: ${err.message}`);
    this.name = 'SubmissionError';
    this.code = err.code;
    this.field = err.field;
  }
}

export interface AdaptedEvent {
  payload: SubmissionPayload;
  source: SubmissionSource;
  /** Present on the Issue path so the command can comment, label, close and lock. */
  issue: IssueEvent['issue'] | null;
}

export const normalize = (payload: SubmissionPayload, source: SubmissionSource): Promise<NormalizeResult> => normalizePayload(payload, source);

/** Throwing variant for callers that prefer exceptions. */
export async function normalizeOrThrow(payload: SubmissionPayload, source: SubmissionSource): Promise<SubmissionInput> {
  const r = await normalizePayload(payload, source);
  if (!r.ok) throw new SubmissionError(r);
  return r.input;
}

export type EventKind = 'dispatch' | 'issue' | 'ignored';

/** Read `$GITHUB_EVENT_PATH` and route by shape; issues without the form labels are ignored. */
export async function readEvent(path: string, runId: number): Promise<{ kind: 'ignored'; reason: string } | ({ kind: 'dispatch' | 'issue' } & AdaptedEvent)> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (isIssueEvent(raw)) {
    if (!isSubmissionIssue(raw)) return { kind: 'ignored', reason: 'issue without ra:submission/ra:delete label' };
    const adapted = fromIssue(raw, runId);
    return { kind: 'issue', payload: adapted.payload, source: adapted.source, issue: raw.issue };
  }
  if (isDispatchEvent(raw)) {
    const adapted = fromDispatch(raw as DispatchEvent, runId);
    return { kind: 'dispatch', payload: adapted.payload, source: adapted.source, issue: null };
  }
  return { kind: 'ignored', reason: 'event has neither inputs nor issue' };
}
