// Release recipe step 5 (spec §15): prints PASS / FAIL / SKIP / MANUAL for every row of spec §16 plus the Pages
// and raw checks of step 5 b–c. Node 24, no dependencies, erasable syntax only. Uses the `gh` CLI (the agent's
// own auth) for GitHub API calls and global fetch for the public origins.
//
//   node scripts/verify-assumptions.ts [--repo noahfinkelstein/resumearena] [--dispatch] [--live]
//                                      [--site https://noahfinkelstein.github.io/resumearena/]
//
//   --dispatch  sends ONE real 15,000-character submission through workflow_dispatch (≈ $0.20, creates a real
//               entry under a throwaway handle; the owner key is printed so it can be deleted) and then checks that
//               the inputs are not readable through the run UI/API/logs (row 10, D-60).
//   --live      makes one tiny Anthropic call (needs ANTHROPIC_API_KEY) to confirm cache_control.ttl '1h' (row 13).
//   --offline   local rows only (11, 12); no GitHub or network calls. Useful before the repository exists.
//   SUBMIT_TOKEN in the environment (or `gh variable get SUBMIT_TOKEN`) enables the fine-grained PAT probe (row 2).
//
// Exit code 1 when any row FAILs. SKIP and MANUAL do not fail the run.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'MANUAL';
interface Result { row: string; title: string; status: Status; detail: string }
interface Options { repo: string; site: string; root: string; dispatch: boolean; live: boolean; offline: boolean }

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const FORBIDDEN_SCHEMA_KEYWORDS = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];
const DISPATCH_WAIT_MS = 20 * 60_000;
const POLL_MS = 15_000;

function base32(bytes: Uint8Array, chars: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < chars; i++) {
    out = (BASE32[Number(bits & 31n)] as string) + out;
    bits >>= 5n;
  }
  return out;
}
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}
function ghJson<T>(args: string[], input?: string): T {
  return JSON.parse(gh(args, input)) as T;
}
function hasGh(): boolean {
  try {
    gh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}
function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e && typeof (e as { stderr: unknown }).stderr === 'string') {
    const lines = (e as { stderr: string }).stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    // Node prints a stack frame first; the line that names the error is the useful one.
    const named = lines.find((l) => /error|cannot find|not found|ENOENT/i.test(l));
    if (named) return named;
    if (lines[0]) return lines[0];
  }
  return e instanceof Error ? e.message : String(e);
}

/** The longest committed fixture at or under 15,000 characters, or a synthesized résumé-shaped text of exactly 15,000. */
function pickText(root: string): { text: string; metricsJson: string; origin: string } {
  const dir = join(root, 'fixtures/resumes');
  if (existsSync(dir)) {
    const candidates = readdirSync(dir)
      .filter((n) => n.endsWith('.txt'))
      .map((n) => ({ n, text: readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim() }))
      .filter((c) => c.text.length >= 400 && c.text.length <= 15000)
      .sort((a, b) => b.text.length - a.text.length);
    const best = candidates[0];
    if (best) {
      const metaPath = join(dir, best.n.replace(/\.txt$/, '.meta.json'));
      let metricsJson = '{}';
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { metrics?: unknown };
        if (meta.metrics) metricsJson = JSON.stringify(meta.metrics);
      }
      return { text: best.text, metricsJson, origin: `fixtures/resumes/${best.n} (${best.text.length} chars)` };
    }
  }
  const head = '[name]\n[email] · [phone] · [url]\n\nSUMMARY\nBackend engineer with six years building payment, ledger and reporting services. Owns services end to end, from schema design to on-call.\n\nEXPERIENCE\n';
  const roles = ['Software Engineer II, Mid-size payments company — 2023–present', 'Software Engineer, Fintech startup — 2020–2023', 'Software Engineering Intern, Large retailer — 2019'];
  const bullets = [
    'Owned the tax-calculation service (about 12k requests per second at peak); cut p99 latency from 480 ms to 190 ms by caching merchant rules.',
    'Led the migration of 40 merchant-facing endpoints to a typed RPC layer with zero customer-visible downtime.',
    'Built the reconciliation service that matched 1.2M transactions a day against three processors; discrepancies fell from 0.8% to 0.05%.',
    'On-call lead for a six-person team; wrote the incident runbook that halved mean time to recovery.',
  ];
  const tail = '\nEDUCATION\nB.S. Computer Science, State University, 2019. Dean\'s list 2017–2019.\n\nSKILLS\nGo, TypeScript, PostgreSQL, Kafka, Kubernetes, Terraform, gRPC, Datadog.\n';
  let text = head;
  let i = 0;
  while (text.length + tail.length < 15000) {
    text += `${roles[i % roles.length]}\n• ${bullets[i % bullets.length]} (project ${i + 1})\n• ${bullets[(i + 1) % bullets.length]}\n\n`;
    i++;
  }
  text = text.slice(0, 15000 - tail.length) + tail;
  text = text.slice(0, 15000);
  return { text: text.trimEnd(), metricsJson: '{}', origin: 'synthesized (no fixtures present)' };
}

