// VITE_MOCK=1: serve a pre-built Pages tree at <base>data/ and a raw tree at <base>__raw/ (standing in
// for raw.githubusercontent.com), from fixtures/web-data when it exists, else from web/mock-data.
// On build the same trees are copied into dist so `vite preview` works offline. The browser-side half
// of mock mode (fake dispatch overlay, probe) lives in src/lib/mock.ts.
import { cp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

export interface MockPluginOptions {
  base: string;
  /** Override the data root (tests). */
  root?: string;
}

const require = createRequire(import.meta.url);

export function resolveMockRoot(webDir: string): { root: string; source: 'fixtures' | 'mock-data' } {
  const fixtures = path.resolve(webDir, '..', 'fixtures', 'web-data');
  const fallback = path.resolve(webDir, 'mock-data');
  try {
    // Only a complete tree counts; a half-generated fixtures dir falls back too.
    require('node:fs').accessSync(path.join(fixtures, 'pages', 'manifest.json'));
    return { root: fixtures, source: 'fixtures' };
  } catch {
    return { root: fallback, source: 'mock-data' };
  }
}

const notFoundHtml = '<!doctype html><meta charset="utf-8"><title>ResumeArena</title><p>404</p>';

export function mockDataPlugin(opts: MockPluginOptions): Plugin {
  const base = opts.base.endsWith('/') ? opts.base : `${opts.base}/`;
  let webDir = process.cwd();
  let dataRoot = opts.root ?? '';
  let outDir = 'dist';
  return {
    name: 'resumearena:mock-data',
    configResolved(config) {
      webDir = config.root;
      outDir = config.build.outDir;
      if (!dataRoot) {
        const r = resolveMockRoot(webDir);
        dataRoot = r.root;
        config.logger.info(`[mock] serving ${r.source} from ${dataRoot}`);
      }
    },
    configureServer(server) {
      const mounts: [string, string][] = [
        [`${base}data/`, path.join(dataRoot, 'pages')],
        [`${base}__raw/`, path.join(dataRoot, 'raw')],
      ];
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        const mount = mounts.find(([prefix]) => url.startsWith(prefix));
        if (!mount) return next();
        const rel = decodeURIComponent(url.slice(mount[0].length));
        const file = path.join(mount[1], rel);
        if (!file.startsWith(mount[1])) {
          res.statusCode = 403;
          res.end();
          return;
        }
        void (async () => {
          try {
            const s = await stat(file);
            if (!s.isFile()) throw new Error('not a file');
            const body = await readFile(file);
            res.statusCode = 200;
            res.setHeader('content-type', file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');
            res.setHeader('cache-control', 'no-store');
            res.end(body);
          } catch {
            // Pages answers missing files with 404.html; raw answers with plain text. Both are 404s.
            const raw = mount[0].endsWith('__raw/');
            res.statusCode = 404;
            res.setHeader('content-type', raw ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
            res.end(raw ? '404: Not Found' : notFoundHtml);
          }
        })();
      });
    },
    async closeBundle() {
      const dist = path.resolve(webDir, outDir);
      await cp(path.join(dataRoot, 'pages'), path.join(dist, 'data'), { recursive: true });
      await cp(path.join(dataRoot, 'raw'), path.join(dist, '__raw'), { recursive: true });
    },
  };
}
