import { RouterProvider } from 'react-router';
import { router } from './routes.tsx';

export function App() {
  return <RouterProvider router={router} />;
}
