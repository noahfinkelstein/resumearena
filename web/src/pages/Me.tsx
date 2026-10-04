import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { buildPayload, hashOwnerKey, type RankEntry, type ResumeDoc, type SubmissionPayload, type UserDoc, type Visibility } from '@resumearena/shared';
import { Page, Section } from '../components/chrome/Chrome.tsx';
import { Button, LinkButton } from '../components/forms/Button.tsx';
import { SelectField } from '../components/forms/Fields.tsx';
import { EmptyState, ErrorState } from '../components/forms/States.tsx';
import { useToast } from '../components/forms/Toast.tsx';
import { DeleteEntry, DeviceKeys, EntrySummary, KeyInput, VisibilityControl } from '../components/manage/Manage.tsx';
import { me as copy } from '../copy/me.ts';
import { getManifest, getRankEntry, getResumeDoc, getUserDoc } from '../lib/data.ts';
import { clientVersion, dispatchWithRetry, manageEnabled, markProbeDead, probeToken, type ProbeResult } from '../lib/github.ts';
import { fmtClock } from '../lib/format.ts';
import { dropEntry, forget, hashOf, latestHandle, pendingEntryFor, remember, useIdentity } from '../lib/identity.ts';
import { profileView, resultView } from '../lib/views.ts';

interface Loaded {
  user: UserDoc;
  doc: ResumeDoc | null;
  entry: RankEntry | null;
}

