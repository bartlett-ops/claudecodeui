import { autoResumesDb, sessionsDb } from '@/modules/database/index.js';
import type { AutoResumeRow } from '@/modules/database/index.js';
import { claudeSettingsAutoContinueService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { ChatUsageLimitHit } from '@/shared/types.js';

/** Wait after the reported reset, so the resume does not land before the limit has actually lifted. */
const RESUME_SLACK_MS = 5_000;
/** Longest real limit window (7 days) plus an hour; a reset later than this is not trusted. */
const MAX_RESUME_AHEAD_MS = 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
/** Consecutive attempts allowed before giving up. */
const MAX_ATTEMPTS = 3;
/** How long a due resume may wait for a busy session before giving up. */
const MAX_BUSY_WAIT_MS = 60 * 60 * 1000;
/** How long a resumed run may stay silent before it is treated as not having responded. */
const NO_RESPONSE_TIMEOUT_MS = 120_000;
const RESUME_MESSAGE = 'continue';

/**
 * Hit recordings still in progress, per session. A resumed run that hits the
 * limit again reports it while the run is going, but recording it awaits a
 * settings-file read, so it can still be in flight when the run settles. The
 * attempt waits for these before it decides the outcome; otherwise it would
 * mark its row done and the new hit would restart the attempt count at one.
 */
const hitsInFlight = new Map<string, Set<Promise<unknown>>>();

function trackHit<T>(sessionId: string, recording: Promise<T>): Promise<T> {
  let pending = hitsInFlight.get(sessionId);
  if (!pending) {
    pending = new Set();
    hitsInFlight.set(sessionId, pending);
  }
  const tracked: Promise<unknown> = recording.catch(() => undefined);
  pending.add(tracked);
  void tracked.finally(() => {
    pending.delete(tracked);
    if (pending.size === 0 && hitsInFlight.get(sessionId) === pending) {
      hitsInFlight.delete(sessionId);
    }
  });
  return recording;
}

async function settleHitsInFlight(sessionId: string): Promise<void> {
  const pending = hitsInFlight.get(sessionId);
  if (pending) {
    await Promise.all(pending);
  }
}

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the session has to keep waiting. Deliberately the same one-line check
 * as the scheduled-messages dispatcher's `isSessionBusy`: importing that helper
 * would create a module cycle, because the dispatcher calls this module's pass.
 * Background work counts as busy because a new turn would stop it.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

async function recordHit(hit: ChatUsageLimitHit, now: Date): Promise<AutoResumeRow | null> {
  const setting = await claudeSettingsAutoContinueService.read();
  if (!setting.enabled || typeof hit.userId !== 'number') {
    return null;
  }
  if (!sessionsDb.getSessionById(hit.sessionId)) {
    return null;
  }

  // Everything below is synchronous, so no other hit or attempt for this
  // session can change its live row between the read and the replace.
  const base = { userId: hit.userId, sessionId: hit.sessionId, options: hit.options };
  if (hit.resetsAtMs === null) {
    return autoResumesDb.replaceActive({
      ...base,
      resumeAt: now,
      attempts: 0,
      failureReason: 'The limit was hit but its reset time was not reported.',
    });
  }

  // A hit while an attempt is sending is that attempt failing on the limit
  // again; any other hit (a user turn, or a pending resume not yet sent)
  // starts the count over.
  const active = autoResumesDb.getActiveForSession(hit.sessionId);
  const attempts = active?.status === 'sending' ? active.attempts + 1 : 1;
  if (attempts > MAX_ATTEMPTS) {
    return autoResumesDb.replaceActive({
      ...base,
      resumeAt: now,
      attempts: MAX_ATTEMPTS,
      failureReason: `Gave up after ${MAX_ATTEMPTS} attempts; the limit was hit again.`,
    });
  }

  const resumeAtMs = hit.resetsAtMs + RESUME_SLACK_MS;
  if (resumeAtMs > now.getTime() + MAX_RESUME_AHEAD_MS) {
    // Recorded at `now`: the reported time may not even be a valid date.
    return autoResumesDb.replaceActive({
      ...base,
      resumeAt: now,
      attempts,
      failureReason: 'The reset time is too far away.',
    });
  }

  return autoResumesDb.replaceActive({ ...base, resumeAt: new Date(resumeAtMs), attempts });
}

/**
 * Records a usage-limit stop as a pending resume, or as a failed one when it
 * cannot be scheduled. Returns `null` when nothing is recorded (auto-continue
 * off, no numeric user, unknown session).
 *
 * Consumer: this module's `initializeAutoResume` (the registry's usage-limit
 * handler); exported for the module's tests.
 */
export function recordUsageLimitHit(hit: ChatUsageLimitHit, now: Date = new Date()): Promise<AutoResumeRow | null> {
  return trackHit(hit.sessionId, recordHit(hit, now));
}

/**
 * Sends `continue` for a claimed (`sending`) row and records the outcome.
 *
 * Consumer: this module's `dispatchDueAutoResumes`; exported so tests can drive
 * one attempt and await it.
 */
export async function attemptResume(row: AutoResumeRow, runtime: ProviderRuntimeGateway): Promise<void> {
  const sessionId = row.session_id;
  let noResponse = false;

  // Armed before the send: the run is registered synchronously inside it, and
  // the send only settles once the run has ended.
  const timer = setTimeout(() => {
    const run = chatRunRegistry.getRun(sessionId);
    if (!run || run.status !== 'running' || run.lastSeq !== 0) {
      return;
    }
    noResponse = true;
    void runtime.abort(run.provider, sessionId)
      .then((aborted) => {
        // Same as `chat.abort`: emit the terminal `complete` on the run's
        // behalf so watching clients see it end.
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: aborted ? 0 : 1, aborted: true });
      })
      .catch((error: unknown) => {
        console.error('[AutoResume] Abort of a silent resume failed', { sessionId, error: errorMessage(error) });
      });
  }, NO_RESPONSE_TIMEOUT_MS);
  timer.unref?.();

  let failure: string | null;
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId,
        userId: row.user_id,
        content: RESUME_MESSAGE,
        options: readOptions(row.options),
        // Not user activity: must not cancel the resume it belongs to. No
        // interruptActiveRun — the dispatcher only gets here when idle.
        origin: 'auto-resume',
      },
      { runtime },
    );
    failure = result.started ? result.error : result.error ?? 'The session was unavailable when this was due.';
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    clearTimeout(timer);
  }

  // A new limit hit reported by this run may still be being recorded.
  await settleHitsInFlight(sessionId);

  // No await between this read and the write: a row that was replaced (a new
  // limit hit) or otherwise resolved meanwhile is left alone.
  const current = autoResumesDb.getLatestForSession(sessionId);
  if (current?.id !== row.id || current.status !== 'sending') {
    return;
  }
  if (noResponse) {
    autoResumesDb.markFailed(row.id, 'No response after resuming.');
  } else if (failure) {
    autoResumesDb.markFailed(row.id, failure);
  } else {
    autoResumesDb.markDone(row.id);
  }
}

