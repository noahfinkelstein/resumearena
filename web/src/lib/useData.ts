// Visibility-aware polling of a loader (§11.1): refetch every `every` ms while the tab is visible,
// pause when hidden and fire once on return.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface DataState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload(): void;
}

export function useData<T>(load: (signal: AbortSignal) => Promise<T | null>, deps: readonly unknown[], opts: { every?: number; enabled?: boolean } = {}): DataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const enabled = opts.enabled ?? true;
  const every = opts.every ?? 0;
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading(true);
    loadRef
      .current(ctrl.signal)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled || ctrl.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, enabled, ...deps]);

  useEffect(() => {
    if (!every || !enabled) return;
    let timer: number | null = null;
    let lastAt = Date.now();
    const arm = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      if (document.hidden) return;
      timer = window.setTimeout(() => {
        lastAt = Date.now();
        reload();
        arm();
      }, every);
    };
    const onVis = (): void => {
      if (!document.hidden && Date.now() - lastAt >= every) {
        lastAt = Date.now();
        reload();
      }
      arm();
    };
    document.addEventListener('visibilitychange', onVis);
    arm();
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [every, enabled, reload]);

  return { data, error, loading, reload };
}

/** Re-render on an interval while visible (for relative time labels). */
export function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, everyMs);
    const onVis = (): void => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [everyMs]);
  return now;
}
