import { describe, expect, it } from 'vitest';
import { PriceError, costOf, resolvePrices, roundUsd, tokenCountsOf } from '../src/prices.ts';
import { DEFAULT_SETTINGS, PRICES_FALLBACK } from '../src/constants.ts';
import { SettingsZ } from '../src/schemas/data.ts';

describe('costOf', () => {
  it('prices input, cache read and output per million', () => {
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5-5')).toBe(2);
    expect(costOf({ input_tokens: 0, output_tokens: 1_000_000 }, 'claude-opus-5-5')).toBe(20);
    expect(costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-haiku-4-5')).toBe(0.1);
    expect(costOf({ input_tokens: 3010, output_tokens: 940, cache_read_input_tokens: 4800, cache_creation_input_tokens: 0 }, 'claude-sonnet-5-5')).toBe(0.01638);
  });
  it('prices cache writes by TTL, defaulting to the 5-minute rate', () => {
    const u = (oneH: number, fiveM: number, total = oneH + fiveM) => ({
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: total, cache_creation: { ephemeral_1h_input_tokens: oneH, ephemeral_5m_input_tokens: fiveM },
    });
    expect(costOf(u(1000, 0), 'claude-opus-5-5')).toBe(0.008);
    expect(costOf(u(0, 1000), 'claude-opus-5-5')).toBe(0.005);
    expect(costOf(u(600, 400), 'claude-opus-5-5')).toBe(0.0068);
    expect(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }, 'claude-opus-5-5')).toBe(0.005);
    expect(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 300 } }, 'claude-opus-5-5')).toBe(0.0059);
    expect(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: null }, 'claude-sonnet-5-5')).toBe(0.0025);
  });
  it('resolves dated snapshots by prefix and fails loudly otherwise', () => {
    expect(resolvePrices('claude-opus-5-5-20260601')).toBe(PRICES_FALLBACK['claude-opus-5-5']);
    expect(resolvePrices('claude-opus-4-8')).toBe(PRICES_FALLBACK['claude-opus-4-8']);
    expect(() => costOf({ input_tokens: 1, output_tokens: 1 }, 'gpt-9')).toThrow(PriceError);
    try {
      resolvePrices('gpt-9');
    } catch (e) {
      expect((e as PriceError).model).toBe('gpt-9');
    }
  });
  it('settings prices override the fallback', () => {
    const prices = { ...PRICES_FALLBACK, 'claude-sonnet-5-5': { input: 1, cache_read: 0.1, cache_write_5m: 1, cache_write_1h: 1, output: 1 } };
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-sonnet-5-5', prices)).toBe(1);
    expect(SettingsZ.parse(DEFAULT_SETTINGS).prices_usd_per_mtok['claude-opus-4-8']?.output).toBe(25);
  });
  it('tokenCountsOf and rounding', () => {
    expect(tokenCountsOf({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: undefined })).toEqual({ in: 5, cr: 0, cw: 0, out: 6 });
    expect(tokenCountsOf({ input_tokens: -1, output_tokens: Number.NaN })).toEqual({ in: 0, cr: 0, cw: 0, out: 0 });
    expect(roundUsd(0.1234567)).toBe(0.123457);
  });
});
