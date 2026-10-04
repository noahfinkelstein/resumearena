import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted faces: no Google Fonts request at runtime.
import '@fontsource-variable/newsreader/index.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
