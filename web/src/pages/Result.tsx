import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CATEGORIES, ID_RE, newId, RANK_KEY, type Category, type HistoryDoc, type LadderMeta, type SubmissionPayload } from '@resumearena/shared';
import { Page, Section } from '../components/chrome/Chrome.tsx';
import { Button, LinkButton } from '../components/forms/Button.tsx';
import { ErrorState } from '../components/forms/States.tsx';
import { useToast } from '../components/forms/Toast.tsx';
import { Num, RankTable, RatingDisplay, ScoreBars, Sparkline } from '../components/numbers/Numbers.tsx';
import { AtsPanel, ManageLink, PollingStatus, RedFlags, ShareButton, StrengthsWeaknesses, SubmittedText, Verdict } from '../components/result/Result.tsx';
import { MatchList } from '../components/tables/Tables.tsx';
import { result as copy } from '../copy/result.ts';
import { getHistoryDoc, getLadderMeta, getManifest, getRankEntries, getRankEntry, getResumeDoc, getStatus, type RankLookup } from '../lib/data.ts';
import { fmtClock, fmtDate, STAGE_LONG } from '../lib/format.ts';
import { dispatchWithRetry } from '../lib/github.ts';
import { hashOf, keyFor, recordEntry, useIdentity, useOwnerOf } from '../lib/identity.ts';
import { createPoller, type Phase, type PollState, type Poller } from '../lib/polling.ts';
import { readDraft, readRevealed, writeDraft, type Draft } from '../lib/storage.ts';
import { displayedOpponentIds, EMPTY_LOOKUP, focusLink, resultView } from '../lib/views.ts';
import { NotFound } from './NotFound.tsx';

export function Result() {
  const { id = '' } = useParams();
  if (!ID_RE.test(id)) return <NotFound />;
  return <ResultInner key={id} id={id} />;
}

