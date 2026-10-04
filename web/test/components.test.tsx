// Result-page pieces that must work without a mouse (F06) and the delete fallback's clipboard contract (F03).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { formatOwnerKey, generateOwnerKey, type SubmissionPayload } from '@resumearena/shared';
import { ScoreBars } from '../src/components/numbers/Numbers.tsx';
import { AtsPanel } from '../src/components/result/Result.tsx';
import { FallbackPanel } from '../src/components/upload/Upload.tsx';
import { ToastProvider } from '../src/components/forms/Toast.tsx';

afterEach(() => cleanup());

describe('ScoreBars', () => {
  const rows = [
    { key: 'parseability', label: 'Parseability', score: 80, note: 'Clean headings and dates.' },
    { key: 'length', label: 'Length', score: 60 },
  ];

  it('renders expandable factors as buttons that open the note from the keyboard', () => {
    render(<ScoreBars rows={rows} expandable />);
    const button = screen.getByRole('button', { name: 'Parseability' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Clean headings and dates.')).toBeNull();
    // A button activates on Enter/Space through its native click; no row-level handler, no tabindex hacks.
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const note = screen.getByText('Clean headings and dates.');
    expect(button.getAttribute('aria-controls')).toBe(note.closest('tr')?.id);
    fireEvent.click(button);
    expect(screen.queryByText('Clean headings and dates.')).toBeNull();
    // Rows without a note are plain text, and no <tr> carries aria-expanded.
    expect(screen.queryByRole('button', { name: 'Length' })).toBeNull();
    expect(document.querySelectorAll('tr[aria-expanded]')).toHaveLength(0);
  });

  it('is inert without `expandable`: no buttons at all', () => {
    render(<ScoreBars rows={rows} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('AtsPanel fixes', () => {
  it('separates issue from fix, labels the priority and lists high first', () => {
    const fixes = [
      { priority: 'low' as const, factor: 'quantification' as const, issue: 'Citation counts are not stated anywhere', fix: 'Add total citations under Publications' },
      { priority: 'high' as const, factor: 'parseability' as const, issue: 'Two-column layout', fix: 'Use one column' },
    ];
    render(
      <ToastProvider>
        <AtsPanel score={70} fixes={fixes} factors={[]} target="Software engineer" />
      </ToastProvider>,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Two-column layout');
    expect(items[0]?.textContent).toContain('high priority');
    expect(items[1]?.textContent).toMatch(/Citation counts are not stated anywhere.*Fix:.*Add total citations/);
    expect(items[1]?.textContent).toContain('low priority');
    expect(items[1]?.textContent).not.toMatch(/anywhere Add/);
  });
});

describe('FallbackPanel for a deletion', () => {
  it('copies the formatted key, never an empty text, and says where to paste it', async () => {
    const key = generateOwnerKey();
    const payload: SubmissionPayload = { action: 'delete', submission_id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: 'a'.repeat(64), visibility: '', text: '', metrics_json: '{}', ladder_hint: '', client_version: '', owner_key: key };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const opened = vi.fn();
    render(
      <MemoryRouter>
        <FallbackPanel payload={payload} reason="revoked" onOpened={opened} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/paste your key into the field called owner_key/i)).toBeTruthy();
    expect(screen.queryByText(/Resume text/)).toBeNull();
    const button = screen.getByRole('button', { name: 'Copy key and open the form' });
    fireEvent.click(button);
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(formatOwnerKey(key));
    const url = String(open.mock.calls[0]?.[0]);
    expect(url).toContain('template=delete.yml');
    expect(url).not.toContain(key);
    expect(url).not.toContain('owner_key=');
  });

  it('copies the text for a submission', async () => {
    const payload: SubmissionPayload = { action: 'submit', submission_id: 'k7q2m3xw5a', handle: 'priya-n', owner_hash: 'a'.repeat(64), visibility: 'anonymous', text: 'the resume text', metrics_json: '{}', ladder_hint: '', client_version: '', owner_key: '' };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <MemoryRouter>
        <FallbackPanel payload={payload} reason="revoked" onOpened={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy text and open the form' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('the resume text'));
  });
});
