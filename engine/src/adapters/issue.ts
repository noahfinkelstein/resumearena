// issues:opened → SubmissionPayload (§7.3–§7.4). Field ids are the Issue Form labels; the delete form has three.
import { parseIssueForm, payloadFromIssueFields, type SubmissionPayload, type SubmissionSource } from '@resumearena/shared';

export interface IssueEvent {
  action?: string;
  issue: { number: number; node_id: string; body: string | null; labels: { name: string }[]; user: { login: string }; title?: string };
}

export const LABEL_SUBMISSION = 'ra:submission';
export const LABEL_DELETE = 'ra:delete';
export const LABEL_PROCESSED = 'ra:processed';
export const LABEL_FAILED = 'ra:failed';

export function isIssueEvent(raw: unknown): raw is IssueEvent {
  const e = raw as IssueEvent;
  return !!e && typeof e === 'object' && !!e.issue && typeof e.issue.number === 'number' && Array.isArray(e.issue.labels);
}

export const hasLabel = (event: IssueEvent, name: string): boolean => event.issue.labels.some((l) => l.name === name);

export const isSubmissionIssue = (event: IssueEvent): boolean => hasLabel(event, LABEL_SUBMISSION) || hasLabel(event, LABEL_DELETE);

export function fromIssue(event: IssueEvent, runId: number): { payload: SubmissionPayload; source: SubmissionSource } {
  const fields = parseIssueForm(event.issue.body ?? '');
  const isDelete = hasLabel(event, LABEL_DELETE);
  const payload = payloadFromIssueFields(fields, isDelete);
  return {
    payload,
    source: { kind: 'issue', run_id: runId, issue_number: event.issue.number, client_version: payload.client_version, author: event.issue.user.login, node_id: event.issue.node_id },
  };
}

/** The delete form body with the key value replaced, for `gh issue edit --body` before anything else (§7.4). */
export function redactOwnerKeyLine(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const idx = lines.findIndex((l) => /^### owner_key\s*$/.test(l));
  if (idx === -1) return body;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('### ')) break;
    if (line.trim() !== '') lines[i] = '[redacted]';
  }
  return lines.join('\n');
}
