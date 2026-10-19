export type UsageLimitHit = { resetsAtMs: number | null };

const LEGACY_LIMIT_PATTERN = /usage limit reached\|(\d{10,13})/i;

// Timestamps below 1e12 are epoch seconds; anything else is already milliseconds.
function toEpochMs(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    return null;
  }
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// An error or synthetic assistant message is the SDK speaking, not the model;
// only these may carry the legacy limit text.
function isErrorOrSyntheticAssistant(message: Record<string, unknown>): boolean {
  const inner = message.message;
  return Boolean(message.error) || (isRecord(inner) && inner.model === '<synthetic>');
}

function extractAssistantText(message: Record<string, unknown>): string {
  const inner = message.message;
  const content = isRecord(inner) ? inner.content : undefined;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/**
 * Consumer: claude-runtime.provider.js (auto-resume after a usage limit).
 * Creates a per-run tracker fed with every SDK message. `observe` returns a
 * hit at most once, only when a real (non-overage) limit stop is confirmed.
 */
export function createUsageLimitTracker(): { observe(message: unknown): UsageLimitHit | null } {
  let rejectedResetsAtMs: number | null | undefined; // undefined = no rejected event remembered
  let reported = false;

  return {
    observe(message: unknown): UsageLimitHit | null {
      if (reported || !isRecord(message)) {
        return null;
      }

      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info;
        if (
          isRecord(info)
          && info.status === 'rejected'
          && info.overageStatus !== 'allowed'
          && info.isUsingOverage !== true
        ) {
          rejectedResetsAtMs = toEpochMs(info.resetsAt);
        } else {
          // Any later event that does not reject means the limit lifted (or
          // overage covers it), so an earlier rejection no longer applies.
          rejectedResetsAtMs = undefined;
        }
        return null;
      }

      let confirmedResetsAtMs: number | null | undefined;
      if (message.type === 'assistant') {
        if (!isErrorOrSyntheticAssistant(message)) {
          // The model answered normally, so the run was not stopped by an
          // earlier rejection; ordinary text never counts as a limit stop.
          rejectedResetsAtMs = undefined;
          return null;
        }
        const legacy = LEGACY_LIMIT_PATTERN.exec(extractAssistantText(message));
        if (message.error === 'rate_limit' && rejectedResetsAtMs !== undefined) {
          confirmedResetsAtMs = rejectedResetsAtMs;
        } else if (legacy) {
          confirmedResetsAtMs = rejectedResetsAtMs ?? toEpochMs(legacy[1]);
        }
      } else if (message.type === 'result' && message.is_error === true && rejectedResetsAtMs !== undefined) {
        confirmedResetsAtMs = rejectedResetsAtMs;
      }

      if (confirmedResetsAtMs === undefined) {
        return null;
      }
      reported = true;
      return { resetsAtMs: confirmedResetsAtMs };
    },
  };
}