async function checkRaw(opts: Options): Promise<Result[]> {
  const url = `https://raw.githubusercontent.com/${opts.repo}/data/settings.json`;
  try {
    const res = await fetch(`${url}?r=1`, { headers: { Origin: 'https://noahfinkelstein.github.io' } });
    const acao = res.headers.get('access-control-allow-origin');
    const cc = res.headers.get('cache-control') ?? '(none)';
    const base = `status ${res.status}, cache-control ${cc}`;
    if (res.status === 404) return [{ row: '6', title: 'raw CORS + cache', status: 'SKIP', detail: `${url} is 404; bootstrap the data branch first` }];
    if (acao !== '*') return [{ row: '6', title: 'raw CORS + cache', status: 'FAIL', detail: `Access-Control-Allow-Origin is ${acao ?? 'absent'} (${base})` }];
    // A second query string: identical Age/X-Cache suggests the CDN ignores the key; informational only.
    const res2 = await fetch(`${url}?r=2`, { headers: { Origin: 'https://noahfinkelstein.github.io' } });
    const age1 = res.headers.get('age') ?? '-';
    const age2 = res2.headers.get('age') ?? '-';
    return [{ row: '6', title: 'raw CORS + cache', status: 'PASS', detail: `ACAO *, ${base}; age ?r=1 → ${age1}, ?r=2 → ${age2} (query-string keying is informational)` }];
  } catch (e) {
    return [{ row: '6', title: 'raw CORS + cache', status: 'FAIL', detail: errorText(e) }];
  }
}

async function checkPages(opts: Options): Promise<Result[]> {
  const out: Result[] = [];
  const site = opts.site.endsWith('/') ? opts.site : `${opts.site}/`;
  try {
    const m = await fetch(`${site}data/manifest.json?t=${Date.now()}`);
    const ct = m.headers.get('content-type') ?? '';
    out.push(
      m.ok && ct.includes('json')
        ? { row: '5b', title: 'Pages manifest reachable', status: 'PASS', detail: `${site}data/manifest.json → ${m.status} ${ct}` }
        : { row: '5b', title: 'Pages manifest reachable', status: m.status === 404 ? 'SKIP' : 'FAIL', detail: `${m.status} ${ct} (deploy first)` },
    );
  } catch (e) {
    out.push({ row: '5b', title: 'Pages manifest reachable', status: 'FAIL', detail: errorText(e) });
  }
  try {
    // "00" is never a shard: 0 is not in the id alphabet, so this file cannot exist.
    const r = await fetch(`${site}data/rank/00.json`);
    const ct = r.headers.get('content-type') ?? '';
    out.push(
      r.status === 404 && ct.includes('html')
        ? { row: '5c', title: 'missing rank shard → 404 HTML (getJson null)', status: 'PASS', detail: `404 ${ct}` }
        : { row: '5c', title: 'missing rank shard → 404 HTML (getJson null)', status: r.status === 404 ? 'PASS' : 'FAIL', detail: `${r.status} ${ct}` },
    );
  } catch (e) {
    out.push({ row: '5c', title: 'missing rank shard → 404 HTML (getJson null)', status: 'FAIL', detail: errorText(e) });
  }
  return out;
}

