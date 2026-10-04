import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { CATEGORIES, validateHandle, type Category, type HistoryDoc, type RankEntry, type ResumeDoc, type UserDoc } from '@resumearena/shared';
import { Page, Section } from '../components/chrome/Chrome.tsx';
import { Button } from '../components/forms/Button.tsx';
import { ErrorState } from '../components/forms/States.tsx';
import { RankTable, RatingDisplay } from '../components/numbers/Numbers.tsx';
import { Chip, RatingHistoryTable } from '../components/tables/Tables.tsx';
import { errors } from '../copy/errors.ts';
import { me as meCopy } from '../copy/me.ts';
import { getHistoryDoc, getManifest, getRankEntry, getResumeDoc, getUserDoc } from '../lib/data.ts';
import { fmtDate } from '../lib/format.ts';
import { useOwnerOf } from '../lib/identity.ts';
import { useData } from '../lib/useData.ts';
import { focusLink, historyEvents, profileView } from '../lib/views.ts';
import { NotFound } from './NotFound.tsx';

interface ProfileData {
  user: UserDoc | null;
  doc: ResumeDoc | null;
  entry: RankEntry | null;
  histories: Partial<Record<Category, HistoryDoc>>;
}

export function Profile() {
  const { handle = '' } = useParams();
  const valid = validateHandle(handle) === 'ok';
  const { data, error, loading, reload } = useData<ProfileData>(
    async (signal) => {
      const user = await getUserDoc(handle, { signal });
      const current = user?.resumes.find((r) => r.current)?.id ?? null;
      if (!user || !current) return { user, doc: null, entry: null, histories: {} };
      const manifest = await getManifest({ signal });
      const [doc, entry] = await Promise.all([getResumeDoc(current, { signal }), manifest ? getRankEntry(current, manifest.build_id, { signal }) : null]);
      const histories: Partial<Record<Category, HistoryDoc>> = {};
      const rated = CATEGORIES.filter((c) => entry?.[c === 'general' ? 'g' : c === 'finance' ? 'f' : c === 'tech' ? 't' : 'a']);
      await Promise.all(
        rated.map(async (c) => {
          const h = await getHistoryDoc(c, current, { signal }).catch(() => null);
          if (h) histories[c] = h;
        }),
      );
      return { user, doc, entry, histories };
    },
    [handle],
    { enabled: valid },
  );
  const ownerHandle = useOwnerOf(data?.user?.owner_hash ?? data?.doc?.owner_hash);
  const [showHistory, setShowHistory] = useState(false);

  if (!valid) return <NotFound title={errors.profileNotFound.title} body={errors.profileNotFound.body} />;
  if (error && !data) {
    return (
      <Page title={handle} width="prose">
        <ErrorState title={errors.dataError.title} body={errors.dataError.body} retry={reload} />
      </Page>
    );
  }
  if (loading && !data) {
    return (
      <Page title={handle} width="prose">
        <div className="page-head">
          <h1 className="page-title">{handle}</h1>
        </div>
      </Page>
    );
  }
  const user = data?.user ?? null;
  const doc = data?.doc ?? null;
  const isOwner = ownerHandle !== null;
  const visible = doc ? doc.visibility === 'handle' : (data?.entry?.v ?? 'anonymous') === 'handle';
  if (!user || user.state === 'tombstone' || !data?.user?.resumes.some((r) => r.current)) return <NotFound title={errors.profileNotFound.title} body={meCopy.errors.noEntry.body} />;
  if (!visible && !isOwner) return <NotFound title={errors.profileNotFound.title} body={errors.profileNotFound.body} />;

  const view = profileView(user, doc, data.entry);
  const primary = view.ratings.find((r) => r.category === view.primary && r.rated) ?? view.ratings.find((r) => r.rated) ?? null;
  const history = view.primary ? (data.histories[view.primary] ?? data.histories.general ?? null) : null;
  return (
    <Page title={handle} width="prose">
      <div className="page-head">
        <div>
          <h1 className="page-title">{handle}</h1>
          <p className="muted small">
            entered {fmtDate(view.enteredAt)}
            {view.versions > 1 ? (
              <>
                {' '}
                <Chip variant="warn">resubmitted {view.versions - 1}×</Chip>
              </>
            ) : null}
          </p>
        </div>
        {view.currentId ? <Link to={`/r/${view.currentId}`}>Full result →</Link> : null}
      </div>
      {!visible && isOwner ? <p className="muted small">Only you can see this page: the entry is anonymous.</p> : null}
      <Section>
        <RatingDisplay size="md" rating={primary && !primary.provisional ? primary.r : null} pm={primary && !primary.provisional ? primary.pm : null} tier={primary?.tier ?? null} delta7={primary?.delta7 ?? null} />
        {view.ratings.length ? (
          <div className="mt-5">
            <RankTable ratings={view.ratings} primary={view.primary ?? 'general'} focusLinkFor={(r) => focusLink(view.currentId ?? '', r.category, r.rank)} own={isOwner} />
          </div>
        ) : null}
      </Section>
      {history ? (
        <Section heading="Rating history" rule>
          {showHistory ? (
            <RatingHistoryTable events={historyEvents(history)} />
          ) : (
            <Button variant="quiet" onClick={() => setShowHistory(true)}>
              show history
            </Button>
          )}
        </Section>
      ) : null}
      {isOwner ? (
        <p className="mt-6">
          <Link to={`/me?handle=${encodeURIComponent(handle)}`}>Manage this entry →</Link>
        </p>
      ) : null}
    </Page>
  );
}
