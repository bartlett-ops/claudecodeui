import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/** Drives `queryClaudeSDK` with a scripted SDK stream (seam: `context.createQuery`) and records limit reports. */
async function runScripted(
  messages: Array<Record<string, unknown>>,
  options: { throwingReporter?: boolean } = {},
): Promise<{ reports: Array<number | null>; sent: NormalizedMessage[] }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-usage-limit-'));
  const reports: Array<number | null> = [];
  const sent: NormalizedMessage[] = [];
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    userId: null,
    reportUsageLimit: (resetsAtMs: number | null) => {
      reports.push(resetsAtMs);
      if (options.throwingReporter) {
        throw new Error('boom');
      }
    },
  };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: () => Object.assign(
      (async function* () { for (const message of messages) { yield message; } })(),
      { interrupt: async () => {}, stopTask: async () => {} },
    ),
  };

  try {
    await queryClaudeSDK('hello', { sessionId: 'app-limit-session', cwd }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return { reports, sent };
}

const SID = 'native-limit-session';
const rateLimitEvent = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event', session_id: SID, rate_limit_info: info,
});
const limitReply = () => ({
  type: 'assistant', session_id: SID, parent_tool_use_id: null, error: 'rate_limit',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'limit reached' }] },
});

test('a confirmed usage-limit stop is reported once with the normalised reset time', async () => {
  const { reports } = await runScripted([
    { type: 'system', subtype: 'init', session_id: SID },
    rateLimitEvent({ status: 'rejected', resetsAt: 1_800_000_000 }),
    limitReply(),
  ]);
  assert.deepEqual(reports, [1_800_000_000_000]);
});

test('a limit stop with overage allowed is not reported', async () => {
  const { reports } = await runScripted([
    { type: 'system', subtype: 'init', session_id: SID },
    rateLimitEvent({ status: 'rejected', resetsAt: 1_800_000_000, overageStatus: 'allowed' }),
    limitReply(),
  ]);
  assert.deepEqual(reports, []);
});

test('a throwing reporter does not break the run', async () => {
  const { reports, sent } = await runScripted([
    { type: 'system', subtype: 'init', session_id: SID },
    rateLimitEvent({ status: 'rejected', resetsAt: 1_800_000_000 }),
    limitReply(),
  ], { throwingReporter: true });
  assert.equal(reports.length, 1);
  assert.ok(sent.length > 0);
});