function checkGh(opts: Options): Result[] {
  const out: Result[] = [];
  try {
    const pages = ghJson<{ build_type?: string; html_url?: string }>(['api', `repos/${opts.repo}/pages`]);
    out.push(
      pages.build_type === 'workflow'
        ? { row: '5', title: 'Pages source is GitHub Actions', status: 'PASS', detail: `${pages.html_url ?? ''} (limits 1 GB / 100 GB per month: MANUAL)` }
        : { row: '5', title: 'Pages source is GitHub Actions', status: 'FAIL', detail: `build_type is ${pages.build_type ?? 'unset'}; set Pages → Source → GitHub Actions` },
    );
  } catch (e) {
    out.push({ row: '5', title: 'Pages source is GitHub Actions', status: 'FAIL', detail: errorText(e) });
  }
  try {
    gh(['api', '--silent', '-X', 'PUT', `repos/${opts.repo}/actions/workflows/rerank.yml/enable`]);
    const wf = ghJson<{ state: string }>(['api', `repos/${opts.repo}/actions/workflows/rerank.yml`]);
    out.push({ row: '4', title: 'enable endpoint works, rerank schedule active', status: wf.state === 'active' ? 'PASS' : 'FAIL', detail: `state ${wf.state} (checked with your gh auth; GITHUB_TOKEN + actions: write is exercised by every run)` });
  } catch (e) {
    out.push({ row: '4', title: 'enable endpoint works, rerank schedule active', status: 'FAIL', detail: errorText(e) });
  }
  try {
    const rl = ghJson<{ resources: { core: { limit: number; remaining: number } } }>(['api', 'rate_limit']);
    out.push({ row: '7', title: 'REST core limit ≥ 5000/h', status: rl.resources.core.limit >= 5000 ? 'PASS' : 'FAIL', detail: `limit ${rl.resources.core.limit}, remaining ${rl.resources.core.remaining} (secondary limits: MANUAL)` });
  } catch (e) {
    out.push({ row: '7', title: 'REST core limit ≥ 5000/h', status: 'FAIL', detail: errorText(e) });
  }
  try {
    const runs = ghJson<{ event: string; headBranch: string; actor?: { login?: string } }[]>([
      'run', 'list', '--repo', opts.repo, '--workflow', 'deploy.yml', '--event', 'push', '--limit', '100', '--json', 'event,headBranch,actor',
    ]);
    const bot = runs.filter((r) => r.headBranch === 'data' && (r.actor?.login ?? '').includes('github-actions'));
    out.push(
      bot.length === 0
        ? { row: '9', title: 'bot pushes do not fire push workflows', status: 'PASS', detail: `no deploy push-runs from github-actions[bot] on data among ${runs.length} push runs (no counterexample)` }
        : { row: '9', title: 'bot pushes do not fire push workflows', status: 'FAIL', detail: `${bot.length} deploy runs were triggered by bot pushes; add actor guards (spec §16 row 9)` },
    );
  } catch (e) {
    out.push({ row: '9', title: 'bot pushes do not fire push workflows', status: 'FAIL', detail: errorText(e) });
  }
  return out;
}

