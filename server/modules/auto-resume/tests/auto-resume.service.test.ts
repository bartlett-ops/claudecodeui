import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  attemptResume,
  cancelPendingAutoResume,
  dispatchDueAutoResumes,
  getAutoResumeStatus,
  initializeAutoResume,
  recordUsageLimitHit,
} from '@/modules/auto-resume/index.js';
import { autoResumesDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import type { AutoResumeRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'auto-resume-session';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Context = { userId: number; configDirectory: string };

async function setAutoContinue(configDirectory: string, enabled: boolean): Promise<void> {
  await writeFile(
    path.join(configDirectory, 'settings.json'),
    JSON.stringify({ autoContinueAtUsageLimit: enabled }),
  );
}

async function withIsolatedDatabase(runTest: (context: Context) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-resume-'));
  const configDirectory = path.join(tempDirectory, 'claude');
  await mkdir(configDirectory);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  await initializeDatabase();

  try {
    await setAutoContinue(configDirectory, true);
    const user = userDb.createUser('resumer', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Auto-resume session');
    await runTest({ userId: Number(user.id), configDirectory });
  } finally {
    chatRunRegistry.setUsageLimitHandler(() => {});
    chatRunRegistry.setUserRunObserver(() => {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type FakeWriter = {
  reportUsageLimit: (resetsAtMs: number | null) => void;
  send: (message: Record<string, unknown>) => void;
};
type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(input: {
  runs?: RunCall[];
  aborts?: string[];
  hasRuntime?: boolean;
  hasBackgroundWork?: (sessionId: string) => boolean;
  onRun?: (writer: FakeWriter) => void | Promise<void>;
} = {}) {
  let releaseRun: (() => void) | null = null;
  const runtime = {
    hasRuntime: () => input.hasRuntime ?? true,
    hasBackgroundWork: input.hasBackgroundWork ?? (() => false),
    run: async (provider: string, command: string, options: Record<string, unknown>, writer: FakeWriter) => {
      input.runs?.push({ provider, command, options });
      await input.onRun?.(writer);
    },
    abort: async (_provider: string, sessionId: string) => {
      input.aborts?.push(sessionId);
      releaseRun?.();
      return true;
    },
  };
  return {
    runtime: runtime as never,
    // Lets a test hold a run open until it is aborted.
    holdUntilAborted: () => new Promise<void>((resolve) => { releaseRun = resolve; }),
  };
}

function hitFor(userId: number, resetsAtMs: number | null, options: Record<string, unknown> = { model: 'opus' }) {
  return { sessionId: SESSION_ID, userId, resetsAtMs, options };
}

function latestRow(): AutoResumeRow {
  const row = autoResumesDb.getLatestForSession(SESSION_ID);
  assert.ok(row, 'expected an auto-resume row');
  return row;
}

function createPendingRow(userId: number): AutoResumeRow {
  return autoResumesDb.replaceActive({
    userId,
    sessionId: SESSION_ID,
    resumeAt: new Date(Date.now() - 1_000),
    attempts: 1,
    options: { model: 'opus' },
  });
}

async function claimedRow(userId: number): Promise<AutoResumeRow> {
  const row = createPendingRow(userId);
  assert.equal(autoResumesDb.claim(row.id), true);
  return latestRow();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was never met');
}

test('a hit with the setting off records nothing', async () => {
  await withIsolatedDatabase(async ({ userId, configDirectory }) => {
    await setAutoContinue(configDirectory, false);
    const result = await recordUsageLimitHit(hitFor(userId, Date.now() + HOUR_MS));
    assert.equal(result, null);
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID), undefined);
  });
});

test('a hit schedules a pending row at resetsAt plus 5 seconds', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const now = new Date('2026-10-18T10:00:00.000Z');
    const resetsAtMs = now.getTime() + HOUR_MS;
    const row = await recordUsageLimitHit(hitFor(userId, resetsAtMs), now);
    assert.ok(row);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.resume_at, new Date(resetsAtMs + 5_000).toISOString());
    assert.deepEqual(JSON.parse(row.options), { model: 'opus' });
  });
});

test('a missing reset time records a failed row and sends nothing', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const row = await recordUsageLimitHit(hitFor(userId, null));
    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 0);
    assert.equal(row.failure_reason, 'The limit was hit but its reset time was not reported.');

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueAutoResumes(createRuntime({ runs }).runtime, new Date(Date.now() + DAY_MS)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a reset more than 7 days and an hour away is recorded as failed', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const now = new Date();
    const row = await recordUsageLimitHit(hitFor(userId, now.getTime() + 7 * DAY_MS + HOUR_MS), now);
    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure_reason, 'The reset time is too far away.');

    // Just inside the ceiling is still scheduled.
    const inside = await recordUsageLimitHit(hitFor(userId, now.getTime() + 7 * DAY_MS + HOUR_MS - 5_000), now);
    assert.equal(inside?.status, 'pending');
  });
});

