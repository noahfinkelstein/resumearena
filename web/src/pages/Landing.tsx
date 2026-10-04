import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { LadderPage, PublicStatus, RankEntry, ResumeDoc } from '@resumearena/shared';
import { Page, Section } from '../components/chrome/Chrome.tsx';
import { LinkButton } from '../components/forms/Button.tsx';
import { EmptyState, ErrorState } from '../components/forms/States.tsx';
import { Num, StatLine, TierLabel } from '../components/numbers/Numbers.tsx';
import { LeaderboardTable } from '../components/tables/Tables.tsx';
import { arena as arenaCopy } from '../copy/arena.ts';
import { site } from '../copy/errors.ts';
import { ladder as ladderCopy } from '../copy/ladder.ts';
import { getLadderPage, getManifest, getRankEntry, getResumeDoc, getStatus } from '../lib/data.ts';
import { fmtCount, fmtRatingWithRd } from '../lib/format.ts';
import { entriesNewestFirst, useIdentity } from '../lib/identity.ts';
import { useData } from '../lib/useData.ts';
import { ratingViews, ladderRows } from '../lib/views.ts';

interface LandingData {
  page: LadderPage | null;
  status: PublicStatus | null;
  buildId: string | null;
}

export function Landing() {
  const { data, error, loading, reload } = useData<LandingData>(
    async (signal) => {
      const manifest = await getManifest({ signal });
      const [page, status] = await Promise.all([manifest ? getLadderPage('general', 'all', 1, manifest.build_id, { signal }) : null, getStatus({ signal })]);
      return { page, status, buildId: manifest?.build_id ?? null };
    },
    [],
    { every: 5 * 60_000 },
  );
  const rows = ladderRows(data?.page ?? null).slice(0, 10);
  return (
    <Page title="">
      <div className="hero-grid">
        <div className="hero">
          <h1>{site.tagline}</h1>
          <div className="hero-sub">
            {site.hero.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          <div className="actions">
            <LinkButton to="/upload" variant="primary">
              {site.nav.upload}
            </LinkButton>
            <Link to="/leaderboard/general">{site.landing.browse}</Link>
          </div>
          <YourEntry buildId={data?.buildId ?? null} />
        </div>
        <div>
          <Section heading={<Link to="/leaderboard/general">{ladderCopy.landing.heading}</Link>} rule updatedAt={data?.status?.updated_at ?? null}>
            {error && rows.length === 0 ? (
              <ErrorState title="Could not load." body="GitHub Pages did not answer. Retrying." retry={reload} />
            ) : !loading && rows.length === 0 ? (
              <EmptyState title={ladderCopy.empty.none.title} body={ladderCopy.empty.none.body} />
            ) : (
              <LeaderboardTable rows={rows} mode="compact" loading={loading} />
            )}
            <div className="mt-4">
              <StatLine items={[{ label: site.landing.resumes, value: data?.status ? fmtCount(data.status.counts.analyzed) : '—' }, { label: site.landing.matches, value: data?.status ? fmtCount(data.status.counts.matches) : '—' }]} />
              <p className="wry">{ladderCopy.landing.wry}</p>
            </div>
          </Section>
        </div>
      </div>

      <Section heading={site.how.heading} rule className="how">
        <ol>
          {site.how.steps.map(([title, body], i) => (
            <li key={title}>
              <span className="n">{i + 1}</span>
              <b>{title}</b> {body}
            </li>
          ))}
        </ol>
        <p className="then">
          {site.how.then} <Link to="/about">→ {site.how.more}</Link>
        </p>
      </Section>

      <Section heading={arenaCopy.teaser.heading} rule>
        <div className="teaser">
          <p className="prose">{arenaCopy.teaser.body}</p>
          <Link to="/arena">{arenaCopy.teaser.action} →</Link>
        </div>
      </Section>
    </Page>
  );
}

/** The has-key line under the CTA: the newest entry this browser submitted. */
function YourEntry({ buildId }: { buildId: string | null }) {
  const { entries } = useIdentity();
  const [line, setLine] = useState<{ id: string; doc: ResumeDoc | null; entry: RankEntry | null } | null>(null);
  const newest = entriesNewestFirst()[0];
  const id = newest?.[0] ?? null;
  useEffect(() => {
    if (!id) return setLine(null);
    let cancelled = false;
    void (async () => {
      const [doc, entry] = await Promise.all([getResumeDoc(id).catch(() => null), buildId ? getRankEntry(id, buildId).catch(() => null) : null]);
      if (!cancelled) setLine({ id, doc, entry });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, buildId, entries]);
  if (!id || !line) return null;
  const doc = line.doc;
  let text: React.ReactNode;
  if (!doc || doc.status === 'queued') text = site.landing.entryPending;
  else if (doc.status !== 'analyzed') text = doc.status.replace('_', ' ');
  else {
    const g = ratingViews(doc, line.entry).find((r) => r.category === 'general');
    if (!g || !g.rated || g.provisional) text = site.landing.entryAnalysed;
    else
      text = (
        <>
          <span className="num">{fmtRatingWithRd(g.r, g.pm)}</span> · <TierLabel tier={g.tier} /> · <Num value={g.rank} kind="rank" /> general
        </>
      );
  }
  return (
    <p className="your-entry">
      {site.landing.yourEntry}: <Link to={`/r/${id}`}>{text}</Link>
    </p>
  );
}
