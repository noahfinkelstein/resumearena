export const ladder = {
  title: (label: string) => `${label} ladder`,
  rated: (n: string) => `${n} rated`,
  filters: { stage: 'Stage', any: 'any', search: 'Search', searchPlaceholder: 'handle or anon-id', findMe: 'Find me', page: 'Page', jumpHint: '# jumps to a rank' },
  columns: { rank: '#', identity: 'identity', tier: 'tier', rating: 'rating', pm: '±', record: 'record', stage: 'stage', signal: 'signal', d7: '7d' },
  cursor: { newer: 'newer', older: 'older', of: (page: number, pages: number) => `page ${page} of ${pages}`, range: (a: string, b: string, total: string) => `${a}–${b} of ${total}` },
  you: 'you',
  jump: 'jump',
  empty: { stage: { title: 'No resumes match.', body: 'Loosen the career stage.' }, search: { title: 'No one by that handle.' }, none: { title: 'No resumes yet.', body: 'The first entry sits at the top for a while.' } },
  searchResults: (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`,
  landing: {
    heading: 'General ladder',
    wry: 'Updated as deploys finish. Refreshing will not help your rating.',
    whole: 'The whole ladder',
  },
} as const;
