import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { AutoResumeStatus } from '@/shared/types';

type AutoResumeToggleProps = {
  status: AutoResumeStatus | null;
  onSetEnabled: (enabled: boolean) => void;
  onCancel: () => void;
};

/**
 * Rendered by chat's ChatComposer beside the schedule button so the user can
 * turn auto-resume on or off and see or cancel a resume that is waiting.
 */
export function AutoResumeToggle({ status, onSetEnabled, onCancel }: AutoResumeToggleProps) {
  const { t } = useTranslation('chat');

  if (!status) {
    return null;
  }

  const { setting, pending, failure } = status;
  const blocked = setting.locked || setting.userFileStatus === 'invalid';

  // A failure outranks a pending resume, and both outrank the plain setting,
  // because they are what the user most needs to act on.
  let title: string;
  let tone: string;
  let onClick: () => void;
  if (failure) {
    title = t('autoResume.failed', { reason: failure.reason });
    tone = 'text-destructive';
    onClick = onCancel;
  } else if (pending) {
    title = t('autoResume.pending', {
      time: new Date(pending.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    tone = 'text-primary';
    onClick = onCancel;
  } else if (setting.locked) {
    title = t('autoResume.locked');
    tone = setting.enabled ? 'text-primary' : 'text-muted-foreground';
    onClick = () => {};
  } else if (setting.userFileStatus === 'invalid') {
    title = t('autoResume.invalid');
    tone = setting.enabled ? 'text-primary' : 'text-muted-foreground';
    onClick = () => {};
  } else {
    title = setting.enabled ? t('autoResume.on') : t('autoResume.off');
    tone = setting.enabled ? 'text-primary' : 'text-muted-foreground';
    onClick = () => onSetEnabled(!setting.enabled);
  }

  // Failure and pending stay clickable even when the setting is locked: they
  // cancel or dismiss a single session, which does not touch the setting.
  const disabled = blocked && !failure && !pending;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={t('autoResume.trigger')}
      aria-pressed={setting.enabled}
      title={title}
      className={cn(
        'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 transition-colors',
        tone,
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted',
      )}
    >
      <RotateCw className="h-4 w-4" />
      {pending && !failure && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
      )}
    </button>
  );
}
