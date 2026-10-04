import { describe, expect, it } from 'vitest';
import { detectName, isScrubbed, scrubPii, sweepAnalysisText, sweepCard, sweepDeep, sweepHit } from '../src/scrub.ts';
import { makeAnalysis, makeCard } from './helpers/analysis-fixture.ts';

/** Lines that must produce at least one redaction (checked against a non-name first line). */
const POSITIVE: [line: string, kind: string][] = [
  ['Contact: jane.doe@example.com', 'email'],
  ['JDOE@STUDENT.MIT.EDU', 'email'],
  ['first_last+tag@sub.domain.co.uk', 'email'],
  ['Email jane at jane.doe@gmail.com for details', 'email'],
  ['https://github.com/jdoe', 'url'],
  ['www.janedoe.dev', 'url'],
  ['linkedin.com/in/jane-doe-123', 'url'],
  ['Portfolio: janedoe.me', 'url'],
  ['github.com/jdoe/repo', 'url'],
  ['http://example.org/path?x=1', 'url'],
  ['See https://arxiv.org/abs/1234.5678 for the paper', 'url'],
  ['Website: https://jane.dev', 'url'],
  ['Blog www.blog.jane.io/posts', 'url'],
  ['@jdoe_dev on Twitter', 'url'],
  ['GitHub: jdoe-dev', 'url'],
  ['LinkedIn | jane-doe', 'url'],
  ['Twitter/jdoe99', 'url'],
  ['(415) 555-0132', 'phone'],
  ['+1 415 555 0132', 'phone'],
  ['415.555.0132', 'phone'],
  ['+44 20 7946 0958', 'phone'],
  ['Tel: 555-123-4567', 'phone'],
  ['+91 98765 43210', 'phone'],
  ['Mobile 0415 123 456', 'phone'],
  ['Phone: 650 555 0199', 'phone'],
  ['+33 6 12 34 56 78', 'phone'],
  ['Cell +1-650-555-0199', 'phone'],
  ['123 Main Street, Apt 4B', 'address'],
  ['45 Oak Ave', 'address'],
  ['1600 Pennsylvania Avenue NW', 'address'],
  ['San Francisco, CA 94107', 'address'],
  ['Cambridge MA 02139', 'address'],
  ['London SW1A 1AA', 'address'],
  ['Toronto, ON M5V 3L9', 'address'],
  ['10 Downing Street', 'address'],
  ['221B Baker Street', 'address'],
  ['77 Massachusetts Ave., Cambridge, MA 02139', 'address'],
  ['Lives at 9 Elm Court', 'address'],
  ['jane@doe.io · +1-650-555-0199', 'email'],
  ['Reach me: jane_doe@proton.me | +1 (212) 555 0100 | 12 Park Lane', 'phone'],
];

/** Lines that must pass through untouched. */
const NEGATIVE: string[] = [
  'Senior Software Engineer',
  'Education',
  'Stanford University, B.S. Computer Science, 2019 - 2023',
  'GPA 3.9/4.0',
  'Jan 2021 - Dec 2023',
  '2019–2021',
  'Increased revenue by 40% ($1.2M) in 2022',
  'Served 10,000,000 users across 3 regions',
  'Built with Node.js, React.js and ASP.NET',
  'Python 3.11, C++17, Java 21',
  'Reduced p99 latency from 450 ms to 120 ms',
  'Team of 5 engineers; 2 direct reports',
  'Published at NeurIPS 2023 (first author)',
  'IOI 2019 bronze medal',
  'Fluent in English, German (B2)',
  'Fall 2020 2021 2022 Dean’s List',
  'Goldman Sachs, TMT IBD, Summer Analyst',
  'Managed $2,000,000 budget and 120 members',
  'Scikit-learn, PyTorch 2.0, CUDA 12',
  'Version 1.2.3 released',
  'Won 1st place of 300 teams',
  'Section 2.3 in the thesis',
  'e.g. distributed systems, i.e. consensus',
  'U.S. citizen',
  'Ph.D. in Physics, MIT, 2018',
  'Course CS101 and CS224N',
  'Scored 1580/1600 on the SAT',
  'Raised Series A of $12,000,000',
  'Mentored 25 interns 2021-2023',
  'Amazon.com, Inc. — SDE II',
  'Summary',
  'John Smith reference available on request',
  'Grew ARR from 10 000 to 200 000',
  'Shipped v2.0 to 3 continents in 2023',
  'Patent pending, filed 2022',
  'First Place, Hackathon 2021',
  'Supreme Court clerkship',
  'Room 101, Building 7',
  '[name] [email] [phone] [url] [address] [redacted]',
  'Deployed on 2020-01-15 and again on 2021-06-30',
];

