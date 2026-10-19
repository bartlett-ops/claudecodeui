import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { AutoResumeStatus, LLMProvider } from '@/shared/types';

/** How often the status is refetched while mounted, so a resume that fired server-side shows up. */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * The auto-resume setting and the resume state of one session.
 *
 * Auto-resume is a server-side timer, so this is a plain fetch plus a slow
 * poll rather than anything realtime. It only exists for Claude sessions: for
 * any other provider nothing is fetched and the status stays null, which
 * hides the composer toggle.
 */
export function useAutoResume(requestedSessionId: string | null, provider: LLMProvider) {
  const sessionId = provider === 'claude' ? requestedSessionId : null;
  // The last status the server reported for the session on screen; null until
  // it loads, which keeps the composer toggle hidden rather than guessing.
  const [status, setStatus] = useState<AutoResumeStatus | null>(null);
  // Which session the status on screen belongs to. A fetch that resolves after
  // the user has moved on must not put the old session's state on the new one.
  const activeSessionRef = useRef(sessionId);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    try {
      const response = await api.autoResume.status(sessionId);
      if (!response.ok) {
        // A transient failure keeps what is on screen rather than hiding the toggle.
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (activeSessionRef.current !== sessionId) {
        return;
      }
      setStatus(payload?.data ?? null);
    } catch (error) {
      console.error('Failed to load auto-resume status:', error);
    }
  }, [sessionId]);

  // Cleared during the switch render so the previous session's state never
  // paints over the new one, not even for the frame before an effect runs.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setStatus(null);
  }

  useEffect(() => {
    activeSessionRef.current = sessionId;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, sessionId]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      const response = await api.autoResume.setEnabled(enabled);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await refresh();
      return true;
    } catch (error) {
      console.error('Failed to update auto-resume setting:', error);
      return false;
    }
  }, [refresh]);

  // Resolves false when the server did not dismiss the resume.
  const cancel = useCallback(async () => {
    if (!sessionId) return false;

    let ok = false;
    try {
      const response = await api.autoResume.cancel(sessionId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      ok = true;
    } catch (error) {
      console.error('Failed to cancel auto-resume:', error);
    }
    await refresh();
    return ok;
  }, [refresh, sessionId]);

  return { status, setEnabled, cancel, refresh };
}