export function Me() {
  const { keys, entries } = useIdentity();
  const [params] = useSearchParams();
  const handles = Object.keys(keys).sort();
  const initial = params.get('handle') && keys[params.get('handle') ?? ''] ? (params.get('handle') as string) : (latestHandle() ?? handles[0] ?? '');
  const [handle, setHandle] = useState(initial);
  const key = keys[handle] ?? null;
  const toast = useToast();
  const [probe, setProbe] = useState<ProbeResult | 'checking'>('checking');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<{ title: string; body: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // A deletion this page sent: shown after the key is forgotten, so the acknowledgement survives the unmount.
  const [deleted, setDeleted] = useState<{ handle: string; id: string } | null>(null);
  // The handle has no users/ doc yet but this browser dispatched an entry under it: analysis is still running.
  const pending = loadError === 'no_entry' ? pendingEntryFor(entries, handle) : null;

  useEffect(() => {
    probeToken().then(setProbe);
  }, []);

  useEffect(() => {
    if (!handle || !key) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const user = await getUserDoc(handle, { polling: true });
        if (cancelled) return;
        if (!user) return setLoadError('no_entry');
        if ((await hashOf(key)) !== user.owner_hash) return setLoadError('mismatch');
        const current = user.resumes.find((r) => r.current)?.id ?? null;
        if (!current) return setLoaded({ user, doc: null, entry: null });
        const manifest = await getManifest().catch(() => null);
        const [doc, entry] = await Promise.all([getResumeDoc(current, { polling: true }).catch(() => null), manifest ? getRankEntry(current, manifest.build_id).catch(() => null) : null]);
        if (!cancelled) setLoaded({ user, doc, entry });
      } catch {
        if (!cancelled) setLoadError('network');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handle, key, reloadTick]);

  // While the entry is being analysed, re-check the user doc every 60 s when the page is visible.
  useEffect(() => {
    if (!pending) return;
    let timer: number | null = null;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        if (document.hidden) schedule();
        else setReloadTick((t) => t + 1);
      }, 60_000);
    };
    const onVisible = (): void => {
      if (!document.hidden) setReloadTick((t) => t + 1);
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pending?.id]);

  const useKey = async (canonical: string, h: string): Promise<void> => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const user = await getUserDoc(h, { polling: true });
      if (!user) return setKeyError(copy.errors.noEntry);
      if ((await hashOwnerKey(canonical)) !== user.owner_hash) return setKeyError(copy.errors.wrongKey);
      remember(h, canonical);
      setHandle(h);
    } catch {
      setKeyError({ title: 'Could not check the key.', body: 'GitHub did not answer. Try again in a minute.' });
    } finally {
      setKeyBusy(false);
    }
  };

  const channelDown = probe === 'dead' || probe === 'limited';
  const enabled = manageEnabled();
  const profile = loaded ? profileView(loaded.user, loaded.doc, loaded.entry) : null;
  const result = loaded?.doc && loaded.doc.status === 'analyzed' ? resultView({ doc: loaded.doc, entry: loaded.entry }) : null;
  const currentId = profile?.currentId ?? null;
  const ownerHash = loaded?.user.owner_hash ?? '';

  const payloadFor = useCallback(
    (action: 'delete' | 'set_visibility', visibility?: Visibility): SubmissionPayload | null => {
      if (!key || !currentId) return null;
      return buildPayload({ action, id: currentId, handle, owner_hash: ownerHash, visibility: visibility ?? '', owner_key: key, client_version: clientVersion() });
    },
    [key, currentId, handle, ownerHash],
  );

  // Visibility: dispatch, then poll the raw doc every 60 s until the value flips or 15 minutes pass.
  const [visPending, setVisPending] = useState<{ since: number; next: Visibility; timedOut: boolean } | null>(null);
  const [visSending, setVisSending] = useState(false);
  const visTimer = useRef<number | null>(null);
  const currentVisibility: Visibility = loaded?.doc?.visibility ?? loaded?.entry?.v ?? 'anonymous';
  useEffect(() => {
    if (!visPending || visPending.timedOut || !currentId) return;
    const check = async (): Promise<void> => {
      const doc = await getResumeDoc(currentId, { polling: true }).catch(() => null);
      if (doc && doc.visibility === visPending.next) {
        setVisPending(null);
        setReloadTick((t) => t + 1);
        toast.show(visPending.next === 'handle' ? copy.visibility.toastShown(handle) : copy.visibility.toastAnon);
        return;
      }
      if (Date.now() - visPending.since > 15 * 60_000) {
        setVisPending({ ...visPending, timedOut: true });
        return;
      }
      visTimer.current = window.setTimeout(() => void check(), 60_000);
    };
    visTimer.current = window.setTimeout(() => void check(), 60_000);
    return () => {
      if (visTimer.current !== null) window.clearTimeout(visTimer.current);
    };
  }, [visPending, currentId, handle, toast]);

  const dispatchVisibility = async (next: Visibility): Promise<void> => {
    const p = payloadFor('set_visibility', next);
    if (!p) return;
    setVisSending(true);
    const r = await dispatchWithRetry(p);
    setVisSending(false);
    if (r.ok) setVisPending({ since: Date.now(), next, timedOut: false });
    else {
      if (r.kind === 'token_dead') {
        markProbeDead();
        setProbe('dead');
      }
      toast.show(copy.errors.channelDown.title, { error: true });
    }
  };

  const dispatchDelete = async (): Promise<'ok' | 'down' | 'failed'> => {
    const p = payloadFor('delete');
    if (!p) return 'failed';
    if (channelDown) return 'down';
    const r = await dispatchWithRetry(p);
    if (r.ok) {
      setDeleted({ handle, id: p.submission_id });
      afterDelete();
      return 'ok';
    }
    if (r.kind === 'token_dead') {
      markProbeDead();
      setProbe('dead');
      return 'down';
    }
    return 'failed';
  };

  const afterDelete = (): void => {
    for (const [id, rec] of Object.entries(entries)) if (rec.handle === handle) dropEntry(id);
    forget(handle);
  };

  const deletePayload = useMemo(() => payloadFor('delete'), [payloadFor]);
  const noKeys = handles.length === 0;

  return (
    <Page title={copy.title} width="narrow">
      <div className="page-head">
        <h1 className="page-title">{copy.title}</h1>
      </div>
      {!enabled ? <p className="warn">{copy.manageDisabled}</p> : null}

      <Section>
        {noKeys ? <EmptyState title={copy.empty.title} body={copy.empty.body} /> : null}
        {handles.length > 1 ? <SelectField label={copy.entryLabel} value={handle} options={handles.map((h) => ({ value: h, label: h }))} onChange={setHandle} /> : null}
        <KeyInput initialHandle={handle} busy={keyBusy} error={keyError} onKey={(k, h) => void useKey(k, h)} />
        {noKeys ? <p className="muted small mt-5">{copy.lost}</p> : null}
      </Section>

      {deleted && (!key || deleted.handle === handle) ? (
        <Section heading={deleted.handle} rule>
          <p role="status">{copy.del.received}</p>
          <p className="mt-3">
            <Link to={`/r/${deleted.id}`}>{copy.del.receivedLink} →</Link>
          </p>
        </Section>
      ) : null}

      {key && handle ? (
        <>
          <Section heading={handle} rule>
            {pending ? (
              <div>
                <p>{copy.pendingEntry.line(fmtClock(new Date(pending.entry.submitted_at)))}</p>
                <p className="mt-3">
                  <Link to={`/r/${pending.id}`}>{copy.pendingEntry.link} →</Link>
                </p>
              </div>
            ) : loadError === 'no_entry' ? (
              <EmptyState title={copy.errors.noEntry.title} body={copy.errors.noEntry.body} />
            ) : loadError === 'mismatch' ? (
              <ErrorState title={copy.errors.wrongKey.title} body={copy.errors.wrongKey.body} />
            ) : loadError === 'network' ? (
              <ErrorState title="Could not load." body="GitHub did not answer. Retrying." retry={() => setReloadTick((t) => t + 1)} />
            ) : profile ? (
              <EntrySummary profile={profile} result={result} />
            ) : (
              <p className="muted">Loading.</p>
            )}
          </Section>

          {profile && currentId && enabled ? (
            <>
              <Section rule heading="Visibility">
                {channelDown ? (
                  <ErrorState title={copy.errors.channelDown.title} body={copy.errors.channelDown.body} />
                ) : (
                  <VisibilityControl value={currentVisibility} pending={visPending} sending={visSending} onDispatch={(n) => void dispatchVisibility(n)} />
                )}
              </Section>
              <Section rule heading="Resubmit">
                <p>{copy.resubmit.line}</p>
                <div className="actions">
                  {channelDown ? (
                    <Button variant="secondary" disabled disabledReason={copy.errors.channelDown.title}>
                      {copy.resubmit.button}
                    </Button>
                  ) : (
                    <LinkButton to={`/upload?handle=${encodeURIComponent(handle)}`} variant="secondary">
                      {copy.resubmit.button}
                    </LinkButton>
                  )}
                </div>
              </Section>
              <Section rule heading="Delete">
                <DeleteEntry handle={handle} id={currentId} onDispatch={dispatchDelete} fallbackPayload={deletePayload} />
              </Section>
            </>
          ) : null}

          <Section rule heading={copy.device.heading}>
            <DeviceKeys handle={handle} keyString={key} onForget={() => forget(handle)} />
          </Section>
        </>
      ) : null}
      {!noKeys ? (
        <p className="muted small mt-6">
          <Link to="/about#privacy">Privacy</Link> · <Link to="/about#contact">Contact</Link>
        </p>
      ) : null}
    </Page>
  );
}
