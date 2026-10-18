import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeSettingsAutoContinueService } from '@/modules/providers/services/claude-settings-auto-continue.service.js';

// CCU-1: the auto-continue switch lives in the Claude settings files so the
// CLI and CloudCLI agree on it. Managed settings win and lock the switch.

const withPaths = async (
  run: (paths: { userPath: string; managedPath: string }) => Promise<void>,
) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-auto-continue-'));
  try {
    await run({ userPath: path.join(dir, 'nested', 'settings.json'), managedPath: path.join(dir, 'managed.json') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const put = async (file: string, value: unknown) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

test('defaults to off when no file sets it', () => withPaths(async (paths) => {
  assert.deepEqual(await claudeSettingsAutoContinueService.read(paths), {
    enabled: false, source: 'default', locked: false, userFileStatus: 'missing',
  });
}));

test('user value is used when managed is silent', () => withPaths(async (paths) => {
  await put(paths.userPath, { autoContinueAtUsageLimit: true });
  await put(paths.managedPath, { other: 1 });
  assert.deepEqual(await claudeSettingsAutoContinueService.read(paths), {
    enabled: true, source: 'user', locked: false, userFileStatus: 'ok',
  });
}));

test('managed value wins over user and reports locked', () => withPaths(async (paths) => {
  await put(paths.userPath, { autoContinueAtUsageLimit: true });
  await put(paths.managedPath, { autoContinueAtUsageLimit: false });
  assert.deepEqual(await claudeSettingsAutoContinueService.read(paths), {
    enabled: false, source: 'managed', locked: true, userFileStatus: 'ok',
  });
}));

test('a non-boolean value counts as unset', () => withPaths(async (paths) => {
  await put(paths.userPath, { autoContinueAtUsageLimit: 'yes' });
  const setting = await claudeSettingsAutoContinueService.read(paths);
  assert.equal(setting.enabled, false);
  assert.equal(setting.source, 'default');
}));

test('write creates a missing file containing only the key', () => withPaths(async (paths) => {
  const setting = await claudeSettingsAutoContinueService.write(true, paths);
  assert.equal(setting.enabled, true);
  assert.equal(await readFile(paths.userPath, 'utf8'), '{\n  "autoContinueAtUsageLimit": true\n}\n');
}));

test('write keeps every other key', () => withPaths(async (paths) => {
  await put(paths.userPath, { permissions: { allow: ['Bash'] }, model: 'x' });
  await claudeSettingsAutoContinueService.write(true, paths);
  assert.deepEqual(JSON.parse(await readFile(paths.userPath, 'utf8')), {
    permissions: { allow: ['Bash'] }, model: 'x', autoContinueAtUsageLimit: true,
  });
}));

test("write preserves a UTF-16LE BOM file's encoding", () => withPaths(async (paths) => {
  await put(paths.userPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]));
  await claudeSettingsAutoContinueService.write(true, paths);
  const bytes = await readFile(paths.userPath);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xfe);
  assert.deepEqual(JSON.parse(bytes.subarray(2).toString('utf16le')), { a: 1, autoContinueAtUsageLimit: true });
}));

test('write refuses an invalid file and leaves it byte-identical', () => withPaths(async (paths) => {
  await put(paths.userPath, '{ not json');
  await assert.rejects(
    claudeSettingsAutoContinueService.write(true, paths),
    (error: { code?: string; statusCode?: number }) => error.code === 'CLAUDE_SETTINGS_INVALID' && error.statusCode === 409,
  );
  assert.equal(await readFile(paths.userPath, 'utf8'), '{ not json');
}));

test('write refuses when locked', () => withPaths(async (paths) => {
  await put(paths.managedPath, { autoContinueAtUsageLimit: true });
  await assert.rejects(
    claudeSettingsAutoContinueService.write(false, paths),
    (error: { code?: string; statusCode?: number }) => error.code === 'CLAUDE_SETTINGS_LOCKED' && error.statusCode === 409,
  );
}));

test('write leaves no temp file behind', () => withPaths(async (paths) => {
  await put(paths.userPath, { a: 1 });
  await claudeSettingsAutoContinueService.write(true, paths);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.dirname(paths.userPath)), ['settings.json']);
}));

test('write through a symlink keeps the link and updates its target', () => withPaths(async (paths) => {
  const { lstat, symlink } = await import('node:fs/promises');
  const target = path.join(path.dirname(paths.userPath), 'real.json');
  await put(target, { a: 1 });
  await symlink(target, paths.userPath);
  await claudeSettingsAutoContinueService.write(true, paths);
  assert.equal((await lstat(paths.userPath)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { a: 1, autoContinueAtUsageLimit: true });
}));

test('write keeps a 0600 file at 0600', () => withPaths(async (paths) => {
  const { chmod, stat } = await import('node:fs/promises');
  await put(paths.userPath, { a: 1 });
  await chmod(paths.userPath, 0o600);
  await claudeSettingsAutoContinueService.write(true, paths);
  assert.equal((await stat(paths.userPath)).mode & 0o777, 0o600);
}));
