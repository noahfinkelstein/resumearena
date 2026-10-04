// `--llm record` writes one JSON per call under RA_RECORDINGS_DIR keyed by sha256 of the request body;
// `--llm replay` serves them and fails on a miss (CI mode, §13.2).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, jsonFileText } from '@resumearena/shared';
import { sha256Hex } from '../rng.ts';
import type { LlmRequest, LlmResponse, LlmTransport } from './client.ts';

export class ReplayMissError extends Error {
  readonly key: string;
  constructor(key: string, dir: string) {
    super(`replay: no recording ${key} in ${dir}`);
    this.name = 'ReplayMissError';
    this.key = key;
  }
}

/** The request without mock-only hints, so a recording made by one caller replays for another. */
export function requestKey(req: LlmRequest): string {
  const { meta: _meta, ...body } = req;
  return sha256Hex(canonicalJson(body));
}

export function createRecordingTransport(inner: LlmTransport, dir: string): LlmTransport {
  mkdirSync(dir, { recursive: true });
  return {
    mode: 'record',
    async call(req) {
      const res = await inner.call(req);
      const { meta: _meta, ...body } = req;
      writeFileSync(join(dir, `${requestKey(req)}.json`), jsonFileText({ request: body, response: res }), 'utf8');
      return res;
    },
  };
}

export function createReplayTransport(dir: string): LlmTransport {
  return {
    mode: 'replay',
    async call(req) {
      const key = requestKey(req);
      const file = join(dir, `${key}.json`);
      if (!existsSync(file)) throw new ReplayMissError(key, dir);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { response: LlmResponse };
      return parsed.response;
    },
  };
}