function ResultInner({ id }: { id: string }) {
  const { entries, keys } = useIdentity();
  const entry = entries[id];
  const mode = entry ? 'submitter' : 'visitor';
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState<PollState | null>(null);
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const key = entry ? keys[entry.handle] : undefined;
      const ownerHash = key ? await hashOf(key) : (entry?.owner_hash ?? null);
      if (cancelled) return;
      const submittedAt = entry ? Date.parse(entry.submitted_at) || Date.now() : Date.now();
      pollerRef.current = createPoller(
        { id, mode, ownerHash, submittedAt, via: entry?.via ?? 'dispatch' },
        {
          fetchDoc: (docId, polling, source) => getResumeDoc(docId, { polling, source }),
          fetchManifest: () => getManifest(),
          fetchRank: (docId, buildId) => getRankEntry(docId, buildId),
          fetchStatus: () => getStatus(),
          remint: async () => {
            const sent = await remintFromDraft(id);
            if (sent) navigate(`/r/${sent.id}`, { replace: true });
            return null;
          },
          redirect: (to) => navigate(`/r/${to}`, { replace: true }),
          onRated: () => {
            // The 'your resume is rated' toast is for the person who submitted it, once.
            if (mode === 'submitter' && !readRevealed()[id]) toast.show(copy.placed.toast);
          },
          onState: (s) => {
            if (!cancelled) setState(s);
          },
        },
      );
    })();
    const onVis = (): void => pollerRef.current?.dispatch({ type: 'visibility', now: Date.now(), hidden: document.hidden });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      pollerRef.current?.stop();
      pollerRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode]);

  const doc = state?.doc ?? null;
  const ownerHandle = useOwnerOf(doc?.owner_hash);
  const isOwner = ownerHandle !== null;

  // Secondary fan-out once the doc is analysed: histories (≤ 4), the shards of the opponents on the rows that
  // will be shown (≤ 10, so the fetch cap is never reached), the primary ladder's medians.
  const [extra, setExtra] = useState<{ histories: Partial<Record<Category, HistoryDoc>>; opponents: RankLookup; medians: LadderMeta['medians'] | null; forBuild: string | null }>({ histories: {}, opponents: EMPTY_LOOKUP, medians: null, forBuild: null });
  const rankBuildId = state?.rankBuildId ?? null;
  const ratedCats = useMemo(() => (state?.rank ? CATEGORIES.filter((c) => state.rank?.[RANK_KEY[c]]) : []), [state?.rank]);
  useEffect(() => {
    if (!doc || doc.status !== 'analyzed' || !rankBuildId || extra.forBuild === rankBuildId) return;
    let cancelled = false;
    void (async () => {
      const histories: Partial<Record<Category, HistoryDoc>> = {};
      await Promise.all(
        ratedCats.map(async (c) => {
          const h = await getHistoryDoc(c, doc.id).catch(() => null);
          if (h) histories[c] = h;
        }),
      );
      const oppIds = displayedOpponentIds(histories);
      const [opponents, meta] = await Promise.all([getRankEntries(oppIds, rankBuildId), getLadderMeta(doc.primary, rankBuildId).catch(() => null)]);
      if (!cancelled) setExtra({ histories, opponents, medians: meta?.medians ?? null, forBuild: rankBuildId });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, rankBuildId, ratedCats, extra.forBuild]);

  if (!state) return <Page title={copy.titlePending}>{null}</Page>;
  const phase = state.phase;

  if (phase === 'not_found') return <NotFound extra={copy.notFound.publishing} />;

  const resend = async (): Promise<void> => {
    const draft = readDraft();
    const sent = draft?.sent?.id === id ? draft.sent : null;
    if (!sent) {
      toast.show('The text is no longer in this browser. Upload it again.', { error: true });
      return;
    }
    const r = await dispatchWithRetry(sentPayload(sent));
    toast.show(r.ok ? 'Sent again.' : 'Could not send. Try again in a minute.', { error: !r.ok });
  };

  if (!doc) {
    const submittedAt = state.cfg.submittedAt;
    if (mode === 'visitor') {
      // Someone else's link, opened before the file exists (§11.2 visitor rows): nothing here is theirs.
      return (
        <Page title={copy.visitorPending.title} width="prose">
          <header className="page-head">
            <p className="ident-line">
              <span className="mono">{id}</span>
            </p>
            <ShareButton url={window.location.href} pendingHint />
          </header>
          <h1 className="page-title">{copy.visitorPending.heading}</h1>
          <p className="page-lead">{copy.visitorPending.body}</p>
          <PollingStatus phase={phase} mode={mode} via={state.cfg.via} submittedAt={submittedAt} placement={null} queueAhead={state.status?.queue.placement ?? null} />
        </Page>
      );
    }
    return (
      <Page title={copy.titlePending} width="prose">
        <header className="page-head">
          <p className="ident-line">
            {entry ? <span className="ident">{entry.handle}</span> : null}
            {entry ? <span>{entry.ladder_hint}</span> : null}
            <span>submitted {fmtClock(new Date(submittedAt))}</span>
          </p>
          <ShareButton url={window.location.href} pendingHint />
        </header>
        <h1 className="page-title">{copy.pending.heading}</h1>
        <p className="page-lead">{copy.pending.timing}</p>
        <PollingStatus phase={phase} mode={mode} via={state.cfg.via} submittedAt={submittedAt} placement={null} queueAhead={state.status?.queue.placement ?? null} onResubmit={() => void resend()} />
        <p className="muted">{copy.pending.keepChecking}</p>
        <Section heading={copy.pending.whatNow.heading}>
          <ol>
            {copy.pending.whatNow.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Section>
      </Page>
    );
  }

  // Terminal and holding states.
  const draft = readDraft();
  const hasText = Boolean(draft?.text);
  const backAction = hasText ? (
    <LinkButton to="/upload?restore=1" variant="primary">
      {copy.rejected.backToText}
    </LinkButton>
  ) : (
    <LinkButton to="/upload" variant="primary">
      {copy.rejected.uploadAgain}
    </LinkButton>
  );
  const stateBlock = (title: string, body: string, action: React.ReactNode = backAction, extra?: React.ReactNode) => (
    <Page title={title} width="prose">
      <div className="page-head">
        <p className="ident-line">
          <span className="mono">{id}</span>
        </p>
      </div>
      <ErrorState title={title} body={body} extra={action} />
      {extra}
    </Page>
  );

  switch (phase) {
    case 'queued': {
      const paused = doc.queue_reason === 'paused';
      return stateBlock(copy.state.queued.title, paused ? copy.state.queuedPaused : copy.state.queued.body(state.status?.queue.analysis ?? null), <ShareButton url={window.location.href} pendingHint />);
    }
    case 'held':
      return stateBlock(copy.held.pii.title, copy.held.pii.body);
    case 'held_injection':
      return stateBlock(copy.held.injection.title, copy.held.injection.body);
    case 'needs_review':
      return stateBlock(copy.needsReview.title, copy.needsReview.body);
    case 'rejected': {
      const code = doc.rejected_reason ?? 'bad_payload';
      const c = copy.rejected[code as keyof typeof copy.rejected] as { title: string; body: string | ((h: string) => string) } | undefined;
      const title = c?.title ?? copy.rejected.bad_payload.title;
      const body = typeof c?.body === 'function' ? c.body(doc.handle) : (c?.body ?? copy.rejected.bad_payload.body);
      return stateBlock(title, body);
    }
    case 'duplicate':
      return stateBlock(copy.duplicate.title, copy.duplicate.body, doc.duplicate_of ? <Link to={`/r/${doc.duplicate_of}`}>{copy.duplicate.original} →</Link> : backAction);
    case 'deleted':
      return stateBlock(copy.deleted.title, copy.deleted.body, <LinkButton to="/leaderboard/general" variant="secondary">The general ladder</LinkButton>);
    case 'superseded':
      return stateBlock(copy.superseded.note, '', doc.superseded_by ? <Link to={`/r/${doc.superseded_by}`}>Current version →</Link> : null);
    case 'collision':
      return stateBlock(copy.collision.title, copy.collision.body, null);
    default:
      break;
  }

  // Analysed, placing, budget_wait, rated.
  const view = resultView({ doc, entry: state.rank, histories: extra.histories, opponents: extra.opponents, medians: extra.medians });
  const general = view.generalRating;
  const rated = phase === 'rated' || (general !== null && !general.provisional);
  const title = `${view.identity.value} · ${view.primary}`;
  const pendingPhase: Phase = phase;
  return (
    <Page title={title} width="prose">
      <header className="page-head">
        <p className="ident-line">
          <span className="ident">{view.identity.value}</span>
          <span>
            {view.primary}
            {view.stage ? `, ${STAGE_LONG[view.stage]}` : ''}
          </span>
          <span>submitted {fmtDate(view.createdAt)}</span>
        </p>
        <span className="inline-list">
          <ShareButton url={window.location.href} pendingHint={!rated} />
          {isOwner ? <ManageLink handle={view.handle} /> : null}
        </span>
      </header>

      <div className="rating-grid">
        <div>
          <RatingDisplay
            rating={general?.rated ? general.r : null}
            pm={general?.rated ? general.pm : null}
            tier={general?.rated ? general.tier : null}
            provisional={general?.rated ? general.placement : null}
            delta7={general?.rated && !general.provisional ? general.delta7 : null}
            revealOnce={rated && mode === 'submitter' ? id : undefined}
          />
          {view.spark.length >= 3 ? <Sparkline points={view.spark} /> : null}
          {!rated ? (
            <PollingStatus phase={pendingPhase} mode={mode} via={state.cfg.via} submittedAt={state.cfg.submittedAt} placement={state.placement} queueAhead={state.status?.queue.placement ?? null} compact />
          ) : null}
        </div>
        <RankTable ratings={view.ratings} primary={view.primary} focusLinkFor={(r) => focusLink(id, r.category, r.rank)} own={isOwner} />
      </div>

      {view.verdict ? (
        <Section heading={copy.section.verdict} rule>
          <Verdict text={view.verdict} />
        </Section>
      ) : null}

      {view.breakdown.length ? (
        <Section heading={copy.section.breakdown} rule>
          <ScoreBars
            rows={view.stageRelative ? [...view.breakdown, view.stageRelative] : view.breakdown}
            weightLabel={copy.breakdown.weightHeader(view.primary)}
            showMedianNote
            footer={
              <p className="bars-foot">
                {view.headline.map((h, i) => (
                  <span key={h.category}>
                    {i > 0 ? ' · ' : ''}
                    {h.category} <Num value={h.score} />
                  </span>
                ))}{' '}
                <span className="xs">{copy.breakdown.headlineSuffix}</span>
              </p>
            }
          />
          {view.rationale ? (
            <p className="bars-rationale">
              <span className="rationale-head">{copy.breakdown.why(view.primary)}</span> {view.rationale}
            </p>
          ) : null}
        </Section>
      ) : null}

      {view.strengths.length || view.weaknesses.length ? (
        <Section rule>
          <StrengthsWeaknesses strengths={view.strengths} weaknesses={view.weaknesses} />
        </Section>
      ) : null}

      {view.ats ? (
        <Section heading={copy.section.ats} rule>
          <AtsPanel score={view.ats.score} fixes={view.ats.fixes} factors={view.ats.factors} target={view.ats.target} />
        </Section>
      ) : null}

      {view.redFlags.length ? (
        <Section heading={copy.section.redFlags} rule>
          <RedFlags flags={view.redFlags} />
        </Section>
      ) : null}

      <Section heading={copy.section.matches} rule aside={view.games > 0 ? <span className="updated">{copy.matches.games(view.games)}</span> : null}>
        {view.matches.length ? (
          <MatchList matches={view.matches} />
        ) : (
          <p className="muted">
            {copy.matches.empty.title} {copy.matches.empty.body}
          </p>
        )}
      </Section>

      {view.text ? (
        <Section rule>
          <SubmittedText text={view.text} metrics={view.metrics} isOwner={isOwner} />
        </Section>
      ) : null}
      {phase === 'stale' ? (
        <Button variant="quiet" onClick={() => void resend()}>
          {copy.state.staleResubmit}
        </Button>
      ) : null}
    </Page>
  );
}

/** The stored payload carries no key (§11.4); a resubmission gets it back from resumearena.keys at send time. */
function sentPayload(sent: NonNullable<Draft['sent']>): SubmissionPayload {
  return sent.withKey ? { ...sent.payload, owner_key: keyFor(sent.payload.handle) ?? '' } : sent.payload;
}

/** Id collision (§3.2): mint a new id and resend the same payload once, if the text is still in this browser. */
async function remintFromDraft(oldId: string): Promise<{ id: string } | null> {
  const draft = readDraft();
  if (!draft?.sent || draft.sent.id !== oldId) return null;
  const id = newId();
  const payload: SubmissionPayload = { ...sentPayload(draft.sent), submission_id: id };
  const r = await dispatchWithRetry(payload);
  if (!r.ok) return null;
  recordEntry(id, { handle: payload.handle, owner_hash: payload.owner_hash, submitted_at: new Date().toISOString(), via: 'dispatch', ladder_hint: (payload.ladder_hint || 'general') as Category });
  writeDraft({ ...draft, sent: { ...draft.sent, id, payload: { ...payload, owner_key: '' } } });
  return { id };
}
