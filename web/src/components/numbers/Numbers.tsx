// Num, TierLabel, RatingDisplay, Outcome, Record, Sparkline, RankTable, ScoreBars, StatLine.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PROVISIONAL_BLURB, TIER_BY_KEY, type TierKey } from '@resumearena/shared';
import { result as copy } from '../../copy/result.ts';
import { CATEGORY_LABEL, deltaClass, fmtCount, fmtDelta, fmtInt, fmtPct, fmtRank, fmtRating, fmtRd, fmtTopPct, fmtUsd } from '../../lib/format.ts';
import { markRevealed, readRevealed } from '../../lib/storage.ts';
import type { RatingView, SparkPoint, SubScoreView } from '../../lib/views.ts';

export type NumKind = 'int' | 'rating' | 'rank' | 'delta' | 'pct' | 'top' | 'rd' | 'usd' | 'count';

/** The single number formatter. Pages never format numbers inline. */
export function Num({ value, kind = 'int', className, own = false, title }: { value: number | null | undefined; kind?: NumKind; className?: string; own?: boolean; title?: string }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span className={['num', 'muted', className ?? ''].join(' ').trim()} aria-label="not available">
        —
      </span>
    );
  }
  let text: string;
  let extra = '';
  switch (kind) {
    case 'rating':
      text = fmtRating(value);
      break;
    case 'rank':
      text = fmtRank(value);
      break;
    case 'delta':
      text = fmtDelta(value);
      extra = deltaClass(value);
      break;
    case 'pct':
      text = fmtPct(value);
      break;
    case 'top':
      text = fmtTopPct(value, { own });
      break;
    case 'rd':
      text = fmtRd(value);
      break;
    case 'usd':
      text = fmtUsd(value);
      break;
    case 'count':
      text = fmtCount(value);
      break;
    default:
      text = fmtInt(value);
  }
  return (
    <span className={['num', extra, className ?? ''].join(' ').trim()} title={title}>
      {text}
    </span>
  );
}

export function TierLabel({ tier, numeral = true, withBlurb = false, provisional = false }: { tier: TierKey; numeral?: boolean; withBlurb?: boolean; provisional?: boolean }) {
  const t = TIER_BY_KEY[tier];
  return (
    <span title={withBlurb ? (provisional ? PROVISIONAL_BLURB : t.blurb) : undefined}>
      {t.label}
      {numeral ? <span className="tier-numeral">{t.numeral}</span> : null}
    </span>
  );
}

export interface RatingDisplayProps {
  rating: number | null;
  pm: number | null;
  tier: TierKey | null;
  provisional?: { done: number; total: number } | null;
  delta7?: number | null;
  size?: 'lg' | 'md' | 'sm';
  /** The result id; when set and not yet revealed in this browser, runs the one-time wipe. */
  revealOnce?: string | undefined;
  notPlacedLabel?: string;
}

export function RatingDisplay({ rating, pm, tier, provisional = null, delta7 = null, size = 'lg', revealOnce, notPlacedLabel }: RatingDisplayProps) {
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!revealOnce || rating === null) return;
    if (readRevealed()[revealOnce]) return;
    setReveal(true);
    markRevealed(revealOnce);
  }, [revealOnce, rating]);
  const unrated = rating === null;
  return (
    <div className={['rating', `rating--${size}`].join(' ')} aria-live="polite">
      <div className="rating-line">
        <span className="rating-num" aria-label={unrated ? 'not yet rated' : `rating ${fmtRating(rating)}`}>
          {unrated ? '———' : fmtRating(rating)}
          {reveal ? <span className="reveal-mask" aria-hidden="true" /> : null}
        </span>
        <span className={['rating-pm', reveal ? 'reveal-fade' : ''].join(' ').trim()} title={copy.rating.pmTooltip}>
          {pm === null ? '±——' : fmtRd(pm)}
        </span>
      </div>
      <div className={['rating-tier', reveal ? 'reveal-fade' : ''].join(' ').trim()}>
        {unrated || tier === null ? (
          <span className="muted">{notPlacedLabel ?? copy.rating.notPlaced}</span>
        ) : provisional && provisional.done < provisional.total ? (
          <span className="muted">{copy.rating.provisional(provisional.done, provisional.total)}</span>
        ) : (
          <TierLabel tier={tier} withBlurb />
        )}
      </div>
      {delta7 !== null && delta7 !== undefined && !unrated ? (
        <div className={['rating-delta', deltaClass(delta7)].join(' ')}>{copy.rating.delta7d(fmtDelta(delta7))}</div>
      ) : null}
    </div>
  );
}

const OUTCOME_LABEL = { W: 'win', L: 'loss', D: 'draw' } as const;

export function Outcome({ value }: { value: 'W' | 'L' | 'D' }) {
  const cls = value === 'W' ? 'win' : value === 'L' ? 'loss' : 'draw';
  return (
    <span className={['outcome', cls].join(' ')} aria-label={OUTCOME_LABEL[value]}>
      {value}
    </span>
  );
}

export function Record({ w, l, d }: { w: number; l: number; d: number }) {
  return (
    <span className="num" aria-label={`${w} wins, ${l} losses, ${d} draws`}>
      {w}-{l}-{d}
    </span>
  );
}

