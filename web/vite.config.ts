import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockDataPlugin } from './mock/plugin.ts';

// base comes from the deploy workflow (VITE_BASE=/resumearena/); local builds default to '/'.
const base = process.env.VITE_BASE ?? '/';
const mock = process.env.VITE_MOCK === '1';

export default defineConfig({
  base,
  plugins: [react(), ...(mock ? [mockDataPlugin({ base })] : [])],
  worker: { format: 'es' },
  build: {
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        // pdfjs + mammoth only ever load on /upload; keep them out of the entry chunk. Vite 8 (rolldown)
        // accepts manualChunks only as a function, so the §11 object form is expressed as one.
        manualChunks(id: string) {
          return /node_modules\/(pdfjs-dist|mammoth)\//.test(id) ? 'ingest' : undefined;
        },
      },
    },
  },
});
