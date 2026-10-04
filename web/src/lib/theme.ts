// Theme state: html[data-theme] is set by the inline bootstrap before paint; this keeps it in sync
// with the toggle and with other tabs.
import { useSyncExternalStore } from 'react';
import { KEYS, readTheme, subscribe, writeTheme, type Theme } from './storage.ts';

function current(): Theme {
  const attr = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (attr === 'paper' || attr === 'night') return attr;
  return readTheme() ?? 'paper';
}

const listeners = new Set<() => void>();
let unsubscribeStorage: (() => void) | null = null;

function sub(cb: () => void): () => void {
  listeners.add(cb);
  if (!unsubscribeStorage) {
    unsubscribeStorage = subscribe((key) => {
      if (key === null || key === KEYS.theme) {
        const t = readTheme();
        if (t) apply(t, false);
      }
    });
  }
  return () => {
    listeners.delete(cb);
  };
}

function apply(t: Theme, persist: boolean): void {
  document.documentElement.setAttribute('data-theme', t);
  if (persist) writeTheme(t);
  for (const l of listeners) l();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(sub, current, () => 'paper' as Theme);
  return [t, (next) => apply(next, true)];
}