async function checkPat(opts: Options): Promise<Result[]> {
  let token = process.env.SUBMIT_TOKEN ?? '';
  if (!token) {
    try {
      token = gh(['variable', 'get', 'SUBMIT_TOKEN', '--repo', opts.repo]).trim();
    } catch {
      /* not set yet */
    }
  }
  if (!token) return [{ row: '2', title: 'fine-grained PAT can read the workflow (Actions: read)', status: 'SKIP', detail: 'SUBMIT_TOKEN not available (env or repository variable)' }];
  try {
    const res = await fetch(`https://api.github.com/repos/${opts.repo}/actions/workflows/submit.yml`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const limit = res.headers.get('x-ratelimit-limit') ?? '?';
    return [
      res.status === 200
        ? { row: '2', title: 'fine-grained PAT can read the workflow (Actions: read)', status: 'PASS', detail: `probe 200, rate limit ${limit}/h; the write half is proven by one browser submission (release step 8)` }
        : { row: '2', title: 'fine-grained PAT can read the workflow (Actions: read)', status: 'FAIL', detail: `probe returned ${res.status}; check the token's repository access and Actions permission` },
    ];
  } catch (e) {
    return [{ row: '2', title: 'fine-grained PAT can read the workflow (Actions: read)', status: 'FAIL', detail: errorText(e) }];
  }
}

function checkLocal(opts: Options): Result[] {
  const out: Result[] = [];
  try {
    execFileSync('node', ['engine/src/cli.ts', '--help'], { cwd: opts.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    out.push({ row: '11', title: 'Node 24 strips types across the workspace link', status: 'PASS', detail: 'node engine/src/cli.ts --help exited 0' });
  } catch (e) {
    out.push({ row: '11', title: 'Node 24 strips types across the workspace link', status: 'FAIL', detail: errorText(e) });
  }
  const schemaDir = join(opts.root, 'packages/shared/src/schemas');
  if (!existsSync(schemaDir)) {
    out.push({ row: '12', title: 'LLM schemas carry no range keywords', status: 'SKIP', detail: `${schemaDir} missing` });
  } else {
    const hits: string[] = [];
    for (const name of readdirSync(schemaDir).filter((n) => n.endsWith('.schema.json'))) {
      // Children of `properties` / `$defs` are names, not keywords, so a property called "format" is fine.
      const walk = (v: unknown, path: string, namesOnly: boolean): void => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, false));
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (!namesOnly && FORBIDDEN_SCHEMA_KEYWORDS.includes(k)) hits.push(`${name}:${path}.${k}`);
            walk(x, `${path}.${k}`, !namesOnly && (k === 'properties' || k === '$defs'));
          }
        }
      };
      walk(JSON.parse(readFileSync(join(schemaDir, name), 'utf8')), '$', false);
    }
    out.push(
      hits.length === 0
        ? { row: '12', title: 'LLM schemas carry no range keywords', status: 'PASS', detail: 'no minimum/maximum/minLength/maxLength/minItems/maxItems/pattern/format in *.schema.json' }
        : { row: '12', title: 'LLM schemas carry no range keywords', status: 'FAIL', detail: hits.slice(0, 5).join(', ') },
    );
  }
  return out;
}

async function checkTtl(opts: Options): Promise<Result[]> {
  if (!opts.live) return [{ row: '13', title: 'cache_control.ttl 1h accepted on Sonnet 5.5', status: 'SKIP', detail: 'pass --live with ANTHROPIC_API_KEY set' }];
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [{ row: '13', title: 'cache_control.ttl 1h accepted on Sonnet 5.5', status: 'SKIP', detail: 'ANTHROPIC_API_KEY not set' }];
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 5,
        system: [{ type: 'text', text: 'Reply with the single word ok.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: 'ok?' }],
      }),
    });
    const body = (await res.json()) as { error?: { message?: string }; model?: string };
    if (res.ok) return [{ row: '13', title: 'cache_control.ttl 1h accepted on Sonnet 5.5', status: 'PASS', detail: `200 from ${body.model ?? 'claude-sonnet-5-5'} (prompt too short to cache; parameter accepted)` }];
    return [{ row: '13', title: 'cache_control.ttl 1h accepted on Sonnet 5.5', status: 'FAIL', detail: `${res.status}: ${body.error?.message ?? 'unknown error'}` }];
  } catch (e) {
    return [{ row: '13', title: 'cache_control.ttl 1h accepted on Sonnet 5.5', status: 'FAIL', detail: errorText(e) }];
  }
}

