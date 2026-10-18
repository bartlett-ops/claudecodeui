import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { AutoResumeStatus } from '@/shared/types';
import { useAutoResume } from '@/modules/chat/composer/useAutoResume';

function statusResponse(enabled: boolean, pending: AutoResumeStatus['pending'] = null): Response {
  const data: AutoResumeStatus = {
    setting: { enabled, source: 'user', locked: false, userFileStatus: 'ok' },
    pending,
    failure: null,
  };
  return { ok: true, json: async () => ({ success: true, data }) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('loads status for the session', async () => {
  const spy = vi.spyOn(api.autoResume, 'status').mockResolvedValue(statusResponse(true));

  const { result } = renderHook(() => useAutoResume('session-a'));

  await waitFor(() => assert.equal(result.current.status?.setting.enabled, true));
  assert.deepEqual(spy.mock.calls[0], ['session-a']);
});

test('ignores a stale response after a session switch', async () => {
  let releaseSessionA: (() => void) | undefined;
  vi.spyOn(api.autoResume, 'status').mockImplementation((sessionId: string) => {
    if (sessionId === 'session-a') {
      return new Promise<Response>((resolve) => {
        releaseSessionA = () => resolve(statusResponse(true, { resumeAt: '2026-08-28T12:00:00.000Z', attempts: 1 }));
      });
    }
    return Promise.resolve(statusResponse(false));
  });

  const { result, rerender } = renderHook(({ sessionId }) => useAutoResume(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  rerender({ sessionId: 'session-b' });
  await waitFor(() => assert.equal(result.current.status?.setting.enabled, false));

  await act(async () => {
    releaseSessionA?.();
  });

  assert.equal(result.current.status?.setting.enabled, false);
  assert.equal(result.current.status?.pending, null);
});

test('clears the previous session\'s status immediately on a switch', async () => {
  vi.spyOn(api.autoResume, 'status').mockImplementation((sessionId: string) =>
    sessionId === 'session-a' ? Promise.resolve(statusResponse(true)) : new Promise<Response>(() => {}));

  const { result, rerender } = renderHook(({ sessionId }) => useAutoResume(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(result.current.status));

  rerender({ sessionId: 'session-b' });

  assert.equal(result.current.status, null);
});

test('setEnabled posts and refreshes', async () => {
  let enabled = false;
  vi.spyOn(api.autoResume, 'status').mockImplementation(async () => statusResponse(enabled));
  const setEnabled = vi.spyOn(api.autoResume, 'setEnabled').mockImplementation(async (value: boolean) => {
    enabled = value;
    return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
  });

  const { result } = renderHook(() => useAutoResume('session-a'));
  await waitFor(() => assert.equal(result.current.status?.setting.enabled, false));

  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.setEnabled(true);
  });

  assert.equal(ok, true);
  assert.deepEqual(setEnabled.mock.calls[0], [true]);
  assert.equal(result.current.status?.setting.enabled, true);
});

test('cancel dismisses the session and refreshes', async () => {
  vi.spyOn(api.autoResume, 'status').mockResolvedValue(statusResponse(true));
  const cancel = vi.spyOn(api.autoResume, 'cancel').mockResolvedValue({ ok: true } as Response);

  const { result } = renderHook(() => useAutoResume('session-a'));
  await waitFor(() => assert.ok(result.current.status));

  await act(async () => {
    await result.current.cancel();
  });

  assert.deepEqual(cancel.mock.calls[0], ['session-a']);
});
