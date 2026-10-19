import { describe, expect, it } from 'vitest';

import type { AutoResumeStatus } from '@/shared/types';
import { formatResumeAt, getPendingResumeTime } from '@/modules/chat/utils/autoResumeText';

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

  it('gives the pending resume time for the input placeholder', () => {
    const resumeAt = new Date();
    resumeAt.setHours(23, 59, 0, 0);
    const status = makeStatus({ pending: { resumeAt: resumeAt.toISOString(), attempts: 1 } });
    expect(getPendingResumeTime(status)).toBe(formatResumeAt(resumeAt.toISOString()));
  });

  it('gives no time without status, without a pending resume, or when a failure outranks it', () => {
    const pending = { resumeAt: new Date().toISOString(), attempts: 1 };
    expect(getPendingResumeTime(null)).toBeNull();
    expect(getPendingResumeTime(makeStatus())).toBeNull();
    expect(getPendingResumeTime(makeStatus({ pending, failure: { reason: 'x' } }))).toBeNull();
  });
});
