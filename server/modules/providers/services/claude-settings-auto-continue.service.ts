import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError, readObjectRecord } from '@/shared/utils.js';

import {
  decodeSettingsFile,
  managedSettingsPath,
  MAX_SETTINGS_FILE_BYTES,
  userSettingsPath,
} from './claude-settings-permissions.service.js';

const SETTING_KEY = 'autoContinueAtUsageLimit';

/**
 * The effective auto-continue switch. Consumers: the auto-resume module (via the
 * providers barrel) decides whether to resume after a usage limit, and a
 * future Settings route will show it.
 *
 * `locked` is true when managed settings set the key, so it cannot be changed here.
 */
export type AutoContinueSetting = {
  enabled: boolean;
  source: 'managed' | 'user' | 'default';
  locked: boolean;
  userFileStatus: 'ok' | 'missing' | 'invalid';
};

type SettingsPaths = { userPath?: string; managedPath?: string };

type LoadedSettingsFile = {
  status: 'ok' | 'missing' | 'invalid';
  settings: Record<string, unknown>;
  isUtf16: boolean;
};

// Mirrors the status logic of the permissions reader: unreadable, oversized or
// non-object files are `invalid`; an empty file is an empty object.
async function loadSettingsFile(filePath: string): Promise<LoadedSettingsFile> {
  let bytes: Buffer;
  try {
    if ((await stat(filePath)).size > MAX_SETTINGS_FILE_BYTES) {
      return { status: 'invalid', settings: {}, isUtf16: false };
    }
    bytes = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'invalid', settings: {}, isUtf16: false };
  }

  const isUtf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const content = decodeSettingsFile(bytes);
  if (!content.trim()) {
    return { status: 'ok', settings: {}, isUtf16 };
  }

  let settings: Record<string, unknown> | null;
  try {
    settings = readObjectRecord(JSON.parse(content));
  } catch {
    settings = null;
  }
  return settings
    ? { status: 'ok', settings, isUtf16 }
    : { status: 'invalid', settings: {}, isUtf16 };
}

// Only a real boolean counts; anything else is treated as unset.
const readFlag = (settings: Record<string, unknown>): boolean | undefined =>
  typeof settings[SETTING_KEY] === 'boolean' ? (settings[SETTING_KEY] as boolean) : undefined;

/**
 * Reads and writes the `autoContinueAtUsageLimit` key of the Claude settings
 * files. Managed settings win over the user file.
 *
 * Used by the auto-resume
 * module to decide whether to resume (a Settings route will follow). `paths` is only overridden by tests.
 */
export const claudeSettingsAutoContinueService = {
  async read(paths: SettingsPaths = {}): Promise<AutoContinueSetting> {
    const [user, managed] = await Promise.all([
      loadSettingsFile(paths.userPath ?? userSettingsPath()),
      loadSettingsFile(paths.managedPath ?? managedSettingsPath()),
    ]);

    const managedValue = readFlag(managed.settings);
    if (managedValue !== undefined) {
      return { enabled: managedValue, source: 'managed', locked: true, userFileStatus: user.status };
    }
    const userValue = readFlag(user.settings);
    if (userValue !== undefined) {
      return { enabled: userValue, source: 'user', locked: false, userFileStatus: user.status };
    }
    return { enabled: false, source: 'default', locked: false, userFileStatus: user.status };
  },

  async write(enabled: boolean, paths: SettingsPaths = {}): Promise<AutoContinueSetting> {
    const userPath = paths.userPath ?? userSettingsPath();
    const current = await this.read({ ...paths, userPath });
    if (current.locked) {
      throw new AppError('Managed Claude settings control this option.', {
        code: 'CLAUDE_SETTINGS_LOCKED',
        statusCode: 409,
      });
    }
    if (current.userFileStatus === 'invalid') {
      throw new AppError('The Claude settings file is invalid, so it was left unchanged.', {
        code: 'CLAUDE_SETTINGS_INVALID',
        statusCode: 409,
      });
    }

    const { settings, isUtf16 } = await loadSettingsFile(userPath);
    const text = `${JSON.stringify({ ...settings, [SETTING_KEY]: enabled }, null, 2)}\n`;
    const output = isUtf16
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      : Buffer.from(text, 'utf8');

    await mkdir(path.dirname(userPath), { recursive: true });
    await writeFile(userPath, output);
    return this.read({ ...paths, userPath });
  },
};
