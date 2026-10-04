// Workflow-run queries: the hourly cap (§9.3 step 2) and the health counters in status.json (D-63).
import { isoOf, MS_PER_DAY, MS_PER_HOUR } from '../clock.ts';
import { repoPath, type GithubClient } from './api.ts';

interface RunsResponse {
  total_count: number;
}
interface WorkflowResponse {
  state: string;
}

const q = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

/** `total_count` of submit runs created in the last hour; null when the API is unavailable. */
export async function submissionsLastHour(gh: GithubClient, now: Date): Promise<number | null> {
  const created = `>=${isoOf(new Date(now.getTime() - MS_PER_HOUR))}`;
  const res = await gh.request<RunsResponse>('GET', `${repoPath(gh, '/actions/workflows/submit.yml/runs')}?${q({ created, per_page: '1' })}`);
  return res ? res.total_count : null;
}

export async function runsLast24h(gh: GithubClient, now: Date, status: 'failure' | 'cancelled'): Promise<number | null> {
  const created = `>=${isoOf(new Date(now.getTime() - MS_PER_DAY))}`;
  const res = await gh.request<RunsResponse>('GET', `${repoPath(gh, '/actions/runs')}?${q({ created, status, per_page: '1' })}`);
  return res ? res.total_count : null;
}

/** Submit runs by trigger in the last 24 h: issue path vs dispatch path. */
export async function submitPathCounts(gh: GithubClient, now: Date): Promise<{ issue: number; dispatch: number } | null> {
  const created = `>=${isoOf(new Date(now.getTime() - MS_PER_DAY))}`;
  const base = repoPath(gh, '/actions/workflows/submit.yml/runs');
  const [issue, dispatch] = await Promise.all([
    gh.request<RunsResponse>('GET', `${base}?${q({ created, event: 'issues', per_page: '1' })}`),
    gh.request<RunsResponse>('GET', `${base}?${q({ created, event: 'workflow_dispatch', per_page: '1' })}`),
  ]);
  if (!issue || !dispatch) return null;
  return { issue: issue.total_count, dispatch: dispatch.total_count };
}

export async function isWorkflowEnabled(gh: GithubClient, workflow: string): Promise<boolean | null> {
  const res = await gh.request<WorkflowResponse>('GET', repoPath(gh, `/actions/workflows/${workflow}`));
  return res ? res.state === 'active' : null;
}

/** D-57: every workflow re-enables the schedules; a failure here is logged, never fatal. */
export async function enableWorkflows(gh: GithubClient, workflows: string[] = ['rerank.yml', 'maintenance.yml']): Promise<void> {
  for (const w of workflows) await gh.request('PUT', repoPath(gh, `/actions/workflows/${w}/enable`));
}

export async function dispatchWorkflow(gh: GithubClient, workflow: string, inputs: Record<string, string>, ref = 'main'): Promise<boolean> {
  const res = await gh.request('POST', repoPath(gh, `/actions/workflows/${workflow}/dispatches`), { ref, inputs });
  return res !== null;
}
