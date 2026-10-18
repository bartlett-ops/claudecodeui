import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
 * The effective auto-continue switch. Consumers: the auto-resume module
 * (server/modules/auto-resume, via the providers barrel) and its routes, to
 * decide whether to resume after a usage limit and to show the switch.
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

// Managed settings win over the user file; a non-boolean value counts as unset.
const resolveSetting = (user: LoadedSettingsFile, managed: LoadedSettingsFile): AutoContinueSetting => {
  const managedValue = readFlag(managed.settings);
  if (managedValue !== undefined) {
    return { enabled: managedValue, source: 'managed', locked: true, userFileStatus: user.status };
  }
  const userValue = readFlag(user.settings);
  if (userValue !== undefined) {
    return { enabled: userValue, source: 'user', locked: false, userFileStatus: user.status };
  }
  return { enabled: false, source: 'default', locked: false, userFileStatus: user.status };
};

/**
 * Reads and writes the `autoContinueAtUsageLimit` key of the Claude settings
 * files. Managed settings win over the user file.
 *
 * Used by the auto-resume module (server/modules/auto-resume, via the
 * providers barrel) and its routes. `paths` is only overridden by tests.
 */
export const claudeSettingsAutoContinueService = {
  async read(paths: SettingsPaths = {}): Promise<AutoContinueSetting> {
    const [user, managed] = await Promise.all([
      loadSettingsFile(paths.userPath ?? userSettingsPath()),
      loadSettingsFile(paths.managedPath ?? managedSettingsPath()),
    ]);
    return resolveSetting(user, managed);
  },

  async write(enabled: boolean, paths: SettingsPaths = {}): Promise<AutoContinueSetting> {
    const userPath = paths.userPath ?? userSettingsPath();
    const [user, managed] = await Promise.all([
      loadSettingsFile(userPath),
      loadSettingsFile(paths.managedPath ?? managedSettingsPath()),
    ]);
    const current = resolveSetting(user, managed);
    if (current.locked) {
      throw new AppError('Managed Claude settings control this option.', {
        code: 'CLAUDE_SETTINGS_LOCKED',
        statusCode: 409,
      });
    }
    if (user.status === 'invalid') {
      throw new AppError('The Claude settings file is invalid, so it was left unchanged.', {
        code: 'CLAUDE_SETTINGS_INVALID',
        statusCode: 409,
      });
    }

    const text = `${JSON.stringify({ ...user.settings, [SETTING_KEY]: enabled }, null, 2)}\n`;
    const output = user.isUtf16
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      : Buffer.from(text, 'utf8');

    // Write a sibling temp file and rename it over the original, so a failed
    // write never leaves the user's whole settings file truncated.
    await mkdir(path.dirname(userPath), { recursive: true });
    const tempPath = `${userPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, output);
      await rename(tempPath, userPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return resolveSetting({ ...user, status: 'ok', settings: { ...user.settings, [SETTING_KEY]: enabled } }, managed);
  },
};
