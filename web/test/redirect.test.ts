import { describe, expect, it } from 'vitest';
import { decodeRedirect, encodeRedirect, parseUrl } from '../src/lib/redirect.ts';

const roundTrip = (href: string): string | null => {
  const bounced = encodeRedirect(parseUrl(href));
  return decodeRedirect(parseUrl(bounced));
};

describe('404.html → index.html redirect round trip', () => {
  it('preserves path, query and hash under /resumearena/', () => {
    const href = 'https://noahfinkelstein.github.io/resumearena/r/k7q2m3xw5a?x=1#h';
    const bounced = encodeRedirect(parseUrl(href));
    expect(bounced).toBe('https://noahfinkelstein.github.io/resumearena/?/r/k7q2m3xw5a&x=1#h');
    expect(roundTrip(href)).toBe('/resumearena/r/k7q2m3xw5a?x=1#h');
  });

  it('survives an ampersand in the query', () => {
    const href = 'https://noahfinkelstein.github.io/resumearena/leaderboard/tech?page=5&focus=k7q2m3xw5a&stage=mid';
    expect(roundTrip(href)).toBe('/resumearena/leaderboard/tech?page=5&focus=k7q2m3xw5a&stage=mid');
  });

  it('survives an ampersand in the path', () => {
    const href = 'https://noahfinkelstein.github.io/resumearena/u/a&b';
    const bounced = encodeRedirect(parseUrl(href));
    expect(bounced).toContain('~and~');
    expect(roundTrip(href)).toBe('/resumearena/u/a&b');
  });

  it('keeps the port and a plain deep link without query or hash', () => {
    expect(roundTrip('http://localhost:4173/resumearena/arena')).toBe('/resumearena/arena');
    expect(encodeRedirect(parseUrl('http://localhost:4173/resumearena/arena'))).toBe('http://localhost:4173/resumearena/?/arena');
  });

  it('leaves ordinary locations alone', () => {
    expect(decodeRedirect(parseUrl('https://noahfinkelstein.github.io/resumearena/?page=2'))).toBeNull();
    expect(decodeRedirect(parseUrl('https://noahfinkelstein.github.io/resumearena/'))).toBeNull();
  });
});