test('a new hit replaces the pending row', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const now = new Date();
    const first = await recordUsageLimitHit(hitFor(userId, now.getTime() + HOUR_MS), now);
    const second = await recordUsageLimitHit(hitFor(userId, now.getTime() + 2 * HOUR_MS), now);
    assert.ok(first && second);
    assert.notEqual(first.id, second.id);
    // A replaced pending row was never attempted, so the count starts over.
    assert.equal(second.attempts, 1);
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID)?.id, second.id);
  });
});

test('a hit during a sending attempt increments attempts; the fourth is recorded failed', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const now = new Date();
    const resetsAtMs = now.getTime() + HOUR_MS;
    let row = await recordUsageLimitHit(hitFor(userId, resetsAtMs), now);
    assert.equal(row?.attempts, 1);

    for (const expected of [2, 3]) {
      assert.ok(row && autoResumesDb.claim(row.id));
      row = await recordUsageLimitHit(hitFor(userId, resetsAtMs), now);
      assert.equal(row?.status, 'pending');
      assert.equal(row?.attempts, expected);
    }

    assert.ok(row && autoResumesDb.claim(row.id));
    row = await recordUsageLimitHit(hitFor(userId, resetsAtMs), now);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.failure_reason, 'Gave up after 3 attempts; the limit was hit again.');
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID), undefined);
  });
});

test('a due resume is sent as continue with origin auto-resume', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    initializeAutoResume();
    const userRuns: string[] = [];
    // Replaces the observer initializeAutoResume installed; an auto-resume
    // turn must not be reported as user activity.
    chatRunRegistry.setUserRunObserver((sessionId) => { userRuns.push(sessionId); });

    const now = new Date();
    const row = await recordUsageLimitHit(hitFor(userId, now.getTime() - 10_000, { model: 'opus', effort: 'high' }), now);
    assert.ok(row);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueAutoResumes(createRuntime({ runs }).runtime, now), 1);
    await waitUntil(() => latestRow().status !== 'sending');

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue');
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(runs[0].options.effort, 'high');
    assert.deepEqual(userRuns, []);
  });
});

test('a resume repeats the stopped run\'s tool settings and skipPermissions', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const toolsSettings = { allowedTools: [], disallowedTools: ['Bash'], skipPermissions: true };
    const now = new Date();
    const row = await recordUsageLimitHit(
      hitFor(userId, now.getTime() - 10_000, { model: 'opus', toolsSettings, skipPermissions: true }),
      now,
    );
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.options), { model: 'opus', toolsSettings, skipPermissions: true });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueAutoResumes(createRuntime({ runs }).runtime, now), 1);
    await waitUntil(() => latestRow().status !== 'sending');

    assert.deepEqual(runs[0].options.toolsSettings, toolsSettings);
    assert.equal(runs[0].options.skipPermissions, true);
  });
});

