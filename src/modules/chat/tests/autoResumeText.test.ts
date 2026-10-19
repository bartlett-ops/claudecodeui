import { describe, expect, it } from 'vitest';

import type { AutoResumeStatus } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import { formatResumeAt, getAutoResumePlaceholder } from '@/modules/chat/utils/autoResumeText';

const t = i18n.getFixedT('en', 'chat');

function makeStatus(overrides: Partial<AutoResumeStatus> = {}): AutoResumeStatus {
  return {
    setting: { enabled: true, source: 'user', locked: false, userFileStatus: 'ok' },
    pending: null,
    failure: null,
    ...overrides,
  };
}

describe('auto-resume text', () => {
  it('formats a resume later today as a time only', () => {
    const resumeAt = new Date();
    resumeAt.setHours(23, 59, 0, 0);
    expect(formatResumeAt(resumeAt.toISOString())).toBe(
      resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('includes the date for a resume on another day', () => {
    const resumeAt = new Date();
    resumeAt.setDate(resumeAt.getDate() + 2);
    resumeAt.setHours(9, 30, 0, 0);
    expect(formatResumeAt(resumeAt.toISOString())).toBe(
      resumeAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('says when a pending resume will fire', () => {
    const resumeAt = new Date();
    resumeAt.setHours(23, 59, 0, 0);
    const status = makeStatus({ pending: { resumeAt: resumeAt.toISOString(), attempts: 1 } });
    expect(getAutoResumePlaceholder(status, t)).toBe(`Resuming at ${formatResumeAt(resumeAt.toISOString())}`);
  });

  it('says nothing when a resume failed, since the banner shows the reason', () => {
    const pending = { resumeAt: new Date().toISOString(), attempts: 1 };
    const status = makeStatus({ pending, failure: { reason: 'Gave up after 3 attempts.' } });
    expect(getAutoResumePlaceholder(status, t)).toBeNull();
  });

  it('says nothing without status or without a pending resume or failure', () => {
    expect(getAutoResumePlaceholder(null, t)).toBeNull();
    expect(getAutoResumePlaceholder(makeStatus(), t)).toBeNull();
  });
});
