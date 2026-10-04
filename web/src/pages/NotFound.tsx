import { Link } from 'react-router';
import { Page } from '../components/chrome/Chrome.tsx';
import { errors } from '../copy/errors.ts';

export function NotFound({ title, body, extra }: { title?: string; body?: string; extra?: string }) {
  return (
    <Page title={title ?? errors.notFound.title} width="prose">
      <div className="page-head">
        <h1 className="page-title">{title ?? errors.notFound.title}</h1>
      </div>
      <div className="prose">
        <p>{body ?? errors.notFound.body}</p>
        {extra ? <p className="muted">{extra}</p> : null}
        <p className="inline-list">
          <Link to="/leaderboard/general">{errors.links.ladder}</Link>
          <Link to="/arena">{errors.links.arena}</Link>
        </p>
      </div>
    </Page>
  );
}
