import type { TFunction } from 'i18next';

import type { AutoResumeStatus } from '@/shared/types';

/**
 * The resume time as shown to the user, with the date when it is not today.
 *
 * Used by the auto-resume toggle for its labels and by ChatInterface for the
 * input placeholder, so both name the same moment in the same words.
 */
export function formatResumeAt(resumeAt: string): string {
  const date = new Date(resumeAt);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Longest failure reason put in the placeholder; the toggle's tooltip keeps the full text. */
const MAX_PLACEHOLDER_REASON_LENGTH = 80;

/**
 * What the input placeholder says about auto-resume, or null when there is
 * nothing to say: the failure reason when a resume gave up, otherwise the time
 * a waiting resume will fire. A failure outranks a pending resume, as it does
 * on the toggle.
 *
 * Used by ChatInterface so the user reads this where they would type.
 */
export function getAutoResumePlaceholder(status: AutoResumeStatus | null, t: TFunction): string | null {
  if (!status) {
    return null;
  }
  if (status.failure) {
    const { reason } = status.failure;
    const shown = reason.length > MAX_PLACEHOLDER_REASON_LENGTH
      ? `${reason.slice(0, MAX_PLACEHOLDER_REASON_LENGTH - 1).trimEnd()}…`
      : reason;
    return t('autoResume.failed', { reason: shown });
  }
  if (status.pending) {
    return t('autoResume.pending', { time: formatResumeAt(status.pending.resumeAt) });
  }
  return null;
}