const NEUTRAL_FIRST_LINE = 'Summary\n';

describe('scrubPii corpus', () => {
  it.each(POSITIVE)('redacts %j', (line, kind) => {
    const r = scrubPii(NEUTRAL_FIRST_LINE + line);
    expect(r.redactions.length).toBeGreaterThan(0);
    expect(r.redactions.map((x) => x.kind)).toContain(kind);
    expect(r.text).not.toBe(NEUTRAL_FIRST_LINE + line);
  });
  it.each(NEGATIVE)('leaves %j alone', (line) => {
    const r = scrubPii(NEUTRAL_FIRST_LINE + line);
    expect(r.redactions).toEqual([]);
    expect(r.text).toBe(NEUTRAL_FIRST_LINE + line);
  });
  it('is idempotent on every corpus line and stable in counts', () => {
    for (const [line] of POSITIVE) {
      const once = scrubPii(NEUTRAL_FIRST_LINE + line);
      const twice = scrubPii(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.redactions).toEqual([]);
      expect(twice.counts).toEqual(once.counts);
      expect(isScrubbed(once.text)).toBe(true);
    }
  });
  it('records token, original and output index', () => {
    const r = scrubPii('Summary\nmail jane@x.io now');
    expect(r.redactions).toEqual([{ kind: 'email', original: 'jane@x.io', token: '[email]', index: 13 }]);
    expect(r.text.slice(13, 20)).toBe('[email]');
  });
  it('keeps the label of a labelled handle', () => {
    expect(scrubPii('Summary\nGitHub: jdoe-dev · LinkedIn | jane-doe').text).toBe('Summary\nGitHub: [url] · LinkedIn | [url]');
    expect(scrubPii('Summary\nGitHub: Python projects').text).toBe('Summary\nGitHub: Python projects');
  });
  it('counts pre-existing tokens, including manual [redacted]', () => {
    const r = scrubPii('Summary\n[redacted] worked at [redacted]; mail x@y.com');
    expect(r.counts).toEqual({ name: 0, email: 1, phone: 0, url: 0, address: 0, manual: 2 });
  });
});

describe('name heuristic', () => {
  it('replaces the first-line name and every later whole-word occurrence', () => {
    const r = scrubPii('Jane Doe\nSoftware Engineer\nJane led the team. Contact Doe or Jane Doe.\nJanet and Doering stay.');
    expect(r.text).toBe('[name]\nSoftware Engineer\n[name] led the team. Contact [name] or [name].\nJanet and Doering stay.');
    expect(r.counts.name).toBe(4);
    expect(scrubPii(r.text).text).toBe(r.text);
  });
  it('handles separators, initials and honorifics', () => {
    expect(scrubPii('Jane Doe | Senior Engineer').text).toBe('[name] | Senior Engineer');
    expect(scrubPii('Jane A. Doe').text).toBe('[name]');
    expect(scrubPii('Jane Doe, PhD').text).toBe('[name], PhD');
    expect(scrubPii("Mary-Jane O'Brien").text).toBe('[name]');
    expect(scrubPii('Jane Doe jane@x.com').text).toBe('[name] [email]');
    expect(detectName('Dr Jane Doe')?.tokens).toEqual(['Jane', 'Doe']);
  });
  it('misses all-caps names and names in running text, by design', () => {
    expect(scrubPii('JANE DOE\nEngineer').text).toBe('JANE DOE\nEngineer');
    expect(scrubPii('Senior Software Engineer\nJane Doe').text).toBe('Senior Software Engineer\nJane Doe');
    expect(detectName('Stanford University Resume')).toBeNull();
    expect(detectName('Curriculum Vitae')).toBeNull();
    expect(detectName('Jane')).toBeNull();
    expect(detectName('Jane Doe Mary Ann Smith')).toBeNull();
    expect(detectName('Jane 2 Doe')).toBeNull();
  });
  it('can be switched off for the preview', () => {
    expect(scrubPii('Jane Doe\nx', { name: false }).text).toBe('Jane Doe\nx');
  });
});

