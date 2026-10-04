import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanError, formatOutputs, parseCommandFile, pendingCommandFiles, plan } from '../plan-maintenance.ts';

let dir = '';
function commands(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'ra-cmd-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('plan', () => {
  it('schedule always runs nightly in the rerank group', () => {
    expect(plan('schedule', '/nonexistent')).toEqual({ action: 'nightly', args: '{}', group: 'rerank', file: '' });
  });
  it('push with nothing pending yields empty outputs', () => {
    commands({ '.done': '20261001-0900-nightly.json success 1-1\n', '20261001-0900-nightly.json': '{"action":"nightly"}' });
    expect(plan('push', dir)).toEqual({ action: '', args: '', group: '', file: '' });
  });
  it('push picks the newest pending file and maps the group', () => {
    commands({
      '.done': '20261003-1200-drain-queue.json success\n',
      '20261003-1200-drain-queue.json': '{"action":"drain-queue"}',
      '20261002-0800-nightly.json': '{"action":"nightly","args":{}}',
      '20261003-1100-rotate-anchors.json': '{"action":"rotate-anchors","args":{"category":"tech","generate":true}}',
      'README.md': 'not a command',
      'notes.json': '{"action":"nightly"}',
    });
    expect(pendingCommandFiles(dir)).toEqual(['20261003-1100-rotate-anchors.json', '20261002-0800-nightly.json']);
    expect(plan('push', dir)).toEqual({
      action: 'rotate-anchors',
      args: '{"category":"tech","generate":true}',
      group: 'maintenance-long',
      file: '20261003-1100-rotate-anchors.json',
    });
  });
  it('rejects unknown actions, non-object args and bad JSON by file', () => {
    commands({
      '20261003-1300-set.json': '{"action":"set","args":{}}',
      '20261003-1301-nightly.json': '{"action":"nightly","args":[1]}',
      '20261003-1302-nightly.json': '{not json',
    });
    expect(() => parseCommandFile(dir, '20261003-1300-set.json')).toThrow(PlanError);
    expect(() => parseCommandFile(dir, '20261003-1301-nightly.json')).toThrow(/args/);
    expect(() => parseCommandFile(dir, '20261003-1302-nightly.json')).toThrow(/JSON/);
    expect(() => plan('push', dir)).toThrow(/JSON/);
  });
  it('rejects other events', () => {
    expect(() => plan('workflow_dispatch', '/x')).toThrow(/unsupported event/);
  });
});

describe('formatOutputs', () => {
  it('writes key=value lines and a heredoc for multi-line values', () => {
    expect(formatOutputs({ action: 'nightly', args: '{}', group: 'rerank', file: '' })).toBe('action=nightly\nargs={}\ngroup=rerank\nfile=\n');
    expect(formatOutputs({ action: 'nightly', args: 'a\nb', group: 'rerank', file: '' })).toContain('args<<RA_EOF_args\na\nb\nRA_EOF_args\n');
  });
});
