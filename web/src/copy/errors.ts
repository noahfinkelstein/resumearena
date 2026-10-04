// Cross-page states and errors (product-ux.md §1.5).
export const errors = {
  notFound: { title: 'Nothing here.', body: 'The link may be deleted or mistyped.' },
  profileNotFound: { title: 'No one by that handle.', body: 'Anonymous entries have no profile page; they are reached from their result link.' },
  dataError: { title: 'Could not load.', body: 'GitHub Pages did not answer. Retrying.', retry: 'Retry' },
  links: { ladder: 'The general ladder', arena: 'The arena' },
} as const;

export const site = {
  name: 'ResumeArena',
  tagline: 'Where resumes are rated, not reviewed.',
  short: 'A rated ladder for resumes.',
  hero: ['Upload a resume. It is scored, then matched head to head against others until a rating settles.', 'Four ladders: general, finance, tech, academia. No accounts; anyone can watch, and entering takes a handle, not an email.'],
  nav: { ladders: 'Ladders', arena: 'Arena', about: 'About', upload: 'Upload a resume', uploadShort: 'Upload', entry: 'Your entry', menu: 'Menu', close: 'Close' },
  footer: { about: 'about', privacy: 'privacy', status: 'status', github: 'github' },
  how: {
    heading: 'How it works',
    steps: [
      ['Read here.', 'The text is extracted and contact details removed in your browser. You see exactly what will be public before it is.'],
      ['Scored.', 'Five sub-scores from the text alone: pedigree, trajectory, impact, selectivity, breadth. Plus a parse-readiness check.'],
      ['Matched.', 'Eight placement matches against resumes near the starting estimate, both orderings, judged with a reason.'],
      ['Rated.', 'A chess-style rating with an uncertainty that narrows.'],
    ],
    then: 'Then it keeps playing: every entry is re-matched as new ones arrive, so ranks move. No account; a handle and a key.',
    more: 'about',
  },
  landing: { browse: 'Browse the ladders', yourEntry: 'Your entry', resumes: 'resumes', matches: 'matches', entryAnalysed: 'analysed, awaiting placement', entryPending: 'pending' },
} as const;
