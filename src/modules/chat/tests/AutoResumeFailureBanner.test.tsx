import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import { AutoResumeFailureBanner } from '@/modules/chat/composer/AutoResumeFailureBanner';

describe('the auto-resume failure banner', () => {
  it('renders nothing without a failure', () => {
    const { container } = render(<AutoResumeFailureBanner failure={null} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the whole reason', () => {
    const reason = 'The limit was hit again and again and again, far more times than anyone expected it to be';
    render(<AutoResumeFailureBanner failure={{ reason }} onDismiss={() => {}} />);

    expect(screen.getByText(`Auto-resume stopped — ${reason}`)).toBeTruthy();
  });

  it('dismisses with one click', () => {
    const onDismiss = vi.fn();
    render(<AutoResumeFailureBanner failure={{ reason: 'Gave up.' }} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss auto-resume notice' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
