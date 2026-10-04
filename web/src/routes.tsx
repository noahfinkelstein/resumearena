import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AppShell } from './components/chrome/Chrome.tsx';
import { About } from './pages/About.tsx';
import { Arena } from './pages/Arena.tsx';
import { Ladder } from './pages/Ladder.tsx';
import { Landing } from './pages/Landing.tsx';
import { Me } from './pages/Me.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Profile } from './pages/Profile.tsx';
import { Result } from './pages/Result.tsx';
import { Upload } from './pages/Upload.tsx';

/** `/resumearena/` → basename `/resumearena`; `/` → ''. */
export function basenameFrom(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return b === '' ? '' : b.startsWith('/') ? b : `/${b}`;
}

function Shell() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const routes = [
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/upload', element: <Upload /> },
      { path: '/r/:id', element: <Result /> },
      { path: '/leaderboard', element: <Navigate to="/leaderboard/general" replace /> },
      { path: '/leaderboard/:category', element: <Ladder /> },
      { path: '/arena', element: <Arena /> },
      { path: '/u/:handle', element: <Profile /> },
      { path: '/me', element: <Me /> },
      { path: '/about', element: <About /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes, { basename: basenameFrom(import.meta.env.BASE_URL ?? '/') });
