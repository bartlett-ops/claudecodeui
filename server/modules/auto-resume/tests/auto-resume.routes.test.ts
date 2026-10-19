import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { autoResumeRoutes } from '@/modules/auto-resume/index.js';
import { autoResumesDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const SESSION_ID = 'auto-resume-routes-session';
const OTHER_SESSION_ID = 'auto-resume-routes-other';

type Context = { baseUrl: string; userId: number; configDirectory: string };

async function withServer(run: (context: Context) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auto-resume-routes-'));
  const configDirectory = path.join(tempDirectory, 'claude');
  await mkdir(configDirectory);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  await initializeDatabase();
  await writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ autoContinueAtUsageLimit: true }));

  const user = userDb.createUser('route-user', 'hash');
  const userId = Number(user.id);
  sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Routes session');
  sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', tempDirectory, 'Other session');

  const app = express().use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/auto-resume', autoResumeRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, userId, configDirectory });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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

function putSetting(baseUrl: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/auto-resume/setting`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function addPending(userId: number, sessionId: string): void {
  autoResumesDb.replaceActive({
    userId,
    sessionId,
    resumeAt: new Date(Date.now() + 60_000),
    attempts: 1,
    options: {},
  });
}

test('status returns setting, pending and failure for a session', async () => {
  await withServer(async ({ baseUrl, userId }) => {
    addPending(userId, SESSION_ID);
    const response = await fetch(`${baseUrl}/api/auto-resume/status?sessionId=${SESSION_ID}`);
    const payload = await response.json() as {
      data: { setting: { enabled: boolean }; pending: { attempts: number } | null; failure: unknown };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.data.setting.enabled, true);
    assert.equal(payload.data.pending?.attempts, 1);
    assert.equal(payload.data.failure, null);

    autoResumesDb.replaceActive({
      userId,
      sessionId: OTHER_SESSION_ID,
      resumeAt: new Date(),
      attempts: 0,
      options: {},
      failureReason: 'boom',
    });
    const failed = await (await fetch(`${baseUrl}/api/auto-resume/status?sessionId=${OTHER_SESSION_ID}`)).json() as {
      data: { pending: unknown; failure: { reason: string } | null };
    };
    assert.equal(failed.data.pending, null);
    assert.equal(failed.data.failure?.reason, 'boom');
  });
});

test('status requires sessionId', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/auto-resume/status`);
    assert.equal(response.status, 400);
  });
});

test('PUT setting rejects a non-boolean', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await putSetting(baseUrl, { enabled: 'yes' });
    const payload = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'INVALID_REQUEST_BODY');
  });
});

test('PUT setting off cancels every pending resume', async () => {
  await withServer(async ({ baseUrl, userId, configDirectory }) => {
    addPending(userId, SESSION_ID);
    addPending(userId, OTHER_SESSION_ID);
    const response = await putSetting(baseUrl, { enabled: false });
    const payload = await response.json() as { data: { enabled: boolean } };
    assert.equal(response.status, 200);
    assert.equal(payload.data.enabled, false);
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID), undefined);
    assert.equal(autoResumesDb.getActiveForSession(OTHER_SESSION_ID), undefined);
    const written = JSON.parse(await readFile(path.join(configDirectory, 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(written.autoContinueAtUsageLimit, false);
  });
});

test('PUT setting surfaces the locked error as 409', async () => {
  await withServer(async ({ baseUrl, userId, configDirectory }) => {
    // A managed-settings file elsewhere is not reachable from CLAUDE_CONFIG_DIR, so
    // lock by making the user file unreadable as JSON.
    await writeFile(path.join(configDirectory, 'settings.json'), '{ not json');
    addPending(userId, SESSION_ID);
    const response = await putSetting(baseUrl, { enabled: false });
    assert.equal(response.status, 409);
    assert.ok(autoResumesDb.getActiveForSession(SESSION_ID), 'a refused change must not cancel resumes');
  });
});

test('DELETE cancels pending and dismisses failed', async () => {
  await withServer(async ({ baseUrl, userId }) => {
    addPending(userId, SESSION_ID);
    autoResumesDb.replaceActive({
      userId,
      sessionId: OTHER_SESSION_ID,
      resumeAt: new Date(),
      attempts: 0,
      options: {},
      failureReason: 'boom',
    });

    for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
      const response = await fetch(`${baseUrl}/api/auto-resume/sessions/${id}`, { method: 'DELETE' });
      assert.equal(response.status, 200);
    }
    assert.equal(autoResumesDb.getActiveForSession(SESSION_ID), undefined);
    assert.equal(autoResumesDb.getLatestForSession(OTHER_SESSION_ID)?.status, 'cancelled');
  });
});
