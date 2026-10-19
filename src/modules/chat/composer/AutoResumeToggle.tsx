import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { AutoResumeStatus } from '@/shared/types';
import { formatResumeAt } from '@/modules/chat/utils/autoResumeText';

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
  // Whether the user clicked a pending or failed state and is being asked to
  // confirm the cancel or dismiss; a stray click must not drop a resume.
  const [confirming, setConfirming] = useState(false);

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
  // Pending and failed states are actions on one session (cancel, dismiss),
  // so they get a label saying so and no pressed state.
  let ariaLabel = t('autoResume.trigger');
  if (failure) {
    title = t('autoResume.failed', { reason: failure.reason });
    tone = 'text-destructive';
    onClick = () => setConfirming(true);
    ariaLabel = t('autoResume.dismissLabel', { reason: failure.reason });
  } else if (pending) {
    const time = formatResumeAt(pending.resumeAt);
    title = t('autoResume.pending', { time });
    tone = 'text-primary';
    onClick = () => setConfirming(true);
    ariaLabel = t('autoResume.cancelLabel', { time });
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
  const isAction = Boolean(failure || pending);
  const showConfirm = confirming && isAction;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {showConfirm ? (
        <span className="flex items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">
            {failure ? t('autoResume.dismissPrompt') : t('autoResume.cancelPrompt')}
          </span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onCancel();
            }}
            className="rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {failure ? t('autoResume.confirmDismiss') : t('autoResume.confirmCancel')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('autoResume.keep')}
          </button>
        </span>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={ariaLabel}
        aria-pressed={isAction ? undefined : setting.enabled}
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
    </div>
  );
}
