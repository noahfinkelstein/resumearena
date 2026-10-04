// The Issue path's bookkeeping (platform-github.md §C.6): comment, label, close, lock, redact the key line.
import { PAGES_BASE } from '@resumearena/shared';
import { repoPath, type GithubClient } from './api.ts';
import { LABEL_FAILED, LABEL_PROCESSED, LABEL_SUBMISSION, LABEL_DELETE } from '../adapters/issue.ts';

export async function commentIssue(gh: GithubClient, number: number, body: string): Promise<void> {
  await gh.request('POST', repoPath(gh, `/issues/${number}/comments`), { body });
}

export async function addLabels(gh: GithubClient, number: number, labels: string[]): Promise<void> {
  await gh.request('POST', repoPath(gh, `/issues/${number}/labels`), { labels });
}

export async function removeLabel(gh: GithubClient, number: number, label: string): Promise<void> {
  await gh.request('DELETE', repoPath(gh, `/issues/${number}/labels/${encodeURIComponent(label)}`));
}

export async function closeIssue(gh: GithubClient, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
  await gh.request('PATCH', repoPath(gh, `/issues/${number}`), { state: 'closed', state_reason: reason });
}

export async function lockIssue(gh: GithubClient, number: number, reason: 'resolved' | 'off-topic' = 'resolved'): Promise<void> {
  await gh.request('PUT', repoPath(gh, `/issues/${number}/lock`), { lock_reason: reason });
}

export async function editIssueBody(gh: GithubClient, number: number, body: string): Promise<void> {
  await gh.request('PATCH', repoPath(gh, `/issues/${number}`), { body });
}

export const resultUrl = (id: string): string => `${PAGES_BASE}/r/${id}`;

export async function acknowledgeIssue(gh: GithubClient, number: number, id: string): Promise<void> {
  await commentIssue(gh, number, `Received. The entry will appear at ${resultUrl(id)} in a few minutes. This issue closes automatically.`);
}

/** Success path: label processed, say what happened, close, lock. */
export async function finishIssue(gh: GithubClient, number: number, statusLine: string, wasDelete: boolean): Promise<void> {
  await addLabels(gh, number, [LABEL_PROCESSED]);
  await removeLabel(gh, number, wasDelete ? LABEL_DELETE : LABEL_SUBMISSION);
  await commentIssue(gh, number, `Done: ${statusLine}`);
  await closeIssue(gh, number, 'completed');
  await lockIssue(gh, number);
}

/** Failure path: label failed, say why, close and lock, so a redacted key line cannot be edited back in. */
export async function failIssue(gh: GithubClient, number: number, code: string): Promise<void> {
  await addLabels(gh, number, [LABEL_FAILED]);
  await commentIssue(gh, number, `The run failed: ${code}. Nothing was recorded. Open a new issue to retry, or wait for the direct channel.`);
  await closeIssue(gh, number, 'not_planned');
  await lockIssue(gh, number);
}
