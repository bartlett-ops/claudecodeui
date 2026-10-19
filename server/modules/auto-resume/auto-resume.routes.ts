import express from 'express';
import type { Request, Response } from 'express';

import { claudeSettingsAutoContinueService } from '@/modules/providers/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import {
  cancelAllPendingAutoResumes,
  dismissAutoResume,
  getAutoResumeStatus,
} from './services/auto-resume.service.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string, code = 'INVALID_REQUEST_BODY'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, { code, statusCode: 400 });
  }
  return value;
}

const router = express.Router();

router.get(
  '/status',
  asyncHandler(async (req: Request, res: Response) => {
    readUserId(req);
    const sessionId = readString(req.query.sessionId, 'sessionId', 'INVALID_REQUEST');
    const setting = await claudeSettingsAutoContinueService.read();
    res.json(createApiSuccessResponse({ setting, ...getAutoResumeStatus(sessionId) }));
  }),
);

router.put(
  '/setting',
  asyncHandler(async (req: Request, res: Response) => {
    readUserId(req);
    const enabled = ((req.body ?? {}) as Record<string, unknown>).enabled;
    if (typeof enabled !== 'boolean') {
      throw new AppError('enabled must be a boolean.', {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }
    const setting = await claudeSettingsAutoContinueService.write(enabled);
    if (!enabled) {
      cancelAllPendingAutoResumes();
    }
    res.json(createApiSuccessResponse(setting));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    readUserId(req);
    dismissAutoResume(readString(req.params.sessionId, 'sessionId', 'INVALID_REQUEST'));
    res.json(createApiSuccessResponse({ dismissed: true }));
  }),
);

export default router;
