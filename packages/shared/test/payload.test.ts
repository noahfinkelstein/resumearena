import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPayload, checkPayload, normalizePayload, normalizeText, parseMetricsJson } from '../src/payload.ts';
import type { SubmissionPayload } from '../src/types.ts';

const SOURCE = { kind: 'dispatch', run_id: 123, issue_number: null, client_version: '1.0' } as const;
const OWNER_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const KEY = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
const KEY_HASH = createHash('sha256').update(KEY, 'utf8').digest('hex');
const SENTENCE = 'Owned the ingest service handling forty thousand requests per second with a low tail latency. ';
const TEXT = `[name]\n[email] · [phone]\n\nExperience\n${SENTENCE.repeat(6)}\nEducation\nB.S. Computer Science, State University (2014 - 2018)\n`;

const valid = (patch: Partial<SubmissionPayload> = {}): SubmissionPayload => ({
  action: 'submit',
  submission_id: 'k7q2m3xw5a',
  handle: 'priya-n',
  owner_hash: OWNER_HASH,
  visibility: 'anonymous',
  text: TEXT,
  metrics_json: '{"source":"pdf","pages":2,"extraction_quality":0.9}',
  ladder_hint: '',
  client_version: '412345678.1',
  owner_key: '',
  ...patch,
});

const code = (patch: Partial<Record<keyof SubmissionPayload, unknown>>) => {
  const r = checkPayload({ ...valid(), ...patch });
  return r.ok ? 'ok' : `${r.code}:${r.field}${r.reason ? `:${r.reason}` : ''}`;
};

