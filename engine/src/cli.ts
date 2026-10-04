#!/usr/bin/env node
// `node engine/src/cli.ts <command>` (§9.1). Exit 0 for every business outcome; 1 only for infrastructure failures.
import { createContext } from './context.ts';
import { isLlmMode, readEnv } from './env.ts';
import { submitCommand } from './commands/submit.ts';
import { runRerank } from './commands/rerank.ts';
import { buildIndexes } from './commands/build-indexes.ts';
import { maintenanceCommand } from './commands/maintenance.ts';
import { recordFailure } from './commands/record-failure.ts';
import { dataClone, dataInit } from './commands/data.ts';
import { fixturesGenerate, fixturesPayloadCommand, fixturesWebData } from './commands/fixtures.ts';
import { statusCommand } from './commands/status.ts';
import { createClock } from './clock.ts';
import { consoleLogger } from './summary.ts';

export const HELP = `resumearena engine

usage: node engine/src/cli.ts <command> [options]

  submit         --event <path> | --payload <json-path>   [--data <dir>] [--llm mock|live|record|replay] [--summary <path>]
  rerank         [--data <dir>] [--llm …] [--max-waves 5] [--dry-run] [--summary <path>] [--out <path>]
  build-indexes  --out <dir> [--data <dir>] [--build-id <id>] [--commit <sha>]
  maintenance    <nightly|drain-queue|squash-data-history|rebuild-indexes|reanalyze|rotate-anchors|validate-anchors> [--args <json>] [--summary <path>] [--out <path>]
  record-failure --workflow <name> --run <id> [--event <path>] [--step <s>] [--code <c>]
  data init <dir> [--anchors <dir>] | data clone <dir>
  fixtures generate --n 60 --seed 42 --out fixtures [--live] | fixtures web-data --from fixtures --out fixtures/web-data | fixtures payload --slug <slug>
  status
  --help

environment: ANTHROPIC_API_KEY, GITHUB_TOKEN, RA_DATA_DIR, RA_LLM_MODE, RA_RECORDINGS_DIR, RA_NOW, RA_SEED, RA_RUN_ID, RA_TRIGGER,
             RA_EVENT_PATH, RA_ENV (production enables GitHub API calls), GITHUB_REPOSITORY, RA_NO_GIT=1
`;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, sub] = positional;
  if (!command || command === '--help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const envBase = readEnv();
  const llm = str(flags.llm);
  if (llm && !isLlmMode(llm)) throw new Error(`--llm must be mock|live|record|replay, got ${llm}`);
  const env = { ...envBase, ...(str(flags.data) ? { dataDir: str(flags.data) as string } : {}), ...(llm && isLlmMode(llm) ? { llmMode: llm } : {}) };
  const log = consoleLogger;

  switch (command) {
    case 'submit': {
      const ctx = createContext({ env });
      const r = await submitCommand(ctx, { ...(str(flags.event) ? { event: str(flags.event) as string } : {}), ...(str(flags.payload) ? { payload: str(flags.payload) as string } : {}), ...(str(flags.summary) ? { summary: str(flags.summary) as string } : {}) });
      log.info(`submit: ${r.outcome}${r.report?.code ? ` (${r.report.code})` : ''}`);
      return r.exitCode;
    }
    case 'rerank': {
      const ctx = createContext({ env });
      const r = await runRerank(ctx, {
        ...(str(flags['max-waves']) ? { maxWaves: Number(str(flags['max-waves'])) } : {}),
        dryRun: flags['dry-run'] === true,
        ...(str(flags.summary) ? { summaryPath: str(flags.summary) as string } : {}),
        ...(str(flags.out) ? { outPath: str(flags.out) as string } : {}),
      });
      log.info(`rerank: ${r.state}; ${r.matches} matches, ${r.placed} placed, ${r.ingested} ingested, deploy=${r.deploy}`);
      return r.state === 'failed' ? 1 : 0;
    }
    case 'build-indexes': {
      const out = str(flags.out);
      if (!out) throw new Error('build-indexes needs --out <dir>');
      const ctx = createContext({ env });
      const r = await buildIndexes({ store: ctx.store, outDir: out, buildId: str(flags['build-id']) ?? 'local', commit: str(flags.commit) ?? '', now: ctx.clock.iso() });
      log.info(`build-indexes: ${r.files} files, ${r.resumes} resumes`);
      return 0;
    }
    case 'maintenance': {
      if (!sub) throw new Error('maintenance needs an action');
      const args = str(flags.args) ? (JSON.parse(str(flags.args) as string) as Record<string, unknown>) : {};
      const ctx = createContext({ env });
      const r = await maintenanceCommand(ctx, sub, args, { ...(str(flags.summary) ? { summaryPath: str(flags.summary) as string } : {}), ...(str(flags.out) ? { outPath: str(flags.out) as string } : {}) });
      log.info(`maintenance ${r.action}: ${JSON.stringify(r.report).slice(0, 400)}`);
      return r.exitCode;
    }
    case 'record-failure': {
      const workflow = str(flags.workflow);
      const run = str(flags.run);
      if (!workflow || !run) throw new Error('record-failure needs --workflow and --run');
      const ctx = createContext({ env });
      const line = await recordFailure(ctx, { workflow, run, ...(str(flags.event) ? { event: str(flags.event) as string } : {}), ...(str(flags.step) ? { step: str(flags.step) as string } : {}), ...(str(flags.code) ? { code: str(flags.code) as string } : {}) });
      log.info(`record-failure: ${JSON.stringify(line)}`);
      return 0;
    }
    case 'data': {
      const dir = positional[2];
      if (sub === 'init') {
        if (!dir) throw new Error('data init needs <dir>');
        await dataInit(dir, { now: createClock(env.now).iso(), anchorsDir: str(flags.anchors) ?? null });
        log.info(`data init: ${dir}`);
        return 0;
      }
      if (sub === 'clone') {
        if (!dir) throw new Error('data clone needs <dir>');
        await dataClone(dir, env.repo);
        return 0;
      }
      throw new Error('data needs init|clone');
    }
    case 'fixtures': {
      if (sub === 'web-data') {
        const r = await fixturesWebData(env, { from: str(flags.from) ?? env.fixturesDir, out: str(flags.out) ?? `${env.fixturesDir}/web-data`, ...(str(flags.reranks) ? { reranks: Number(str(flags.reranks)) } : {}), log });
        log.info(`fixtures web-data: ${JSON.stringify(r)}`);
        return 0;
      }
      if (sub === 'payload') {
        const slug = str(flags.slug);
        if (!slug) throw new Error('fixtures payload needs --slug');
        process.stdout.write(await fixturesPayloadCommand(env, slug));
        return 0;
      }
      if (sub === 'generate') {
        const seedEnv = { ...env, seed: str(flags.seed) ?? env.seed };
        const ctx = createContext({ env: seedEnv, ...(flags.live === true ? { llmMode: 'live' as const } : { llmMode: 'mock' as const }) });
        const r = await fixturesGenerate(ctx, { out: str(flags.out) ?? env.fixturesDir, live: flags.live === true, ...(str(flags.n) ? { n: Number(str(flags.n)) } : {}) });
        log.info(`fixtures generate: ${r.written} written`);
        return 0;
      }
      throw new Error('fixtures needs generate|web-data|payload');
    }
    case 'status': {
      const ctx = createContext({ env });
      process.stdout.write(await statusCommand(ctx));
      return 0;
    }
    default:
      process.stderr.write(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`::error::${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
