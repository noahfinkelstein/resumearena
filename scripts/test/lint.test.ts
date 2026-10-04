import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEngineNoConsoleLog, checkPrompts, checkUploadNoFetch, checkWorkflows, formatFinding, lint, stripCommentsAndStrings, workflowShape } from '../lint.ts';

let root = '';
function scaffold(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'ra-lint-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const GOOD_WORKFLOW = `name: x
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;

describe('stripCommentsAndStrings', () => {
  it('blanks comments and string contents but keeps lines', () => {
    const src = `const a = "fetch(x)"; // fetch\n/* fetch\n */ const b = \`fetch\`;\nfetch(url);`;
    const out = stripCommentsAndStrings(src);
    expect(out.split('\n').length).toBe(4);
    expect(out).not.toMatch(/"fetch/);
    expect(out.split('\n')[3]).toContain('fetch(url)');
  });
});

describe('check 1: upload components never fetch', () => {
  it('flags calls, property access and import bindings, not prose', () => {
    scaffold({
      'web/src/components/upload/A.tsx': `const t = "we fetch nothing";\nexport const x = () => fetch('/x');\n`,
      'web/src/components/upload/B.tsx': `const f = window.fetch;\n`,
      'web/src/components/upload/C.tsx': `import { fetch } from './shim.ts';\n`,
      'web/src/components/upload/D.tsx': `import { userDoc } from '../../lib/data.ts';\nexport const ok = userDoc;\n`,
    });
    const f = checkUploadNoFetch(root).map(formatFinding);
    expect(f).toEqual([
      'web/src/components/upload/A.tsx:2: components/upload must not import or call fetch (spec §11.5)',
      'web/src/components/upload/B.tsx:1: components/upload must not import or call fetch (spec §11.5)',
      'web/src/components/upload/C.tsx:1: components/upload must not import or call fetch (spec §11.5)',
    ]);
  });
  it('passes when the directory does not exist yet', () => {
    scaffold({});
    expect(checkUploadNoFetch(root)).toEqual([]);
  });
});

describe('check 2: engine console.log', () => {
  it('allows summary.ts and comments, flags the rest', () => {
    scaffold({
      'engine/src/summary.ts': `console.log('ok');\n`,
      'engine/src/cli.ts': `// console.log('no')\nconsole.error('fine');\nconsole . log("x");\n`,
    });
    expect(checkEngineNoConsoleLog(root).map(formatFinding)).toEqual([
      'engine/src/cli.ts:3: console.log in engine/src (only summary.ts may write to stdout)',
    ]);
  });
});

describe('check 3: workflow permissions and timeouts', () => {
  it('reads the shape of a block-style workflow', () => {
    const shape = workflowShape(`name: y
on: push
jobs:
  build:
    permissions:
      contents: read
    timeout-minutes: 3
    steps:
      - name: s
        env:
          timeout-minutes: 9
        run: x
  deploy:
    needs: build
    steps: []
`);
    expect(shape.topPermissions).toBe(false);
    expect(shape.jobs.map((j) => [j.name, j.permissions, j.timeout])).toEqual([
      ['build', true, true],
      ['deploy', false, false],
    ]);
  });
  it('accepts top-level permissions and reports missing timeouts with the job line', () => {
    scaffold({
      '.github/workflows/good.yml': GOOD_WORKFLOW,
      '.github/workflows/bad.yml': `name: z\non: push\njobs:\n  one:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    });
    expect(checkWorkflows(root).map(formatFinding)).toEqual([
      '.github/workflows/bad.yml:4: job "one" has no permissions (none at top level either)',
      '.github/workflows/bad.yml:4: job "one" has no timeout-minutes',
    ]);
  });
});

describe('check 4: prompts', () => {
  it('names each missing prompt', () => {
    scaffold({ 'docs/prompts/gate.md': '# gate\n' });
    expect(checkPrompts(root).map((f) => f.file)).toEqual(['docs/prompts/analysis-system.md', 'docs/prompts/judge.md']);
  });
});

describe('lint on the real repository', () => {
  it('passes on this checkout', () => {
    const findings = lint(join(import.meta.dirname, '..', '..'));
    expect(findings.map(formatFinding)).toEqual([]);
  });
});