describe('scrubPii on a whole résumé', () => {
  const raw = [
    'Priya Natarajan',
    'priya.n@example.com · +1 (415) 555-0132 · linkedin.com/in/priya-n · 123 Main Street, San Francisco, CA 94107',
    '',
    'Experience',
    'Senior Engineer, Acme (2021 - present): Priya owned a 40k rps service; see github.com/priya-n/ingest.',
    'Natarajan et al., NeurIPS 2023.',
  ].join('\n');
  it('produces the expected text and counts and is idempotent', () => {
    const r = scrubPii(raw);
    expect(r.text).toBe(
      [
        '[name]',
        '[email] · [phone] · [url] · [address], [address]',
        '',
        'Experience',
        'Senior Engineer, Acme (2021 - present): [name] owned a 40k rps service; see [url].',
        '[name] et al., NeurIPS 2023.',
      ].join('\n'),
    );
    expect(r.counts).toEqual({ name: 3, email: 1, phone: 1, url: 2, address: 2, manual: 0 });
    const again = scrubPii(r.text);
    expect(again.text).toBe(r.text);
    expect(again.counts).toEqual(r.counts);
  });
});

describe('sweeps', () => {
  it('sweepHit catches each placeholder and pattern, and nothing clean', () => {
    for (const s of ['[name]', 'see [email]', '[phone]', '[url] given', '[address]', '[redacted]', 'mail jane@x.com', '+1 415 555 0132', 'https://x.io/a', 'github.com/jdoe', '123 Main Street', 'Boston, MA 02115']) {
      expect(sweepHit(s), s).toBe(true);
    }
    for (const s of ['Owned a 40k rps system', '2021-present', 'IOI 2019 bronze', 'Node.js and ASP.NET', 'not stated', '100-500 citations claimed', '$2,000,000 budget, 120 members']) {
      expect(sweepHit(s), s).toBe(false);
    }
  });
  it('sweepCard replaces only the offending strings with [removed]', () => {
    const clean = sweepCard(makeCard());
    expect(clean.hits).toBe(0);
    expect(clean.card).toEqual(makeCard());
    const dirty = makeCard();
    dirty.headline = 'Engineer; contact jane@x.com';
    dirty.experiences[0]!.highlights[0] = 'See github.com/jdoe for code';
    dirty.notable[0] = 'Lives at 123 Main Street';
    dirty.leadership[0] = 'Call +1 415 555 0132';
    dirty.skills_top[0] = '[name]';
    const r = sweepCard(dirty);
    expect(r.hits).toBe(5);
    expect(r.card.headline).toBe('[removed]');
    expect(r.card.experiences[0]!.highlights[0]).toBe('[removed]');
    expect(r.card.notable[0]).toBe('[removed]');
    expect(r.card.leadership[0]).toBe('[removed]');
    expect(r.card.skills_top[0]).toBe('[removed]');
    expect(r.card.skills_top[1]).toBe('Rust');
    expect(r.card.top_signal).toBe('40k rps system');
  });
  it('sweepAnalysisText covers every free-text field without touching numbers or enums', () => {
    const a = makeAnalysis();
    a.strengths[0] = 'Email jane@x.com listed';
    a.scores.tech.rationale = 'Street address 45 Oak Ave in the footer';
    a.ats.fixes[0]!.fix = 'Remove the [address] line';
    const r = sweepAnalysisText(a);
    expect(r.hits).toBe(3);
    expect(r.analysis.strengths[0]).toBe('[removed]');
    expect(r.analysis.scores.tech.rationale).toBe('[removed]');
    expect(r.analysis.ats.fixes[0]!.fix).toBe('[removed]');
    expect(r.analysis.scores.tech.sub_scores.impact).toBe(78);
    expect(r.analysis.card.career_stage).toBe('mid');
    expect(sweepDeep({ n: 1, s: ['ok', 'x@y.io'], o: { t: null } })).toEqual({ value: { n: 1, s: ['ok', '[removed]'], o: { t: null } }, hits: 1 });
  });
});
