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
 * The time of a resume that is waiting for the session, or null when there is
 * none. A failed resume outranks a pending one in the toggle, so it shows no
 * time here either.
 *
 * Used by ChatInterface to put "Resuming at ..." in the input placeholder.
 */
export function getPendingResumeTime(status: AutoResumeStatus | null): string | null {
  if (!status || status.failure || !status.pending) {
    return null;
  }
  return formatResumeAt(status.pending.resumeAt);
}
