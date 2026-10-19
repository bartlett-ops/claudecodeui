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

/**
 * What the input placeholder says about auto-resume: the time a waiting resume
 * will fire, or null when none is waiting. A failed resume is shown in a banner
 * above the input instead, so it says nothing here.
 *
 * Used by ChatInterface so the user reads this where they would type.
 */
export function getAutoResumePlaceholder(status: AutoResumeStatus | null, t: TFunction): string | null {
  if (!status || status.failure || !status.pending) {
    return null;
  }
  return t('autoResume.pending', { time: formatResumeAt(status.pending.resumeAt) });
}
