// Picks the transport for RA_LLM_MODE / --llm (§13.2).
import type { Env, LlmMode } from '../env.ts';
import { createLiveTransport, type LlmTransport } from './client.ts';
import { createMockTransport, type MockOptions } from './mock.ts';
import { createRecordingTransport, createReplayTransport } from './recorder.ts';

export function createTransport(env: Env, mode: LlmMode = env.llmMode, mock: Partial<MockOptions> = {}): LlmTransport {
  const seed = mock.seed ?? env.seed ?? env.runId;
  switch (mode) {
    case 'mock':
      return createMockTransport({ fixturesDir: env.fixturesDir, seed, ...(mock.script ? { script: mock.script } : {}) });
    case 'live':
      return createLiveTransport({ apiKey: env.anthropicKey });
    case 'record':
      return createRecordingTransport(createLiveTransport({ apiKey: env.anthropicKey }), env.recordingsDir);
    case 'replay':
      return createReplayTransport(env.recordingsDir);
  }
}