test('a due resume waits while the session is busy and fails after an hour busy', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const row = createPendingRow(userId);
    const runs: RunCall[] = [];
    const { runtime } = createRuntime({ runs, hasBackgroundWork: (sessionId) => sessionId === SESSION_ID });

    const firstBusy = new Date();
    assert.equal(await dispatchDueAutoResumes(runtime, firstBusy), 0);
    assert.equal(latestRow().status, 'pending');
    assert.equal(latestRow().busy_since, firstBusy.toISOString());

    // Still busy, but within the hour: keeps waiting, and the first busy time is kept.
    assert.equal(await dispatchDueAutoResumes(runtime, new Date(firstBusy.getTime() + 30 * 60_000)), 0);
    assert.equal(latestRow().status, 'pending');
    assert.equal(latestRow().busy_since, firstBusy.toISOString());

    assert.equal(await dispatchDueAutoResumes(runtime, new Date(firstBusy.getTime() + HOUR_MS + 60_000)), 0);
    assert.equal(latestRow().id, row.id);
    assert.equal(latestRow().status, 'failed');
    assert.equal(latestRow().failure_reason, 'The session stayed busy.');
    assert.equal(runs.length, 0);
  });
});

test('a run that completes without a new hit marks the row done', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    initializeAutoResume();
    const row = await claimedRow(userId);
    const { runtime } = createRuntime({
      onRun: (writer) => { writer.send({ kind: 'text', content: 'carrying on' }); },
    });
    await attemptResume(row, runtime);
    assert.equal(latestRow().status, 'done');
  });
});

test('a run that reports a new hit leaves the replacement pending', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    initializeAutoResume();
    const row = await claimedRow(userId);
    const { runtime } = createRuntime({
      onRun: (writer) => { writer.reportUsageLimit(Date.now() + HOUR_MS); },
    });
    await attemptResume(row, runtime);

    const active = autoResumesDb.getActiveForSession(SESSION_ID);
    assert.ok(active);
    assert.notEqual(active.id, row.id);
    assert.equal(active.status, 'pending');
    assert.equal(active.attempts, 2);
  });
});

test('a run with no output for two minutes is aborted and marked failed', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const row = await claimedRow(userId);
    const aborts: string[] = [];
    const fake = createRuntime({ aborts, onRun: () => fake.holdUntilAborted() });

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const attempt = attemptResume(row, fake.runtime);
      // Let the run reach the runtime before time moves on.
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(119_000);
      assert.deepEqual(aborts, []);
      mock.timers.tick(1_000);
      await attempt;
    } finally {
      mock.timers.reset();
    }

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(latestRow().status, 'failed');
    assert.equal(latestRow().failure_reason, 'No response after resuming.');
  });
});

test('a run that cannot start marks the row failed with the reason', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const row = await claimedRow(userId);
    await attemptResume(row, createRuntime({ hasRuntime: false }).runtime);
    assert.equal(latestRow().status, 'failed');
    assert.equal(latestRow().failure_reason, 'Provider "claude" is not available.');
    assert.deepEqual(getAutoResumeStatus(SESSION_ID), {
      pending: null,
      failure: { reason: 'Provider "claude" is not available.' },
    });
  });
});

test('cancelPendingAutoResume cancels pending but not sending rows', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const pending = createPendingRow(userId);
    assert.deepEqual(getAutoResumeStatus(SESSION_ID), {
      pending: { resumeAt: pending.resume_at, attempts: 1 },
      failure: null,
    });
    assert.equal(cancelPendingAutoResume(SESSION_ID), 1);
    assert.equal(latestRow().status, 'cancelled');

    await claimedRow(userId);
    assert.equal(cancelPendingAutoResume(SESSION_ID), 0);
    assert.equal(latestRow().status, 'sending');
  });
});

test('initializeAutoResume fails rows left sending by a previous process', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    await claimedRow(userId);
    initializeAutoResume();
    assert.equal(latestRow().status, 'failed');
    assert.ok(latestRow().failure_reason);
  });
});

test('initializeAutoResume wires a user run to cancel the pending resume', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    createPendingRow(userId);
    initializeAutoResume();
    chatRunRegistry.notifyUserRun(SESSION_ID);
    assert.equal(latestRow().status, 'cancelled');
  });
});
