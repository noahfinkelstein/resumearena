// ArenaCard, JudgeReveal, StreakCounter, CategoryPicker.
import { Link } from 'react-router';
import { CATEGORIES, type ArenaPair, type Card, type Category } from '@resumearena/shared';
import { arena as copy } from '../../copy/arena.ts';
import type { Guess } from '../../lib/arena.ts';
import { CATEGORY_LABEL, fmtDelta, fmtPct, fmtRating, STAGE_LONG, deltaClass, fmtInt } from '../../lib/format.ts';
import { Button } from '../forms/Button.tsx';
import { SelectField } from '../forms/Fields.tsx';

const human = (s: string): string => s.replace(/_/g, ' ');

export interface ArenaCardProps {
  side: 'A' | 'B';
  card: Card;
  chosen?: boolean;
  winner?: boolean;
  onPick?: (() => void) | undefined;
  hotkey: string;
  disabled?: boolean;
}

/** Renders the anonymised Card: no name, contact, link or exact date ever existed in it. */
export function ArenaCard({ side, card, chosen = false, winner = false, onPick, hotkey, disabled = false }: ArenaCardProps) {
  const pubs = card.publications_summary;
  return (
    <article className={['arena-card', chosen ? 'arena-card--chosen' : '', winner ? 'arena-card--winner' : ''].join(' ').trim()} aria-label={`Resume ${side}`}>
      <div className="arena-card-head">
        <span className="arena-side">{side}</span>
        <span className="muted">
          {STAGE_LONG[card.career_stage]} · {copy.card.years(card.years_fulltime)}
        </span>
        {winner ? <span className="chip">{copy.card.judgeTag}</span> : null}
      </div>
      <div className="arena-card-body">
        <p>{card.headline}</p>
        {card.experiences.length ? (
          <>
            <h4>{copy.card.experience}</h4>
            {card.experiences.map((e, i) => (
              <div key={i} className="mt-2">
                <div className="role">
                  <span>
                    {e.role}, {e.org}
                    {e.org_tier !== 'unknown' ? <span className="muted"> · {e.org_tier}-tier</span> : null}
                  </span>
                  <span className="yrs">{e.years}</span>
                </div>
                {e.highlights.length ? (
                  <ul>
                    {e.highlights.map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
        {card.education.length ? (
          <>
            <h4>{copy.card.education}</h4>
            <ul>
              {card.education.map((ed, i) => (
                <li key={i}>
                  {human(ed.degree_level)} {ed.field ? `in ${ed.field}` : ''}, {ed.institution}
                  {ed.institution_tier !== 'unknown' ? ` (${ed.institution_tier})` : ''}
                  {ed.end_year ? `, ${ed.in_progress ? 'expected ' : ''}${ed.end_year}` : ''}
                  {ed.gpa_band !== 'not_listed' && ed.gpa_band !== 'non_us_scale' ? ` · GPA ${ed.gpa_band}` : ''}
                  {ed.honors.length ? ` · ${ed.honors.join(', ')}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {card.projects.length ? (
          <>
            <h4>{copy.card.projects}</h4>
            <ul>
              {card.projects.map((p, i) => (
                <li key={i}>
                  {p.descriptor}
                  {p.highlight ? ` — ${p.highlight}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {pubs.count_total > 0 ? (
          <>
            <h4>{copy.card.publications}</h4>
            <p>
              {fmtInt(pubs.count_total)} {pubs.count_total === 1 ? 'publication' : 'publications'}
              {pubs.first_author_count ? `, ${pubs.first_author_count} first-author` : ''}
              {pubs.top_venue_count ? `, ${pubs.top_venue_count} at top venues` : ''}
              {pubs.venues.length ? ` (${pubs.venues.slice(0, 4).join(', ')})` : ''}
              {pubs.citation_signal !== 'not stated' ? ` · ${pubs.citation_signal}` : ''}
            </p>
          </>
        ) : null}
        {card.awards.length ? (
          <>
            <h4>{copy.card.awards}</h4>
            <ul>
              {card.awards.map((a, i) => (
                <li key={i}>
                  {a.name}
                  <span className="muted">
                    {' '}
                    · {human(a.selectivity)}, {a.scope}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {card.leadership.length ? (
          <>
            <h4>{copy.card.leadership}</h4>
            <ul>
              {card.leadership.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </>
        ) : null}
        {card.notable.length ? (
          <>
            <h4>{copy.card.notable}</h4>
            <ul>
              {card.notable.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </>
        ) : null}
        {card.skills_top.length ? (
          <>
            <h4>{copy.card.skills}</h4>
            <p className="muted">{card.skills_top.join(' · ')}</p>
          </>
        ) : null}
      </div>
      {onPick ? (
        <div className="arena-card-foot">
          <Button variant="primary" onClick={onPick} disabled={disabled} aria-keyshortcuts={hotkey}>
            {side}
          </Button>
          <span className="muted xs">
            {copy.card.key} <kbd className="kbd">{hotkey}</kbd>
          </span>
        </div>
      ) : null}
    </article>
  );
}

export interface JudgeRevealProps {
  pair: ArenaPair;
  guess: Guess;
  identities: { a: { label: string; href: string | null }; b: { label: string; href: string | null } };
  agreed: boolean;
}

export function JudgeReveal({ pair, guess, identities, agreed }: JudgeRevealProps) {
  const ident = (side: { label: string; href: string | null }) => (side.href ? <Link to={side.href}>{side.label}</Link> : <span className="muted">{side.label}</span>);
  return (
    <div className="arena-reveal" aria-live="polite">
      <p className="verdict-line">{pair.w === 'draw' ? copy.draw : copy.preferred(pair.w)}</p>
      <p className="reason">{pair.reason}</p>
      <p className="moves">
        <span>
          A {fmtRating(pair.a.r_before)} → <span className={deltaClass(pair.a.delta)}>{fmtDelta(pair.a.delta)}</span>
        </span>
        <span>
          B {fmtRating(pair.b.r_before)} → <span className={deltaClass(pair.b.delta)}>{fmtDelta(pair.b.delta)}</span>
        </span>
        <span>
          A {ident(identities.a)} · B {ident(identities.b)}
        </span>
      </p>
      <p className="mt-3">{agreed ? (guess === 'draw' ? copy.drawGuess : copy.agree) : copy.disagree}</p>
    </div>
  );
}

export function StreakCounter({ streak, guesses, agreedPct }: { streak: number; guesses: number; agreedPct: number | null }) {
  return (
    <p className="streak" aria-live="off">
      <span>{copy.streak(streak)}</span>
      <span>{copy.guesses(fmtInt(guesses))}</span>
      {agreedPct !== null ? <span>{copy.agreement(fmtPct(agreedPct))}</span> : null}
    </p>
  );
}

export function CategoryPicker({ value, onChange }: { value: Category; onChange(c: Category): void }) {
  return (
    <SelectField label={copy.category} value={value} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} onChange={(v) => onChange(v as Category)} />
  );
}