describe('normalizePayload', () => {
  it('accepts a valid submit and fills the derived fields', async () => {
    const r = await normalizePayload(valid(), SOURCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.action).toBe('submit');
    expect(r.input.id).toBe('k7q2m3xw5a');
    expect(r.input.ladder_hint).toBe('general');
    expect(r.input.owner_key).toBeNull();
    expect(r.input.text).toBe(TEXT.trim());
    expect(r.input.text_sha256).toBe(createHash('sha256').update(TEXT.trim(), 'utf8').digest('hex'));
    expect(r.input.metrics).toEqual({
      source: 'pdf', pages: 2, columns_detected: 0, font_count: 0, image_count: 0, char_count: 0, word_count: 0, extraction_quality: 0.9,
      redactions: { name: 0, email: 0, phone: 0, url: 0, address: 0, manual: 0 },
    });
    expect(r.input.source).toEqual(SOURCE);
  });

  it('normalizes text: CRLF, NFC, control and zero-width characters, trim', () => {
    const raw = `  ${TEXT.replace(/\n/g, '\r\n')}\u0007​ é x \n\n`;
    const r = checkPayload(valid({ text: raw }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).not.toContain('\r');
    expect(r.value.text).not.toContain('\u0007');
    expect(r.value.text).not.toContain('​');
    expect(r.value.text).not.toContain(' ');
    expect(r.value.text.endsWith('éx')).toBe(true);
    expect(normalizeText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('bad_payload for every malformed input', () => {
    expect(code({ action: 'nuke' })).toBe('bad_payload:action');
    expect(code({ action: 42 })).toBe('bad_payload:action');
    expect(code({ submission_id: 'ABC' })).toBe('bad_payload:submission_id');
    expect(code({ submission_id: 'k7q2m3xw5' })).toBe('bad_payload:submission_id');
    expect(code({ submission_id: 'anchrggaaa' })).toBe('bad_payload:submission_id');
    expect(code({ owner_hash: 'abc' })).toBe('bad_payload:owner_hash');
    expect(code({ owner_hash: OWNER_HASH.toUpperCase() })).toBe('bad_payload:owner_hash');
    expect(code({ visibility: 'public' })).toBe('bad_payload:visibility');
    expect(code({ visibility: '' })).toBe('bad_payload:visibility');
    expect(code({ metrics_json: 'not json' })).toBe('bad_payload:metrics_json');
    expect(code({ metrics_json: '[]' })).toBe('bad_payload:metrics_json');
    expect(code({ metrics_json: '{"pages":-1}' })).toBe('bad_payload:metrics_json');
    expect(code({ metrics_json: `{"x":"${'a'.repeat(2000)}"}` })).toBe('bad_payload:metrics_json');
    expect(code({ ladder_hint: 'sports' })).toBe('bad_payload:ladder_hint');
    expect(code({ client_version: 'A B' })).toBe('bad_payload:client_version');
    expect(code({ client_version: 'a'.repeat(25) })).toBe('bad_payload:client_version');
    expect(code({ owner_key: 'nope' })).toBe('bad_payload:owner_key');
    expect(code({ action: 'delete', owner_key: '' })).toBe('bad_payload:owner_key');
    expect(code({ action: 'set_visibility', owner_key: '' })).toBe('bad_payload:owner_key');
    expect(code({ action: 'set_visibility', owner_key: KEY, visibility: '' })).toBe('bad_payload:visibility');
    expect(checkPayload(null).ok).toBe(false);
    expect(checkPayload('x').ok).toBe(false);
  });

  it('too_short / too_long after normalization', () => {
    expect(code({ text: 'Experience. '.repeat(33).slice(0, 399) })).toBe('too_short:text');
    expect(code({ text: `${'x'.repeat(399)}   ` })).toBe('too_short:text');
    expect(code({ text: 'x'.repeat(400) })).toBe('ok');
    expect(code({ text: 'x'.repeat(15000) })).toBe('ok');
    expect(code({ text: 'x'.repeat(15001) })).toBe('too_long:text');
  });

  it('text_not_scrubbed when the scrub would change the text', () => {
    expect(code({ text: `${TEXT}\nmail me: priya@example.com` })).toBe('text_not_scrubbed:text');
    expect(code({ text: `Priya Natarajan\n${TEXT}` })).toBe('text_not_scrubbed:text');
    expect(code({ text: `${TEXT}\nCall +1 415 555 0132` })).toBe('text_not_scrubbed:text');
  });

  it('handle problems map to handle_taken with the reason', () => {
    expect(code({ handle: 'Admin' })).toBe('handle_taken:handle:format');
    expect(code({ handle: 'ab' })).toBe('handle_taken:handle:format');
    expect(code({ handle: 'admin' })).toBe('handle_taken:handle:reserved');
    expect(code({ handle: 'anon-k7q2m3x' })).toBe('handle_taken:handle:reserved');
    expect(code({ handle: 'fuck' })).toBe('handle_taken:handle:blocked');
  });

  it('manage actions ignore text and metrics and require a parsable key', async () => {
    const del = await normalizePayload(valid({ action: 'delete', owner_hash: KEY_HASH, visibility: '', text: '', metrics_json: '', owner_key: `rak-${KEY}` }), SOURCE);
    expect(del.ok).toBe(true);
    if (del.ok) {
      expect(del.input.owner_key).toBe(KEY);
      expect(del.input.visibility).toBe('anonymous');
      expect(del.input.text).toBe('');
      expect(del.input.metrics.source).toBe('paste');
    }
    const vis = await normalizePayload(valid({ action: 'set_visibility', owner_hash: KEY_HASH, visibility: 'handle', text: 'short', owner_key: KEY }), SOURCE);
    expect(vis.ok).toBe(true);
    if (vis.ok) expect(vis.input.visibility).toBe('handle');
    const resubmit = checkPayload(valid({ owner_key: KEY.toUpperCase() }));
    expect(resubmit.ok && resubmit.value.owner_key).toBe(KEY);
    const derived = await normalizePayload(valid({ action: 'delete', owner_hash: '', owner_key: KEY }), SOURCE);
    expect(derived.ok && derived.input.owner_hash).toBe(KEY_HASH);
    const mismatch = await normalizePayload(valid({ action: 'delete', owner_key: KEY }), SOURCE);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.field).toBe('owner_hash');
    expect(code({ owner_hash: '' })).toBe('bad_payload:owner_hash');
  });

  it('ladder_hint and categories', () => {
    for (const cat of ['general', 'finance', 'tech', 'academia'] as const) {
      const r = checkPayload(valid({ ladder_hint: cat }));
      expect(r.ok && r.value.ladder_hint).toBe(cat);
    }
  });

  it('parseMetricsJson drops unknown keys and defaults missing ones', () => {
    expect(parseMetricsJson('{}')?.source).toBe('paste');
    expect(parseMetricsJson('')?.pages).toBe(0);
    expect(parseMetricsJson('{"source":"docx","bogus":1,"columns_detected":2}')).toMatchObject({ source: 'docx', columns_detected: 2 });
    expect(parseMetricsJson('{"source":"docx","bogus":1}')).not.toHaveProperty('bogus');
    expect(parseMetricsJson('{"columns_detected":5}')).toBeNull();
    expect(parseMetricsJson('{"extraction_quality":1.5}')).toBeNull();
    expect(parseMetricsJson('null')).toBeNull();
  });

  it('buildPayload emits ten string fields that validate', () => {
    const p = buildPayload({ action: 'submit', id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: OWNER_HASH, text: TEXT, metrics: parseMetricsJson('{}') });
    expect(Object.keys(p).sort()).toEqual(['action', 'client_version', 'handle', 'ladder_hint', 'metrics_json', 'owner_hash', 'owner_key', 'submission_id', 'text', 'visibility']);
    for (const v of Object.values(p)) expect(typeof v).toBe('string');
    expect(checkPayload(p).ok).toBe(true);
    expect(buildPayload({ action: 'delete', id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: OWNER_HASH, owner_key: KEY }).visibility).toBe('');
  });
});
