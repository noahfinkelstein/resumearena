// AppShell, TopNav, Page, Section, ThemeToggle, Footer, UpdatedAgo.
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { CATEGORIES } from '@resumearena/shared';
import { site } from '../../copy/errors.ts';
import { CATEGORY_LABEL, fmtUpdatedAgo, shortSha } from '../../lib/format.ts';
import { repoUrl } from '../../lib/github.ts';
import { useIdentity } from '../../lib/identity.ts';
import { useTheme } from '../../lib/theme.ts';
import { useClock } from '../../lib/useData.ts';
import { ToastProvider } from '../forms/Toast.tsx';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopNav />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </ToastProvider>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const next = theme === 'paper' ? 'night' : 'paper';
  return (
    <button type="button" className={['theme-toggle', className ?? ''].join(' ').trim()} onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`}>
      {next}
    </button>
  );
}

export function TopNav() {
  const { hasKey } = useIdentity();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  const onLadders = location.pathname.startsWith('/leaderboard');
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link to="/" className="wordmark">
          {site.name}
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {/* product-ux §2.2: click goes to general; hover or focus opens the four-ladder menu (CSS :hover / :focus-within). */}
          <div className="nav-ladders">
            <Link to="/leaderboard/general" className="nav-link" aria-current={onLadders ? 'page' : undefined}>
              {site.nav.ladders}
            </Link>
            <div className="nav-ladders-menu" aria-label={site.nav.ladders}>
              {CATEGORIES.map((c) => (
                <Link key={c} to={`/leaderboard/${c}`}>
                  {CATEGORY_LABEL[c]}
                </Link>
              ))}
            </div>
          </div>
          <NavLink to="/arena" className="nav-link">
            {site.nav.arena}
          </NavLink>
          <NavLink to="/about" className="nav-link">
            {site.nav.about}
          </NavLink>
        </nav>
        <div className="nav-right">
          <Link to="/upload" className="btn btn--primary">
            <span className="nav-upload-full">{site.nav.upload}</span>
          </Link>
          <ThemeToggle />
          {hasKey ? (
            <Link to="/me" className="nav-link nav-entry">
              {site.nav.entry}
            </Link>
          ) : null}
          <button type="button" className="btn btn--quiet nav-menu-toggle" aria-expanded={open} aria-controls="nav-sheet" onClick={() => setOpen((o) => !o)}>
            {open ? site.nav.close : site.nav.menu}
          </button>
        </div>
      </div>
      <div id="nav-sheet" className="nav-sheet" data-open={open}>
        <span className="muted small">{site.nav.ladders}</span>
        {CATEGORIES.map((c) => (
          <Link key={c} to={`/leaderboard/${c}`} className="indent">
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
        <Link to="/arena">{site.nav.arena}</Link>
        <Link to="/about">{site.nav.about}</Link>
        {hasKey ? <Link to="/me">{site.nav.entry}</Link> : null}
        <ThemeToggle />
      </div>
    </header>
  );
}

export interface PageProps {
  title: string;
  width?: 'prose' | 'narrow' | 'content' | 'table';
  children: ReactNode;
}

export function Page({ title, width = 'content', children }: PageProps) {
  useEffect(() => {
    document.title = title ? `${title} · ${site.name}` : `${site.name} · ${site.tagline}`;
  }, [title]);
  return <div className={['page', width === 'content' ? '' : `page--${width}`].join(' ').trim()}>{children}</div>;
}

export interface SectionProps {
  heading?: ReactNode;
  id?: string;
  rule?: boolean;
  updatedAt?: string | null;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ heading, id, rule = false, updatedAt, aside, children, className }: SectionProps) {
  return (
    <section id={id} className={['section', className ?? ''].join(' ').trim()}>
      {heading || updatedAt || aside ? (
        <div className={['section-head', rule ? 'section-head--rule' : ''].join(' ').trim()}>
          {heading ? <h2 className="section-title">{heading}</h2> : <span />}
          {aside}
          {updatedAt ? <UpdatedAgo at={updatedAt} /> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function UpdatedAgo({ at }: { at: string }) {
  const now = useClock(30_000);
  return (
    <span className="updated" title={at}>
      {fmtUpdatedAgo(at, now)}
    </span>
  );
}

export function Footer() {
  const sha = import.meta.env.VITE_COMMIT ?? '';
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>
          {site.name} · <Link to="/about">{site.footer.about}</Link> · <Link to="/about#privacy">{site.footer.privacy}</Link> · <Link to="/about#status">{site.footer.status}</Link> ·{' '}
          <a href={repoUrl()} rel="noreferrer">
            {site.footer.github}
          </a>
        </span>
        {sha ? (
          <a className="mono xs" href={`${repoUrl()}/commit/${sha}`} rel="noreferrer">
            {shortSha(sha)}
          </a>
        ) : (
          <span className="mono xs">dev</span>
        )}
      </div>
    </footer>
  );
}
