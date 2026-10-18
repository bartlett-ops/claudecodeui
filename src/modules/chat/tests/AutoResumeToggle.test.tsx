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

  it('a pending state shows the time in its title and click calls onCancel', () => {
    const onCancel = vi.fn();
    const onSetEnabled = vi.fn();
    const resumeAt = '2026-08-28T12:00:00.000Z';
    render(
      <AutoResumeToggle
        status={makeStatus({ setting: { enabled: true }, pending: { resumeAt, attempts: 1 } })}
        onSetEnabled={onSetEnabled}
        onCancel={onCancel}
      />,
    );

    const button = screen.getByRole('button');
    const time = new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(button.getAttribute('title')).toBe(`Resuming at ${time}`);
    fireEvent.click(button);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it('a failed state shows the reason and click dismisses it', () => {
    const onCancel = vi.fn();
    render(
      <AutoResumeToggle
        status={makeStatus({ setting: { enabled: true }, failure: { reason: 'still limited' } })}
        onSetEnabled={() => {}}
        onCancel={onCancel}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.getAttribute('title')).toContain('still limited');
    fireEvent.click(button);

    expect(onCancel).toHaveBeenCalledTimes(1);
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
