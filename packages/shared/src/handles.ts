// Handles (D-34, platform-github.md §D.3). 3–20 chars of [a-z0-9-], no leading/trailing hyphen.
import { isBlocked } from './handles/blocklist.ts';

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

export type HandleVerdict = 'ok' | 'format' | 'reserved' | 'blocked';

/** Platform reserved set, plus the route prefixes `r` and `u`, ladder/tier/stage names and product words. */
export const RESERVED: ReadonlySet<string> = new Set([
  // platform list
  'admin', 'administrator', 'owner', 'root', 'system', 'support', 'help', 'staff', 'mod', 'moderator',
  'anon', 'anonymous', 'about', 'arena', 'upload', 'leaderboard', 'ladder', 'ladders', 'me', 'settings', 'data', 'api',
  'status', 'privacy', 'terms', 'resumearena', 'noah', 'noahfinkelstein', 'github', 'judge', 'anchor', 'anchors',
  'null', 'undefined', 'true', 'false', 'test', 'example',
  // routes and files the SPA serves
  'r', 'u', 'leaderboards', 'result', 'results', 'profile', 'profiles', 'user', 'users', 'manage', 'faq', 'contact',
  'legal', 'security', 'docs', 'blog', 'news', 'home', 'index', '404', 'robots', 'sitemap', 'manifest', 'favicon',
  'assets', 'static', 'public', 'search', 'new', 'edit', 'delete', 'login', 'signin', 'signup', 'register', 'account', 'accounts',
  'dashboard', 'app', 'apps', 'www', 'mail', 'dev', 'beta', 'alpha',
  // identities nobody should hold
  'official', 'verified', 'bot', 'bots', 'ai', 'claude', 'anthropic', 'opus', 'sonnet', 'haiku', 'resume', 'resumes', 'cv',
  'my', 'you', 'everyone', 'nobody', 'someone', 'guest', 'deleted', 'removed', 'unknown', 'reference', 'finkelstein',
  // categories, stages, tiers
  'general', 'finance', 'tech', 'academia', 'student', 'new-grad', 'early', 'mid', 'senior', 'executive', 'exec',
  'entrant', 'contender', 'challenger', 'candidate', 'expert', 'master', 'grandmaster', 'laureate', 'provisional',
]);

/** The one validator both browser and engine run; blocked copy is "That handle is not available." */
export function validateHandle(h: string): HandleVerdict {
  if (typeof h !== 'string' || !HANDLE_RE.test(h)) return 'format';
  if (RESERVED.has(h) || h.startsWith('anon-') || h.startsWith('anchr')) return 'reserved';
  if (isBlocked(h)) return 'blocked';
  return 'ok';
}

/** `users/<h2>/<handle>.json` */
export const handleShard = (handle: string): string => handle.slice(0, 2);
