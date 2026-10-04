// Pure mirrors of the two inline scripts (public/404.html encodes, index.html decodes) so the round trip
// is testable. The shipped scripts are the source of truth; keep these byte-for-byte equivalent in effect.

export interface LocationLike {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}

/** What 404.html redirects to: `/resumearena/r/abc?x=1#h` → `/resumearena/?/r/abc&x=1#h`. */
export function encodeRedirect(l: LocationLike, seg = 1): string {
  return (
    l.protocol +
    '//' +
    l.hostname +
    (l.port ? ':' + l.port : '') +
    l.pathname.split('/').slice(0, 1 + seg).join('/') +
    '/?/' +
    l.pathname.slice(1).split('/').slice(seg).join('/').replace(/&/g, '~and~') +
    (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') +
    l.hash
  );
}

/** What index.html restores (path + search + hash), or null when the location is not an encoded redirect. */
export function decodeRedirect(l: Pick<LocationLike, 'pathname' | 'search' | 'hash'>): string | null {
  if (l.search[1] !== '/') return null;
  const decoded = l.search
    .slice(1)
    .split('&')
    .map((s) => s.replace(/~and~/g, '&'));
  return l.pathname.slice(0, -1) + decoded.join('?') + l.hash;
}

export function parseUrl(href: string): LocationLike {
  const u = new URL(href);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash };
}
