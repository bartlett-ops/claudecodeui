import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { ChatUsageLimitHit } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-usage-limit-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.setUsageLimitHandler(() => {});
    chatRunRegistry.setUserRunObserver(() => {});
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type FakeWriter = { reportUsageLimit: (resetsAtMs: number | null) => void };

function fakeDependencies(onRun?: (writer: FakeWriter) => void) {
  return {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, _options: unknown, writer: FakeWriter) => {
        onRun?.(writer);
      },
    } as never,
  };
}

test('a writer\'s reported limit reaches the registry handler with session, user and picked options', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('limit-1', 'claude', '/workspace/demo');
    const hits: ChatUsageLimitHit[] = [];
    chatRunRegistry.setUsageLimitHandler((hit) => { hits.push(hit); });

    await runDetachedChatTurn(
      {
        sessionId: 'limit-1',
        userId: 7,
        content: 'hi',
        options: { model: 'opus', effort: 'high', permissionMode: 5, cwd: '/x' },
      },
      fakeDependencies((writer) => writer.reportUsageLimit(123)),
    );

    assert.deepEqual(hits, [{ sessionId: 'limit-1', userId: 7, resetsAtMs: 123, options: { model: 'opus', effort: 'high' } }]);
  });
});

test('a throwing usage-limit handler does not break the run', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('limit-2', 'claude', '/workspace/demo');
    chatRunRegistry.setUsageLimitHandler(() => { throw new Error('boom'); });

    const result = await runDetachedChatTurn(
      { sessionId: 'limit-2', userId: null, content: 'hi' },
      fakeDependencies((writer) => writer.reportUsageLimit(null)),
    );

    assert.deepEqual(result, { started: true, error: null });
  });
});

test('a user turn notifies the user-run observer, an auto-resume turn does not', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('limit-3', 'claude', '/workspace/demo');
    const seen: string[] = [];
    chatRunRegistry.setUserRunObserver((sessionId) => { seen.push(sessionId); });

    await runDetachedChatTurn({ sessionId: 'limit-3', userId: null, content: 'a' }, fakeDependencies());
    await runDetachedChatTurn({ sessionId: 'limit-3', userId: null, content: 'b', origin: 'auto-resume' }, fakeDependencies());

    assert.deepEqual(seen, ['limit-3']);
  });
});
