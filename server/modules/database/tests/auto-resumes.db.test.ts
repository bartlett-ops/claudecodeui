import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { autoResumesDb, closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';

const SESSION_ID = 'auto-resume-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-resumes-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('resumer', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Auto resume session');
    await runTest(Number(user.id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const AT = new Date('2026-10-18T12:00:00.000Z');

function add(userId: number, resumeAt: Date = AT) {
  return autoResumesDb.replaceActive({ userId, sessionId: SESSION_ID, resumeAt, attempts: 0, options: { model: 'x' } });
}

test('replaceActive cancels the previous active row', async () => {
  await withIsolatedDatabase((userId) => {
    const first = add(userId);
    const second = add(userId);

    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    assert.equal(second.resume_at, AT.toISOString());
    assert.equal(second.options, '{"model":"x"}');
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID)?.id, second.id);
    const rows = getConnection().prepare('SELECT id, status FROM auto_resumes').all() as { id: string; status: string }[];
    assert.equal(rows.find((row) => row.id === first.id)?.status, 'cancelled');
  });
});

test('replaceActive inserts a failed row when a failure reason is given', async () => {
  await withIsolatedDatabase((userId) => {
    const failed = autoResumesDb.replaceActive({
      userId, sessionId: SESSION_ID, resumeAt: AT, attempts: 3, options: {}, failureReason: 'nope',
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure_reason, 'nope');
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID), undefined);
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID)?.id, failed.id);
    assert.equal(autoResumesDb.dismissFailedForSession(SESSION_ID), 1);
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID)?.status, 'cancelled');
  });
});

test('only one pending or sending row can exist per session', async () => {
  await withIsolatedDatabase((userId) => {
    add(userId);
    assert.throws(() =>
      getConnection()
        .prepare(
          `INSERT INTO auto_resumes (id, user_id, session_id, resume_at, status, options)
           VALUES ('dup', ?, ?, ?, 'pending', '{}')`
        )
        .run(userId, SESSION_ID, AT.toISOString())
    );
  });
});

test('claim succeeds once', async () => {
  await withIsolatedDatabase((userId) => {
    const row = add(userId);
    assert.equal(autoResumesDb.claim(row.id), true);
    assert.equal(autoResumesDb.claim(row.id), false);
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID)?.status, 'sending');
  });
});

test('touchBusy only sets busy_since once; markDone and markFailed resolve the row', async () => {
  await withIsolatedDatabase((userId) => {
    const row = add(userId);
    autoResumesDb.touchBusy(row.id, new Date('2026-10-18T12:01:00.000Z'));
    autoResumesDb.touchBusy(row.id, new Date('2026-10-18T12:02:00.000Z'));
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID)?.busy_since, '2026-10-18T12:01:00.000Z');
    autoResumesDb.markFailed(row.id, 'x'.repeat(600));
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID)?.failure_reason?.length, 500);
    const next = add(userId);
    autoResumesDb.markDone(next.id);
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID)?.status, 'done');
  });
});

test('listDue ignores future and non-pending rows', async () => {
  await withIsolatedDatabase((userId) => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    const due = add(userId, new Date('2026-10-18T11:00:00.000Z'));
    assert.deepEqual(autoResumesDb.listDue(now).map((row) => row.id), [due.id]);

    autoResumesDb.claim(due.id);
    assert.deepEqual(autoResumesDb.listDue(now), []);

    add(userId, new Date('2026-10-18T13:00:00.000Z'));
    assert.deepEqual(autoResumesDb.listDue(now), []);
  });
});

test('cancelAllPending leaves sending rows alone', async () => {
  await withIsolatedDatabase((userId) => {
    const row = add(userId);
    autoResumesDb.claim(row.id);
    assert.equal(autoResumesDb.cancelAllPending(), 0);
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID)?.status, 'sending');

    autoResumesDb.markDone(row.id);
    add(userId);
    assert.equal(autoResumesDb.cancelAllPending(), 1);
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID), undefined);
  });
});

test('cancelPendingForSession cancels only pending rows', async () => {
  await withIsolatedDatabase((userId) => {
    add(userId);
    assert.equal(autoResumesDb.cancelPendingForSession(SESSION_ID), 1);
    assert.equal(autoResumesDb.cancelPendingForSession(SESSION_ID), 0);
  });
});

test('failAllSending marks them failed with the reason', async () => {
  await withIsolatedDatabase((userId) => {
    const row = add(userId);
    autoResumesDb.claim(row.id);
    assert.equal(autoResumesDb.failAllSending('server restarted'), 1);
    const latest = autoResumesDb.getLatestForSession(SESSION_ID);
    assert.equal(latest?.status, 'failed');
    assert.equal(latest?.failure_reason, 'server restarted');
  });
});

test('deleting the session removes its rows', async () => {
  await withIsolatedDatabase((userId) => {
    assert.equal(getConnection().pragma('foreign_keys', { simple: true }), 1);
    add(userId);
    getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(SESSION_ID);
    assert.equal(autoResumesDb.getLatestForSession(SESSION_ID), undefined);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM auto_resumes').get() as { n: number }).n, 0);
  });
});
