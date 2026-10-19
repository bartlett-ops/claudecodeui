import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

// Type of the auto-resume lifecycle; used by the Auto-resume module to drive its state machine.
export type AutoResumeRowStatus = 'pending' | 'sending' | 'done' | 'failed' | 'cancelled';

// Row shape of auto_resumes; used by the Auto-resume module to read persisted resumes.
export type AutoResumeRow = {
  id: string;
  user_id: number;
  session_id: string;
  resume_at: string;
  status: AutoResumeRowStatus;
  attempts: number;
  options: string;
  failure_reason: string | null;
  busy_since: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, user_id, session_id, resume_at, status, attempts, options, failure_reason, busy_since, created_at, updated_at';

// Used by the Auto-resume module to persist, claim, and resolve resumes of usage-limited sessions.
export const autoResumesDb = {
  /**
   * Replaces the session's live resume. The old pending/sending row is
   * cancelled first, in the same transaction, because the partial unique index
   * allows only one live row per session. A failure reason records a resume
   * that could not be scheduled, as an already-failed row.
   */
  replaceActive(input: {
    userId: number;
    sessionId: string;
    resumeAt: Date;
    attempts: number;
    options: unknown;
    failureReason?: string;
  }): AutoResumeRow {
    const db = getConnection();
    const id = randomUUID();

    return db.transaction(() => {
      db.prepare(
        `UPDATE auto_resumes SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND status IN ('pending', 'sending')`
      ).run(input.sessionId);

      db.prepare(
        `INSERT INTO auto_resumes (id, user_id, session_id, resume_at, status, attempts, options, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.userId,
        input.sessionId,
        input.resumeAt.toISOString(),
        input.failureReason === undefined ? 'pending' : 'failed',
        input.attempts,
        JSON.stringify(input.options ?? {}),
        input.failureReason === undefined ? null : input.failureReason.slice(0, 500),
      );

      return db.prepare(`SELECT ${COLUMNS} FROM auto_resumes WHERE id = ?`).get(id) as AutoResumeRow;
    })();
  },

  getActiveForSession(sessionId: string): AutoResumeRow | undefined {
    return getConnection()
      .prepare(`SELECT ${COLUMNS} FROM auto_resumes WHERE session_id = ? AND status IN ('pending', 'sending')`)
      .get(sessionId) as AutoResumeRow | undefined;
  },

  getLatestForSession(sessionId: string): AutoResumeRow | undefined {
    // rowid breaks ties between rows created within the same second.
    return getConnection()
      .prepare(`SELECT ${COLUMNS} FROM auto_resumes WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(sessionId) as AutoResumeRow | undefined;
  },

  listDue(now: Date): AutoResumeRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM auto_resumes
         WHERE status = 'pending' AND resume_at <= ?
         ORDER BY resume_at ASC`
      )
      .all(now.toISOString()) as AutoResumeRow[];
  },

  /** Moves pending to sending; true only for the caller that won the race. */
  claim(id: string): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE auto_resumes SET status = 'sending', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`
      )
      .run(id);

    return result.changes > 0;
  },

  /** Records when the session was first found busy; later calls keep the first time. */
  touchBusy(id: string, now: Date): void {
    getConnection()
      .prepare(
        `UPDATE auto_resumes SET busy_since = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND busy_since IS NULL`
      )
      .run(now.toISOString(), id);
  },

  markDone(id: string): void {
    getConnection()
      .prepare(`UPDATE auto_resumes SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(id);
  },

  markFailed(id: string, reason: string): void {
    getConnection()
      .prepare(
        `UPDATE auto_resumes SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(reason.slice(0, 500), id);
  },

  cancelPendingForSession(sessionId: string): number {
    return getConnection()
      .prepare(
        `UPDATE auto_resumes SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND status = 'pending'`
      )
      .run(sessionId).changes;
  },

  /** Cancels every pending row; sending rows are mid-run and stay untouched. */
  cancelAllPending(): number {
    return getConnection()
      .prepare(`UPDATE auto_resumes SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending'`)
      .run().changes;
  },

  /** Dismisses a failed row so its banner goes away. */
  dismissFailedForSession(sessionId: string): number {
    return getConnection()
      .prepare(
        `UPDATE auto_resumes SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND status = 'failed'`
      )
      .run(sessionId).changes;
  },

  /** Startup recovery: a row left sending by a previous process can never finish. */
  failAllSending(reason: string): number {
    return getConnection()
      .prepare(
        `UPDATE auto_resumes SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE status = 'sending'`
      )
      .run(reason.slice(0, 500)).changes;
  },
};
