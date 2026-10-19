import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import type { AutoResumeStatus } from '@/shared/types';
import { AutoResumeToggle } from '@/modules/chat/composer/AutoResumeToggle';

type StatusOverrides = Partial<Omit<AutoResumeStatus, 'setting'>> & { setting?: Partial<AutoResumeStatus['setting']> };

function makeStatus(overrides: StatusOverrides = {}): AutoResumeStatus {
  const { setting, ...rest } = overrides;
  return {
    setting: { enabled: false, source: 'user', locked: false, userFileStatus: 'ok', ...setting },
    pending: null,
    failure: null,
    ...rest,
  };
}

describe('the auto-resume toggle', () => {
  it('renders nothing without status', () => {
    const { container } = render(<AutoResumeToggle status={null} onSetEnabled={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('click on an off toggle calls onSetEnabled(true)', () => {
    const onSetEnabled = vi.fn();
    render(<AutoResumeToggle status={makeStatus()} onSetEnabled={onSetEnabled} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onSetEnabled).toHaveBeenCalledWith(true);
  });

  it('click on an on toggle calls onSetEnabled(false)', () => {
    const onSetEnabled = vi.fn();
    render(<AutoResumeToggle status={makeStatus({ setting: { enabled: true } })} onSetEnabled={onSetEnabled} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });

  it('a pending state shows a visible notice with the time, and cancelling asks first', () => {
    const onCancel = vi.fn();
    const onSetEnabled = vi.fn();
    const resumeAt = new Date();
    resumeAt.setHours(23, 59, 0, 0);
    render(
      <AutoResumeToggle
        status={makeStatus({ setting: { enabled: true }, pending: { resumeAt: resumeAt.toISOString(), attempts: 1 } })}
        onSetEnabled={onSetEnabled}
        onCancel={onCancel}
      />,
    );

    const time = resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByText(`Resuming at ${time}`)).toBeTruthy();
    const button = screen.getByRole('button', { name: `Cancel the auto-resume at ${time}` });
    expect(button.getAttribute('aria-pressed')).toBeNull();

    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Cancel this resume?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByText('Cancel this resume?')).toBeNull();

    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel resume' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it('a pending resume on another day includes the date', () => {
    const resumeAt = new Date();
    resumeAt.setDate(resumeAt.getDate() + 2);
    resumeAt.setHours(9, 30, 0, 0);
    render(
      <AutoResumeToggle
        status={makeStatus({ setting: { enabled: true }, pending: { resumeAt: resumeAt.toISOString(), attempts: 1 } })}
        onSetEnabled={() => {}}
        onCancel={() => {}}
      />,
    );

    const when = resumeAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    expect(screen.getByText(`Resuming at ${when}`)).toBeTruthy();
  });

  it('a failed state shows a truncated reason, the full text in its title, and dismissing asks first', () => {
    const onCancel = vi.fn();
    const reason = 'The limit was hit again and again and again, far more times than anyone expected it to be';
    render(
      <AutoResumeToggle
        status={makeStatus({ setting: { enabled: true }, failure: { reason } })}
        onSetEnabled={() => {}}
        onCancel={onCancel}
      />,
    );

    const notice = screen.getByText((text) => text.startsWith('Auto-resume stopped — The limit was hit'));
    expect(notice.textContent?.endsWith('…')).toBe(true);
    expect(notice.textContent?.includes(reason)).toBe(false);
    expect(notice.getAttribute('title')).toBe(`Auto-resume stopped — ${reason}`);

    const button = screen.getByRole('button', { name: `Dismiss the auto-resume failure: ${reason}` });
    expect(button.getAttribute('aria-pressed')).toBeNull();
    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the plain on/off toggle exposes aria-pressed', () => {
    render(<AutoResumeToggle status={makeStatus({ setting: { enabled: true } })} onSetEnabled={() => {}} onCancel={() => {}} />);
    const button = screen.getByRole('button', { name: 'Auto-resume after usage limit' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('locked and invalid states are disabled', () => {
    const { unmount } = render(
      <AutoResumeToggle status={makeStatus({ setting: { locked: true, source: 'managed' } })} onSetEnabled={() => {}} onCancel={() => {}} />,
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    unmount();

    render(
      <AutoResumeToggle status={makeStatus({ setting: { userFileStatus: 'invalid' } })} onSetEnabled={() => {}} onCancel={() => {}} />,
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