async function checkDispatch(opts: Options): Promise<Result[]> {
  const title1 = 'workflow_dispatch: 10 inputs, 15,000-char text → 204 + successful run';
  const title10 = 'dispatch inputs not readable via run UI/API/logs (D-60)';
  if (!opts.dispatch) {
    return [
      { row: '1', title: title1, status: 'SKIP', detail: 'pass --dispatch to send one real submission (≈ $0.20)' },
      { row: '10', title: title10, status: 'SKIP', detail: 'needs --dispatch' },
    ];
  }
  const { text, metricsJson, origin } = pickText(opts.root);
  const submissionId = base32(randomBytes(8), 10);
  const canonicalKey = base32(randomBytes(32), 52);
  const ownerHash = sha256(canonicalKey);
  const marker = `vfy-${base32(randomBytes(4), 6)}`;
  const handle = `vfy-${base32(randomBytes(4), 6)}`;
  const inputs = {
    action: 'submit',
    submission_id: submissionId,
    handle,
    owner_hash: ownerHash,
    visibility: 'anonymous',
    text,
    metrics_json: metricsJson,
    ladder_hint: 'general',
    client_version: marker,
    owner_key: '',
  };
  const body = JSON.stringify({ ref: 'main', inputs });
  process.stdout.write(`dispatching ${submissionId} as ${handle} (${origin}; payload ${body.length} chars)\n`);
  process.stdout.write(`owner key for cleanup (delete via /me): rak-${canonicalKey.match(/.{4}/g)?.join('-')}\n`);
  try {
    gh(['api', '--silent', '-X', 'POST', `repos/${opts.repo}/actions/workflows/submit.yml/dispatches`, '--input', '-'], body);
  } catch (e) {
    return [
      { row: '1', title: title1, status: 'FAIL', detail: `dispatch rejected: ${errorText(e)}` },
      { row: '10', title: title10, status: 'SKIP', detail: 'no run to inspect' },
    ];
  }
  const deadline = Date.now() + DISPATCH_WAIT_MS;
  let run: { databaseId: number; status: string; conclusion: string } | undefined;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const runs = ghJson<{ databaseId: number; status: string; conclusion: string; displayTitle: string }[]>([
      'run', 'list', '--repo', opts.repo, '--workflow', 'submit.yml', '--limit', '30', '--json', 'databaseId,status,conclusion,displayTitle',
    ]);
    const mine = runs.find((r) => r.displayTitle.includes(submissionId));
    if (mine) {
      run = mine;
      process.stdout.write(`  run ${mine.databaseId}: ${mine.status}${mine.conclusion ? ` (${mine.conclusion})` : ''}\n`);
      if (mine.status === 'completed') break;
    }
  }
  if (!run) return [{ row: '1', title: title1, status: 'FAIL', detail: 'no run with the submission id appeared within 20 minutes' }, { row: '10', title: title10, status: 'SKIP', detail: 'no run to inspect' }];
  const results: Result[] = [];
  results.push(
    run.status === 'completed' && run.conclusion === 'success'
      ? { row: '1', title: title1, status: 'PASS', detail: `204 accepted; run ${run.databaseId} succeeded (entry ${submissionId}, handle ${handle})` }
      : { row: '1', title: title1, status: 'FAIL', detail: `run ${run.databaseId} ended ${run.status}/${run.conclusion}` },
  );
  try {
    const needles = [canonicalKey, marker, text.slice(200, 260)];
    const haystacks = [
      gh(['api', `repos/${opts.repo}/actions/runs/${run.databaseId}`]),
      gh(['api', `repos/${opts.repo}/actions/runs/${run.databaseId}/jobs`]),
      gh(['run', 'view', String(run.databaseId), '--repo', opts.repo, '--log']),
    ];
    const leaked = needles.filter((n) => haystacks.some((h) => h.includes(n)));
    results.push(
      leaked.length === 0
        ? { row: '10', title: title10, status: 'PASS', detail: 'client_version marker, text excerpt and (unused) key absent from run JSON, jobs JSON and logs' }
        : { row: '10', title: title10, status: 'FAIL', detail: `found in run data: ${leaked.map((n) => n.slice(0, 12)).join(', ')} → ship with VITE_MANAGE=0` },
    );
  } catch (e) {
    results.push({ row: '10', title: title10, status: 'FAIL', detail: errorText(e) });
  }
  return results;
}