/**
 * Starts every due resume whose session is idle. A busy session is re-checked
 * on the next pass, and given up on after an hour. Returns the number started;
 * the attempts themselves are not awaited.
 *
 * Consumer: the scheduled-messages dispatcher, which runs this on its poll so
 * there is one timer for both.
 */
export async function dispatchDueAutoResumes(runtime: ProviderRuntimeGateway, now: Date = new Date()): Promise<number> {
  let started = 0;

  for (const row of autoResumesDb.listDue(now)) {
    if (isSessionBusy(row.session_id, runtime)) {
      autoResumesDb.touchBusy(row.id, now);
      const busySince = row.busy_since ? new Date(row.busy_since).getTime() : now.getTime();
      if (now.getTime() - busySince > MAX_BUSY_WAIT_MS) {
        autoResumesDb.markFailed(row.id, 'The session stayed busy.');
      }
      continue;
    }

    // The claim is the guard against two attempts for one session.
    if (!autoResumesDb.claim(row.id)) {
      continue;
    }
    started += 1;
    void attemptResume(row, runtime).catch((error: unknown) => {
      console.error('[AutoResume] Resume attempt failed', { sessionId: row.session_id, error: errorMessage(error) });
    });
  }

  return started;
}

/**
 * Cancels the session's pending resume; one already sending is left to finish.
 * Returns the number cancelled.
 *
 * Consumer: this module's `initializeAutoResume` (the user-run observer: a
 * user's own message means they have moved on); also the auto-resume routes.
 */
export function cancelPendingAutoResume(sessionId: string): number {
  return autoResumesDb.cancelPendingForSession(sessionId);
}

/**
 * Cancels every pending resume on the server. Returns the number cancelled.
 *
 * Consumer: the auto-resume routes, when the user switches auto-continue off.
 */
export function cancelAllPendingAutoResumes(): number {
  return autoResumesDb.cancelAllPending();
}

/**
 * Dismisses the session's auto-resume: cancels a pending resume and clears a
 * failed one so its notice goes away. Returns the number of rows changed.
 *
 * Consumer: the auto-resume routes, for the composer's cancel and dismiss action.
 */
export function dismissAutoResume(sessionId: string): number {
  return autoResumesDb.cancelPendingForSession(sessionId) + autoResumesDb.dismissFailedForSession(sessionId);
}

/**
 * What the session's composer shows: a pending resume (when it fires and how
 * many attempts it is), and the reason the latest one failed, if it did.
 *
 * Consumer: the auto-resume routes, for the composer's toggle and failure notice.
 */
export function getAutoResumeStatus(sessionId: string): {
  pending: { resumeAt: string; attempts: number } | null;
  failure: { reason: string } | null;
} {
  const active = autoResumesDb.getActiveForSession(sessionId);
  const latest = autoResumesDb.getLatestForSession(sessionId);
  return {
    pending: active?.status === 'pending' ? { resumeAt: active.resume_at, attempts: active.attempts } : null,
    failure: latest?.status === 'failed' ? { reason: latest.failure_reason ?? 'The resume failed.' } : null,
  };
}

/**
 * Recovers rows a previous process left sending, then connects the chat run
 * registry: usage-limit stops are recorded, and a user's own run cancels the
 * session's pending resume. Needs the database to be initialized.
 *
 * Consumer: the server composition root (server/index.ts), at startup.
 */
export function initializeAutoResume(): void {
  autoResumesDb.failAllSending('The server restarted while resuming.');

  chatRunRegistry.setUsageLimitHandler((hit) => {
    void recordUsageLimitHit(hit).catch((error: unknown) => {
      console.error('[AutoResume] Recording a usage-limit stop failed', {
        sessionId: hit.sessionId,
        error: errorMessage(error),
      });
    });
  });
  chatRunRegistry.setUserRunObserver((sessionId) => {
    cancelPendingAutoResume(sessionId);
  });
}
