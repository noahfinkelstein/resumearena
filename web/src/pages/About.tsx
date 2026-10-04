import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PROVISIONAL_BLURB, TIERS, type PublicSettings, type PublicStatus } from '@resumearena/shared';
import { StatusBlock } from '../components/about/StatusBlock.tsx';
import { Page } from '../components/chrome/Chrome.tsx';
import { about as copy } from '../copy/about.ts';
import { getSettings, getStatus } from '../lib/data.ts';
import { fmtRange } from '../lib/format.ts';
import { contactEmail, probeToken, repoUrl, type ProbeResult } from '../lib/github.ts';
import { useData } from '../lib/useData.ts';

export function About() {
  const status = useData<PublicStatus>((signal) => getStatus({ signal }), [], { every: 5 * 60_000 });
  const settings = useData<PublicSettings>((signal) => getSettings({ signal }), []);
  const [channel, setChannel] = useState<ProbeResult | 'checking'>('checking');
  const { hash } = useLocation();

  useEffect(() => {
    let cancelled = false;
    probeToken().then((r) => {
      if (!cancelled) setChannel(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView();
  }, [hash]);

  const email = contactEmail();
  const tiers = settings.data?.tiers ?? TIERS;
  const limits = settings.data?.limits ?? null;
  return (
    <Page title={copy.title} width="prose">
      <div className="page-head">
        <h1 className="page-title">{copy.title}</h1>
      </div>
      <nav className="anchor-row" aria-label="Sections">
        {copy.anchors.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <article className="prose mt-5">
        <h2 id="rating">{copy.anchors[0][1]}</h2>
        <p>{copy.rating.p1}</p>
        <p>{copy.rating.p2}</p>
        <p>{copy.rating.p3}</p>
        <h3>{copy.rating.tiersHeading}</h3>
        <table className="data tiers-table">
          <thead>
            <tr>
              <th scope="col">tier</th>
              <th scope="col" className="num">
                rating
              </th>
              <th scope="col">what it means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{copy.rating.provisional}</td>
              <td className="num muted">—</td>
              <td>{PROVISIONAL_BLURB}</td>
            </tr>
            {tiers.map((t, i) => {
              const next = tiers[i + 1];
              const range = i === 0 ? `< ${next?.min ?? ''}` : next ? fmtRange(t.min, next.min - 1) : `${t.min}+`;
              return (
                <tr key={t.key}>
                  <td>
                    {t.label} <span className="tier-numeral">{t.numeral}</span>
                  </td>
                  <td className="num">{range}</td>
                  <td>{t.blurb}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2 id="judge">{copy.anchors[1][1]}</h2>
        <p>{copy.judge.p1}</p>
        <p>{copy.judge.p2}</p>
        <p>
          {copy.judge.p3}
          {settings.data ? (
            <span className="muted">
              {' '}
              Analysis: <span className="mono xs">{settings.data.models.analyst}</span>; matches: <span className="mono xs">{settings.data.models.judge}</span>; gate: <span className="mono xs">{settings.data.models.gate}</span>.
            </span>
          ) : null}
        </p>
        <p>{copy.judge.p4}</p>

        <h2 id="writes">{copy.anchors[2][1]}</h2>
        <p>{copy.writes.p1}</p>

        <h2 id="ladders">{copy.anchors[3][1]}</h2>
        <p>{copy.ladders.p1}</p>
        <p>{copy.ladders.p2}</p>

        <h2 id="limits">{copy.anchors[4][1]}</h2>
        <p>{copy.limits.p1}</p>
        <p>{copy.limits.p2}</p>
        <p>{copy.limits.p3}</p>
        {limits ? (
          <p className="muted small">
            Current limits: {limits.min_chars.toLocaleString()}–{limits.max_chars.toLocaleString()} characters, {Math.round(limits.max_file_bytes / 1048576)} MB files, {limits.max_submissions_per_hour} entries an hour.
          </p>
        ) : null}

        <h2 id="privacy">{copy.anchors[5][1]}</h2>
        <p>{copy.privacy.p1}</p>
        <p>{copy.privacy.p2}</p>
        <p>{copy.privacy.p3}</p>
        <p>
          {copy.privacy.p4} <Link to="/me">Manage your entry</Link>.
        </p>

        <h2 id="status">{copy.anchors[6][1]}</h2>
        <StatusBlock status={status.data} channel={channel} error={status.error !== null && status.data === null} />

        <h2 id="contact">{copy.anchors[7][1]}</h2>
        <p>
          {copy.contact.p1}{' '}
          {email ? (
            <a href={`mailto:${email}`}>{email}</a>
          ) : (
            <>
              {copy.contact.noEmail} (
              <a href={`${repoUrl()}/issues`} rel="noreferrer">
                {copy.contact.issues}
              </a>
              )
            </>
          )}
          .{' '}
          <a href={repoUrl()} rel="noreferrer">
            {copy.contact.repo}
          </a>
          .
        </p>
      </article>
    </Page>
  );
}
