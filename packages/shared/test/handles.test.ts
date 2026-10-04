import { describe, expect, it } from 'vitest';
import { HANDLE_RE, RESERVED, handleShard, validateHandle } from '../src/handles.ts';
import { BLOCKLIST, foldHandle, isBlocked } from '../src/handles/blocklist.ts';

describe('validateHandle', () => {
  it('accepts ordinary handles, including Scunthorpe-style names', () => {
    for (const h of ['priya-n', 'jdoe', 'abc', 'a1b2c3', 'hancock', 'dickinson-lab', 'scunthorpe-fc', 'cassandra', 'assistant-dev', 'classy', 'sussex-uni',
      'matsushita', 'penistone', 'cummins', 'analyst42', 'phuket-travel', 'niger-delta', 'hoekstra', 'ashkenazi-music', 'arsenal-fan', 'bobsmith', 'cockburn',
      'therapist-k', 'saturday-club', 'heroine-fan', 'pakistan-dev', 'asperger-aware', 'simpson', 'swanky', 'dagobert', 'raccoon', 'squawk', 'abbot', 'kraftwerk',
      'grape-lab', 'scraping-tools', 'shiitake', 'sexton', 'essex', 'titan', 'cumberland', 'fukuoka', 'nippon-steel']) {
      expect(validateHandle(h), h).toBe('ok');
    }
  });
  it('rejects bad formats', () => {
    for (const h of ['ab', '-abc', 'abc-', 'Abc', 'a_b', 'a'.repeat(21), '', 'a b', 'ünïcode', 'anon.k7']) expect(validateHandle(h), h).toBe('format');
    expect(HANDLE_RE.test('a-b')).toBe(true);
    expect(HANDLE_RE.test('a'.repeat(20))).toBe(true);
  });
  it('rejects reserved words and prefixes', () => {
    for (const h of ['admin', 'anon-k7q2m3x', 'anchrggaaa', 'anchrzzzzz', 'tech', 'laureate', 'leaderboard', 'noahfinkelstein', 'resumearena', 'about', 'null']) {
      expect(validateHandle(h), h).toBe('reserved');
    }
    // Single-character route prefixes never pass the 3-char format check, but they stay in the set for completeness.
    expect(RESERVED.has('r')).toBe(true);
    expect(RESERVED.has('u')).toBe(true);
    expect(validateHandle('r')).toBe('format');
  });
  it('rejects blocked words, with hyphen, repeat and leetspeak folding', () => {
    for (const h of ['fuck', 'f-u-c-k', 'fuuuuck', 'sh1t', 'b1tch', 'a55', 'a55hole', 'n1gga', 'ass', 'ass-man', 'dick123', 'pen15', 'cunt-face', 'hitler88',
      'nazi-punk', 'xxx-video', 'fag', 'p0rn', 'ph-uck', 'kkk', 'the-rapist', 'paki-bashing', 'ret4rd', 'wh0re', 'cumshot', 'c0cksucker']) {
      expect(validateHandle(h), h).toBe('blocked');
    }
  });
  it('folds as documented', () => {
    expect(foldHandle('F-U-C-K')).toBe('fuck');
    expect(foldHandle('a55h0le')).toBe('asshole');
    expect(foldHandle('fuuuuck')).toBe('fuuck');
    expect(isBlocked('')).toBe(false);
    expect(BLOCKLIST.size).toBeGreaterThanOrEqual(300);
    for (const w of BLOCKLIST) expect(w).toMatch(/^[a-z0-9/]+$/);
  });
  it('handleShard', () => {
    expect(handleShard('priya-n')).toBe('pr');
  });
});
