import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';

import type { AutoResumeStatus } from '@/shared/types';

type AutoResumeFailureBannerProps = {
  failure: AutoResumeStatus['failure'];
  onDismiss: () => void;
};

/**
 * Rendered by ChatComposer above the input, in the style and place of a failed
 * scheduled message, so the user sees why an automatic resume gave up. Dismissing
 * it goes through the same cancel endpoint as the toggle, so it stays gone
 * across reloads.
 */
export function AutoResumeFailureBanner({ failure, onDismiss }: AutoResumeFailureBannerProps) {
  const { t } = useTranslation('chat');

  if (!failure) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-col gap-1.5">
      <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
        <p className="min-w-0 flex-1 break-words text-[11px] text-muted-foreground">
          {t('autoResume.failed', { reason: failure.reason })}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          title={t('autoResume.dismiss')}
          aria-label={t('autoResume.dismiss')}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