export function Sparkline({ points, width = 400, height = 48 }: { points: SparkPoint[]; width?: number; height?: number }) {
  const geometry = useMemo(() => {
    if (points.length < 3) return null;
    const rs = points.map((p) => p.r);
    const min = Math.min(...rs);
    const max = Math.max(...rs);
    const span = max - min || 1;
    const pad = 2;
    const d = points
      .map((p, i) => {
        const x = pad + (i / (points.length - 1)) * (width - 2 * pad);
        const y = pad + (1 - (p.r - min) / span) * (height - 2 * pad);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
    return { d, min, max };
  }, [points, width, height]);
  if (!geometry) return null;
  const first = points[0]?.r ?? 0;
  const last = points[points.length - 1]?.r ?? 0;
  return (
    <div className="sparkline-wrap">
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Rating history: started ${fmtRating(first)}, now ${fmtRating(last)}, low ${fmtRating(geometry.min)}, high ${fmtRating(geometry.max)}`}>
        <title>{`${fmtRating(geometry.min)}–${fmtRating(geometry.max)}`}</title>
        <path d={geometry.d} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="sparkline-labels">
        <span>{fmtRating(geometry.min)}</span>
        <span>{fmtRating(geometry.max)}</span>
      </div>
    </div>
  );
}

export interface RankTableProps {
  ratings: RatingView[];
  primary: string;
  focusLinkFor(r: RatingView): string;
  own?: boolean;
}

export function RankTable({ ratings, primary, focusLinkFor, own = false }: RankTableProps) {
  return (
    <table className="data rank-table">
      <thead>
        <tr>
          <th scope="col">ladder</th>
          <th scope="col" className="num">
            rating
          </th>
          <th scope="col" className="num">
            rank
          </th>
          <th scope="col">percentile</th>
        </tr>
      </thead>
      <tbody>
        {ratings.map((r) => {
          const cls = r.category === primary ? 'primary' : 'other';
          if (!r.included) {
            return (
              <tr key={r.category} className={cls} title={copy.rank.notRatedTooltip}>
                <td>{r.category}</td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td className="muted">{copy.rank.notRated}</td>
              </tr>
            );
          }
          if (!r.rated || r.rank === null || r.top === null) {
            return (
              <tr key={r.category} className={cls}>
                <td>{r.category}</td>
                <td className="num">{r.rated ? <Num value={r.r} kind="rating" /> : '—'}</td>
                <td className="num">—</td>
                <td className="muted">{r.rated ? copy.rank.afterPlacement : copy.rank.waiting}</td>
              </tr>
            );
          }
          return (
            <tr key={r.category} className={cls}>
              <td>
                <Link to={focusLinkFor(r)}>{r.category}</Link>
              </td>
              <td className="num">
                <Num value={r.r} kind="rating" />
              </td>
              <td className="num">
                <Num value={r.rank} kind="rank" />
              </td>
              <td>
                <Num value={r.top} kind="top" own={own} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface ScoreBarsProps {
  rows: SubScoreView[];
  weightLabel?: string;
  showMedianNote?: boolean;
  expandable?: boolean;
  footer?: ReactNode;
}

/** A table, not a chart: the number is in a cell and the bar is decoration. */
export function ScoreBars({ rows, weightLabel, showMedianNote = false, expandable = false, footer }: ScoreBarsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();
  const hasWeight = rows.some((r) => r.weight !== undefined);
  const hasMedian = rows.some((r) => r.median !== null && r.median !== undefined);
  return (
    <div>
      <table className="data bars">
        <thead>
          <tr>
            <th scope="col">factor</th>
            <th scope="col" className="bar-cell">
              <span className="sr-only">bar</span>
            </th>
            {hasWeight ? (
              <th scope="col" className="num col-weight">
                {weightLabel ?? 'weight'}
              </th>
            ) : null}
            <th scope="col" className="num">
              {copy.breakdown.scoreHeader}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // The toggle is a real button in the label cell: keyboard and screen-reader operable, valid ARIA.
            const canExpand = expandable && Boolean(r.note);
            const expanded = canExpand && open === r.key;
            const noteId = `${baseId}-${r.key}`;
            return [
              <tr key={r.key} className={canExpand ? 'expandable' : undefined}>
                <td>
                  {canExpand ? (
                    <button type="button" className="bar-toggle" aria-expanded={expanded} {...(expanded ? { 'aria-controls': noteId } : {})} onClick={() => setOpen(expanded ? null : r.key)}>
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td className="bar-cell">
                  <div className="bar-track" aria-hidden="true">
                    <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} />
                    {r.median !== null && r.median !== undefined ? <div className="bar-tick" style={{ left: `${Math.max(0, Math.min(100, r.median))}%` }} /> : null}
                  </div>
                </td>
                {hasWeight ? <td className="num muted col-weight">{r.weight !== undefined ? r.weight.toFixed(2).replace(/^0/, '') : ''}</td> : null}
                <td className="num">
                  <Num value={r.score} />
                </td>
              </tr>,
              expanded ? (
                <tr key={`${r.key}-note`} id={noteId}>
                  <td colSpan={hasWeight ? 4 : 3} className="bar-note">
                    {r.note}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
      {showMedianNote && hasMedian ? <p className="bars-foot">{copy.breakdown.medianNote}</p> : null}
      {footer}
    </div>
  );
}

export function StatLine({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <p className="statline">
      {items.map((it) => (
        <span key={it.label}>
          <b>{it.value}</b> {it.label}
        </span>
      ))}
    </p>
  );
}

export { CATEGORY_LABEL };