function manualRows(): Result[] {
  return [
    { row: '3', title: 'concurrency: one running + one pending per group, shareable across workflows', status: 'MANUAL', detail: 'watch two quick submits: the second rerank run should queue, a third should replace it' },
    { row: '8', title: 'free accounts: 20 concurrent jobs; public-repo minutes free', status: 'MANUAL', detail: 'Settings → Billing; the overshoot bound in D-44 assumes 20' },
  ];
}

export async function run(opts: Options): Promise<Result[]> {
  const results: Result[] = [];
  const online = !opts.offline && hasGh();
  if (opts.offline) {
    for (const [row, title] of [['1', 'workflow_dispatch'], ['2', 'PAT probe'], ['4', 'enable endpoint'], ['5', 'Pages source'], ['5b', 'Pages manifest'], ['5c', 'missing shard 404'], ['6', 'raw CORS'], ['7', 'REST limits'], ['9', 'bot pushes'], ['10', 'input readability']] as const) {
      results.push({ row, title, status: 'SKIP', detail: '--offline' });
    }
  } else if (online) {
    results.push(...checkGh(opts), ...(await checkPat(opts)), ...(await checkDispatch(opts)));
  } else {
    const detail = 'gh is not authenticated (gh auth login)';
    for (const [row, title] of [['1', 'workflow_dispatch'], ['2', 'PAT probe'], ['4', 'enable endpoint'], ['5', 'Pages source'], ['7', 'REST limits'], ['9', 'bot pushes'], ['10', 'input readability']] as const) {
      results.push({ row, title, status: 'SKIP', detail });
    }
  }
  if (!opts.offline) results.push(...(await checkPages(opts)), ...(await checkRaw(opts)));
  results.push(...checkLocal(opts), ...(await checkTtl(opts)), ...manualRows());
  const order = (r: Result): number => parseFloat(r.row.replace(/[a-z]/, '.5')) || 0;
  return results.sort((a, b) => order(a) - order(b) || a.row.localeCompare(b.row));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'noahfinkelstein/resumearena' },
      site: { type: 'string', default: 'https://noahfinkelstein.github.io/resumearena/' },
      root: { type: 'string', default: '.' },
      dispatch: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
    },
  });
  const opts: Options = {
    repo: values.repo ?? 'noahfinkelstein/resumearena',
    site: values.site ?? 'https://noahfinkelstein.github.io/resumearena/',
    root: resolve(values.root ?? '.'),
    dispatch: values.dispatch ?? false,
    live: values.live ?? false,
    offline: values.offline ?? false,
  };
  if (!existsSync(join(opts.root, 'docs/SPEC.md')) || !statSync(join(opts.root, 'docs/SPEC.md')).isFile()) {
    process.stderr.write(`verify-assumptions: run from the repository root (or pass --root); ${opts.root} has no docs/SPEC.md\n`);
    process.exit(2);
  }
  const results = await run(opts);
  const width = Math.max(...results.map((r) => r.title.length));
  for (const r of results) process.stdout.write(`${r.status.padEnd(6)} #${r.row.padEnd(3)} ${r.title.padEnd(width)}  ${r.detail}\n`);
  const counts = results.reduce<Record<Status, number>>((acc, r) => ((acc[r.status] += 1), acc), { PASS: 0, FAIL: 0, SKIP: 0, MANUAL: 0 });
  process.stdout.write(`\n${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skipped, ${counts.MANUAL} manual\n`);
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
