// GitHub REST access (§9.1). Enabled only with RA_ENV=production and a token; otherwise every call
// warns once and returns null so local runs and tests never touch the network.
import type { Env } from '../env.ts';
import type { Logger } from '../summary.ts';

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface GithubClient {
  readonly enabled: boolean;
  readonly repo: string;
  /** JSON response or null when disabled or on a non-2xx (logged). */
  request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null>;
}

export class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, text: string) {
    super(`GitHub API ${status} for ${path}: ${text.slice(0, 200)}`);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

export function createGithub(env: Env, opts: { fetch?: FetchLike; log?: Logger; force?: boolean } = {}): GithubClient {
  const enabled = opts.force === true || (env.raEnv === 'production' && !!env.githubToken);
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
  let warned = false;
  return {
    enabled,
    repo: env.repo,
    async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
      if (!enabled) {
        if (!warned) {
          opts.log?.warn(`GitHub API skipped (RA_ENV=${env.raEnv}${env.githubToken ? '' : ', no GITHUB_TOKEN'}): ${method} ${path}`);
          warned = true;
        }
        return null;
      }
      const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'resumearena-engine',
        ...(env.githubToken ? { Authorization: `Bearer ${env.githubToken}` } : {}),
      };
      const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetchImpl(url, init);
      if (!res.ok) {
        opts.log?.warn(new GithubApiError(res.status, path, await res.text().catch(() => '')).message);
        return null;
      }
      if (res.status === 204) return {} as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    },
  };
}

export const repoPath = (gh: GithubClient, rest: string): string => `/repos/${gh.repo}${rest}`;
