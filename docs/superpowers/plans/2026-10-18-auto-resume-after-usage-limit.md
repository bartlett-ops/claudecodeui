# Auto-resume after a usage limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude run is stopped by a usage limit and `autoContinueAtUsageLimit` is on, the server sends `continue` to the same session after the limit resets, verifies it resumed, and gives up after 3 consecutive attempts.

**Architecture:** The Claude runtime detects a confirmed limit stop and reports it through the run's writer to a handler on `chatRunRegistry`. A new `server/modules/auto-resume` module stores a pending resume in a new `auto_resumes` table, and sends it from the existing scheduled-messages poll through `runDetachedChatTurn`. A composer toggle left of the clock button reads/writes the Claude settings key through that module's routes.

**Tech Stack:** TypeScript (server, Node test runner via `tsx --test`), better-sqlite3, Express, React + Vitest (client), lucide-react, i18next.

**Spec:** `docs/superpowers/specs/2026-10-18-auto-resume-after-usage-limit-design.md` (ticket CCU-1, branch `feat/auto-resume-after-usage-limit`).

## Global Constraints

- Backend follows `$backend-module-standards` (`.agents/skills/backend-module-standards/SKILL.md`): TypeScript only under `server/modules/`; feature module has an `index.ts` barrel; cross-module imports only through barrels; thin routes; a type/utility used in 2+ places lives in `server/shared/types.ts` / `server/shared/utils.ts` with a doc comment; no module-local `types.ts`/`utils.ts`; every exported component gets a comment naming its consumers; tests in `<module>/tests/`.
- Frontend follows `$frontend-module-standards` (`.agents/skills/frontend-module-standards/SKILL.md`).
- Setting key: `autoContinueAtUsageLimit` (boolean) in `~/.claude/settings.json` (honouring `CLAUDE_CONFIG_DIR`). Effective value: managed settings if they set it, else user settings, else off.
- Resume text is exactly `continue`. Claude provider only.
- Constants: attempt cap `3` consecutive; slack after `resetsAt` `5_000` ms; max wait ahead `7 days + 1 hour`; busy give-up `1 hour`; no-response window `120_000` ms.
- `resetsAt` normalisation: value below `1e12` is seconds, otherwise milliseconds.
- Do not change existing scheduled-messages behaviour or tests. Do not start a second timer: the auto-resume pass runs inside the existing 30 s poll.
- Test commands (Node 20 on this pod does not expand the `npm test` glob): `npx tsx --tsconfig server/tsconfig.json --test <file>`; client: `npx vitest run <file>`.
- Known baseline failure: `npm run typecheck` already fails on `src/modules/sidebar/tests/recentConversationTitleSync.test.ts(50,67)`. That is the only error allowed in typecheck output.

## Review Focus

- A `rejected` rate-limit event while overage is allowed (or the run carries on) must not schedule anything (Task 1).
- `resetsAt` in seconds vs milliseconds, and a missing `resetsAt` (Tasks 1, 5).
- A settings file that is UTF-16LE/BOM, invalid JSON, or missing: write keeps every other key and encoding, refuses to touch an invalid file (Task 3).
- Server restarted while an attempt was in flight: the stuck `sending` row must not hang forever or be retried blindly (Task 5).
- User sends a message (or a scheduled message fires) before the due time: pending resume is cancelled; the auto-resume's own send must not cancel itself (Tasks 2, 5).
- Toggling off cancels every pending resume on the server (Task 6).

---

### Task 1: Usage-limit tracker

**Files:**
- Create: `server/modules/providers/list/claude/claude-usage-limit.ts`
- Test: `server/modules/providers/tests/claude-usage-limit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UsageLimitHit = { resetsAtMs: number | null };
  export function createUsageLimitTracker(): { observe(message: unknown): UsageLimitHit | null };
  ```
  (Consumer: `claude-runtime.provider.js`, Task 2. Comment it at the definition.)

Rules for `observe` (one tracker per run; returns a hit at most once):
- `{ type: 'rate_limit_event', rate_limit_info }` with `status === 'rejected'` and neither `overageStatus === 'allowed'` nor `isUsingOverage === true`: remember `resetsAt` (normalised to ms; `null` if absent/non-finite). Returns `null`.
- A later `{ type: 'assistant', error: 'rate_limit' }`, or an `assistant` whose text matches `/usage limit reached\|(\d{10,13})/i` (legacy form, timestamp normalised), or a `{ type: 'result', is_error: true }` while a rejected event is remembered: confirms the stop and returns `{ resetsAtMs }` (remembered value, else the legacy timestamp, else `null`).
- An `allowed_warning` event, a `rejected` event never followed by a stop, and anything else: `null`.

- [ ] **Step 1: Write the failing tests** in `claude-usage-limit.test.ts` (names and key assertions):
  - `a rejected event alone schedules nothing` → `observe(rejected(1_800_000_000)) === null`.
  - `rejected then rate_limit assistant error returns the reset in ms` → seconds input `1_800_000_000` gives `{ resetsAtMs: 1_800_000_000_000 }`; ms input `1_800_000_000_000` is unchanged.
  - `rejected then an errored result confirms` → `{ resetsAtMs: ... }`.
  - `overage allowed or in use is ignored` → rejected with `overageStatus: 'allowed'` then `result` with `is_error: true` returns `null`; same with `isUsingOverage: true`.
  - `missing resetsAt yields a hit with null` → `{ resetsAtMs: null }`.
  - `legacy text form yields the embedded timestamp` → assistant text `Claude AI usage limit reached|1800000000` → `{ resetsAtMs: 1_800_000_000_000 }`.
  - `a hit is reported once per tracker` → second confirming message returns `null`.
  - `allowed_warning never confirms` → `null`.
- [ ] **Step 2: Run to verify failure:** `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-usage-limit.test.ts` → fails (module missing).
- [ ] **Step 3: Implement** `createUsageLimitTracker` in `claude-usage-limit.ts` (normalisation helper stays private in this file; it has one consumer).
- [ ] **Step 4: Run to verify pass** (same command) → all pass.
- [ ] **Step 5: Commit:** `git add server/modules/providers && git commit -m "feat(sessions): detect a confirmed Claude usage-limit stop (CCU-1)"`.

---

### Task 2: Report the hit from the run, and observe user runs

**Files:**
- Modify: `server/shared/types.ts` (add `ChatUsageLimitHit`)
- Modify: `server/modules/websocket/services/chat-session-writer.service.ts` (reporter hook)
- Modify: `server/modules/websocket/services/chat-run-registry.service.ts` (handlers)
- Modify: `server/modules/websocket/services/chat-websocket.service.ts` (`dispatchRun`, `runDetachedChatTurn`)
- Modify: `server/modules/providers/list/claude/claude-runtime.provider.js` (use the tracker, ~line 1198 loop)
- Test: `server/modules/websocket/tests/chat-usage-limit.test.ts`, extend `server/modules/providers/tests/claude-runtime-hold.test.ts`-style new file `claude-usage-limit-runtime.test.ts`

**Interfaces:**
- Consumes: `createUsageLimitTracker` (Task 1).
- Produces:
  ```ts
  // server/shared/types.ts — doc: a confirmed usage-limit stop of one run; consumers WebSocket (producer) and Auto-resume.
  export type ChatUsageLimitHit = {
    sessionId: string;                       // app session id
    userId: string | number | null;
    resetsAtMs: number | null;
    options: Record<string, unknown>;        // { model?, effort?, permissionMode? } of the stopped run, strings only
  };
  // ChatSessionWriter
  setUsageLimitReporter(reporter: ((resetsAtMs: number | null) => void) | null): void;
  reportUsageLimit(resetsAtMs: number | null): void;   // no-op without a reporter
  // chatRunRegistry
  setUsageLimitHandler(handler: (hit: ChatUsageLimitHit) => void): void;
  setUserRunObserver(observer: (sessionId: string) => void): void;
  // runDetachedChatTurn input gains:
  origin?: 'user' | 'auto-resume';          // default 'user'
  ```

- [ ] **Step 1: Write failing tests.** `chat-usage-limit.test.ts`, following `chat-run-registry.test.ts` for setup:
  - `a writer's reported limit reaches the registry handler with session, user and picked options` → start a run via `chatRunRegistry.startRun`, call `run.writer.reportUsageLimit(123)`; handler receives `resetsAtMs: 123` and the session id. (If the reporter is wired in `dispatchRun`, drive it with `runDetachedChatTurn` and a fake runtime whose `run` calls `writer.reportUsageLimit(123)`; assert `options` contains only string `model`/`effort`/`permissionMode` from the send.)
  - `a user turn notifies the user-run observer, an auto-resume turn does not` → two `runDetachedChatTurn` calls with `origin` omitted / `'auto-resume'`; observer called once with the session id.
  - `claude-usage-limit-runtime.test.ts`, using the `context.createQuery` seam from `claude-runtime-hold.test.ts`: scripted stream `rate_limit_event(rejected, resetsAt)` → `assistant{error:'rate_limit'}` calls `writer.reportUsageLimit` once with the normalised ms; a stream with overage allowed does not.
- [ ] **Step 2: Run to verify failure** (each file) → fails.
- [ ] **Step 3: Implement.** Writer: store reporter; `reportUsageLimit` invokes it inside try/catch (a throwing handler must never break the run). Registry: module-level handlers, exported `chatRunRegistry.notifyUsageLimit(hit)` and `notifyUserRun(sessionId)` used by `dispatchRun`. `dispatchRun` gains a trailing `origin: 'user' | 'auto-resume' = 'user'` parameter: after `startRun` succeeds it calls `notifyUserRun` when `origin === 'user'` and sets the writer's reporter to build a `ChatUsageLimitHit` (picking string `model`/`effort`/`permissionMode` from `clientOptions`). `runDetachedChatTurn` forwards `input.origin`. Runtime: create one tracker per query run next to the other per-run state (~line 982) and, inside the `for await` loop after the normalised messages are sent, call `ws.reportUsageLimit?.(hit.resetsAtMs)` when `observe(message)` returns a hit.
- [ ] **Step 4: Run to verify pass**, plus `server/modules/websocket/tests/*.test.ts` and `claude-runtime-hold.test.ts` to confirm nothing regressed.
- [ ] **Step 5: Commit:** `feat(sessions): report a usage-limit stop from the run (CCU-1)`.

---

### Task 3: Claude settings auto-continue service

**Files:**
- Modify: `server/modules/providers/services/claude-settings-permissions.service.ts` (export `userSettingsPath`, `managedSettingsPath`, `decodeSettingsFile`, `MAX_SETTINGS_FILE_BYTES`; add a consumer comment to each; update the doc comment that says CloudCLI never writes these files)
- Create: `server/modules/providers/services/claude-settings-auto-continue.service.ts`
- Modify: `server/modules/providers/index.ts` (export the service and its type)
- Test: `server/modules/providers/tests/claude-settings-auto-continue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AutoContinueSetting = {
    enabled: boolean;                          // effective value
    source: 'managed' | 'user' | 'default';
    locked: boolean;                           // true when managed settings set the key
    userFileStatus: 'ok' | 'missing' | 'invalid';
  };
  export const claudeSettingsAutoContinueService: {
    read(paths?: { userPath?: string; managedPath?: string }): Promise<AutoContinueSetting>;
    write(enabled: boolean, paths?: { userPath?: string; managedPath?: string }): Promise<AutoContinueSetting>;
  };
  ```
  `write` throws `AppError` code `CLAUDE_SETTINGS_LOCKED` (409) when managed settings set the key, `CLAUDE_SETTINGS_INVALID` (409) when the user file is `invalid`.

- [ ] **Step 1: Write failing tests** (temp dir, pass `paths`): `defaults to off when no file sets it`; `user value is used when managed is silent`; `managed value wins over user and reports locked`; `a non-boolean value counts as unset`; `write creates a missing file containing only the key`; `write keeps every other key`; `write preserves a UTF-16LE BOM file's encoding`; `write refuses an invalid file and leaves it byte-identical`; `write refuses when locked`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `read`/`write` in the new service, reusing the exported path/decode helpers and the status logic of `readPermissionSource`. Write = read-modify-write, `JSON.stringify(obj, null, 2) + '\n'`, re-encode as UTF-16LE with BOM if the original was, create the directory if missing.
- [ ] **Step 4: Run to verify pass**, plus the existing `claude-settings-permissions.test.ts`.
- [ ] **Step 5: Commit:** `feat(sessions): read and write the Claude auto-continue setting (CCU-1)`.

---

### Task 4: `auto_resumes` table and repository

**Files:**
- Modify: `server/modules/database/schema.ts` (`AUTO_RESUMES_TABLE_SCHEMA_SQL`)
- Modify: `server/modules/database/migrations.ts` (exec it beside `SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL`, ~line 537, plus indexes below)
- Create: `server/modules/database/repositories/auto-resumes.db.ts`
- Modify: `server/modules/database/index.ts` (export `autoResumesDb`, `AutoResumeRow`, `AutoResumeRowStatus`)
- Test: `server/modules/database/tests/auto-resumes.db.test.ts` (copy the `withIsolatedDatabase` helper style)

**Interfaces:**
- Produces:
  ```ts
  export type AutoResumeRowStatus = 'pending' | 'sending' | 'done' | 'failed' | 'cancelled';
  export type AutoResumeRow = {
    id: string; user_id: number; session_id: string; resume_at: string; status: AutoResumeRowStatus;
    attempts: number; options: string; failure_reason: string | null; busy_since: string | null;
    created_at: string; updated_at: string;
  };
  export const autoResumesDb: {
    replaceActive(input: { userId: number; sessionId: string; resumeAt: Date; attempts: number;
      options: unknown; failureReason?: string }): AutoResumeRow;   // cancels any pending/sending row for the session first; inserts 'failed' when failureReason is given, else 'pending'
    getActiveForSession(sessionId: string): AutoResumeRow | undefined;      // pending|sending
    getLatestForSession(sessionId: string): AutoResumeRow | undefined;
    listDue(now: Date): AutoResumeRow[];                                    // pending, resume_at <= now
    claim(id: string): boolean;                                             // pending -> sending, true only for the winner
    touchBusy(id: string, now: Date): void;                                 // sets busy_since if null
    markDone(id: string): void;
    markFailed(id: string, reason: string): void;                           // reason sliced to 500
    cancelPendingForSession(sessionId: string): number;
    cancelAllPending(): number;
    dismissFailedForSession(sessionId: string): number;                     // failed -> cancelled
    failAllSending(reason: string): number;
  };
  ```
- Table: `session_id` FK to `sessions(session_id)` and `user_id` FK to `users(id)`, both `ON DELETE CASCADE`; `CREATE UNIQUE INDEX ... ON auto_resumes(session_id) WHERE status IN ('pending','sending')`; `CREATE INDEX ... ON auto_resumes(status, resume_at)`.

- [ ] **Step 1: Write failing tests:** `replaceActive cancels the previous active row`; `only one pending or sending row can exist per session` (a raw second insert violates the unique index); `claim succeeds once`; `listDue ignores future and non-pending rows`; `cancelAllPending leaves sending rows alone`; `failAllSending marks them failed with the reason`; `deleting the session removes its rows`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** schema, migration and repository following `scheduled-messages.db.ts` (UUID ids, ISO timestamps, `replaceActive` in one transaction).
- [ ] **Step 4: Run to verify pass**, plus `server/modules/database/tests/*.test.ts`.
- [ ] **Step 5: Commit:** `feat(sessions): add the auto_resumes table (CCU-1)`.

---

### Task 5: Auto-resume service and dispatch

**Files:**
- Create: `server/modules/auto-resume/index.ts`, `server/modules/auto-resume/services/auto-resume.service.ts`
- Modify: `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts` (call the auto-resume pass in the existing poll chain)
- Modify: `server/index.ts` (call `initializeAutoResume()` at startup, near `chatRunRegistry.setRetentionGuard` ~line 104)
- Test: `server/modules/auto-resume/tests/auto-resume.service.test.ts`

**Interfaces:**
- Consumes: `autoResumesDb` (Task 4), `claudeSettingsAutoContinueService` (Task 3, via the providers barrel), `ChatUsageLimitHit`, `chatRunRegistry`, `runDetachedChatTurn`, `ProviderRuntimeGateway` (websocket barrel).
- Produces (all exported through `auto-resume/index.ts`):
  ```ts
  export function recordUsageLimitHit(hit: ChatUsageLimitHit, now?: Date): Promise<AutoResumeRow | null>;
  export function dispatchDueAutoResumes(runtime: ProviderRuntimeGateway, now?: Date): Promise<number>;
  export function attemptResume(row: AutoResumeRow, runtime: ProviderRuntimeGateway): Promise<void>;  // exported for tests
  export function cancelPendingAutoResume(sessionId: string): number;
  export function cancelAllPendingAutoResumes(): number;
  export function getAutoResumeStatus(sessionId: string): { pending: { resumeAt: string; attempts: number } | null; failure: { reason: string } | null };
  export function initializeAutoResume(): void;   // failAllSending on startup; sets the registry's usage-limit handler (-> recordUsageLimitHit, errors logged) and user-run observer (-> cancelPendingAutoResume)
  ```

Behaviour of `recordUsageLimitHit`: return `null` when the effective setting is off, `userId` is not a number, or the session is unknown. Otherwise `resetsAtMs === null` → `replaceActive` failed row (`attempts: 0`, reason "The limit was hit but its reset time was not reported."). Else `attempts = active?.status === 'sending' ? active.attempts + 1 : 1`; `attempts > 3` → failed row ("Gave up after 3 attempts; the limit was hit again."); `resetsAtMs + 5_000 > now + 7d + 1h` → failed row ("The reset time is too far away."); otherwise a pending row at `resetsAtMs + 5_000` with the hit's `options`.

Behaviour of `dispatchDueAutoResumes`: for each `listDue(now)` row: if `chatRunRegistry.isProcessing(sid) || runtime.hasBackgroundWork(sid)` → `touchBusy`; if `busy_since` is more than 1 h before `now` → `markFailed("The session stayed busy.")`; skip. Else `claim(id)` and, for a winner, start `attemptResume` without awaiting it (errors logged). Returns the number started.

Behaviour of `attemptResume`: send `continue` via `runDetachedChatTurn({ sessionId, userId, content: 'continue', options: row options, origin: 'auto-resume' }, { runtime })` (no `interruptActiveRun`). Arm a 120 s timer; if it fires while `chatRunRegistry.getRun(sid)` is running with `lastSeq === 0`, abort via `runtime.abort(run.provider, sid)` and remember "no response". After the send settles: not started or error → `markFailed(reason)`; else re-read the row: still `sending` → `markFailed("No response after resuming.")` if no response, otherwise `markDone`; any other status (a new limit hit replaced it) → nothing.

- [ ] **Step 1: Write failing tests** (isolated DB, fake `ProviderRuntimeGateway` like the scheduled-messages tests; stub the settings service by pointing `CLAUDE_CONFIG_DIR` at a temp dir):
  - `a hit with the setting off records nothing`.
  - `a hit schedules a pending row at resetsAt plus 5 seconds`.
  - `a missing reset time records a failed row and sends nothing`.
  - `a reset more than 7 days and an hour away is recorded as failed`.
  - `a new hit replaces the pending row`.
  - `a hit during a sending attempt increments attempts; the fourth is recorded failed`.
  - `a due resume is sent as continue with origin auto-resume`.
  - `a due resume waits while the session is busy and fails after an hour busy`.
  - `a run that completes without a new hit marks the row done`.
  - `a run that reports a new hit leaves the replacement pending`.
  - `a run with no output for two minutes is aborted and marked failed` (fake timers via `mock.timers`).
  - `a run that cannot start marks the row failed with the reason`.
  - `cancelPendingAutoResume cancels pending but not sending rows`.
  - `initializeAutoResume fails rows left sending by a previous process`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the service and barrel; add `await`-free `void dispatchDueAutoResumes(runtime)` ordering to the poll in `scheduled-message-dispatcher.service.ts` as an extra `.then(() => dispatchDueAutoResumes(runtime))` after `dispatchQueuedMessages`; call `initializeAutoResume()` in `server/index.ts`. The one-line busy check duplicates the scheduled-messages helper on purpose (importing it would create a module cycle).
- [ ] **Step 4: Run to verify pass**, plus `server/modules/scheduled-messages/tests/scheduled-messages.test.ts` unchanged.
- [ ] **Step 5: Commit:** `feat(sessions): resume a session after its usage limit resets (CCU-1)`.

---

### Task 6: Routes

**Files:**
- Create: `server/modules/auto-resume/auto-resume.routes.ts`
- Modify: `server/modules/auto-resume/index.ts` (export `autoResumeRoutes`)
- Modify: `server/index.ts` (mount `app.use('/api/auto-resume', authenticateToken, autoResumeRoutes)` beside the scheduled-messages mount, ~line 199)
- Test: `server/modules/auto-resume/tests/auto-resume.routes.test.ts` (follow `providers/tests/provider.routes.test.ts`)

**Interfaces:**
- Consumes: Task 3 and Task 5 exports.
- Produces (responses wrapped with `createApiSuccessResponse`):
  - `GET /api/auto-resume/status?sessionId=<id>` → `{ setting: AutoContinueSetting, pending: {resumeAt, attempts} | null, failure: {reason} | null }`.
  - `PUT /api/auto-resume/setting` body `{ enabled: boolean }` → the new `AutoContinueSetting`. Turning it off also calls `cancelAllPendingAutoResumes()`. Non-boolean body → 400 `INVALID_REQUEST_BODY`.
  - `DELETE /api/auto-resume/sessions/:sessionId` → cancels the pending resume and dismisses a failed one.

- [ ] **Step 1: Write failing tests:** `status returns setting, pending and failure for a session`; `status requires sessionId` (400); `PUT setting rejects a non-boolean` (400); `PUT setting off cancels every pending resume`; `PUT setting surfaces the locked error as 409`; `DELETE cancels pending and dismisses failed`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** thin handlers (parse, call services, format), matching `scheduled-messages.routes.ts`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit:** `feat(sessions): auto-resume routes (CCU-1)`.

---

### Task 7: Composer toggle

**Files:**
- Modify: `src/shared/types.ts` (add `AutoResumeStatus`), `src/shared/api.ts` (add `autoResume` block under `scheduledMessages`)
- Create: `src/modules/chat/composer/useAutoResume.ts`, `src/modules/chat/composer/AutoResumeToggle.tsx`
- Modify: `src/modules/chat/composer/ChatComposer.tsx` (new props; render the toggle immediately before `<ScheduleMessagePopover>` ~line 486), `src/modules/chat/ChatInterface.tsx` (call the hook beside `useScheduledMessages`, ~line 375, pass props)
- Modify: `src/modules/i18n/locales/en/chat.json` (new `autoResume` block next to `schedule`); other locales fall back to `en` (`fallbackLng: 'en'`), no locale-parity test exists
- Test: `src/modules/chat/tests/useAutoResume.test.tsx`, `src/modules/chat/tests/AutoResumeToggle.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // src/shared/types.ts
  export type AutoResumeStatus = {
    setting: { enabled: boolean; source: 'managed' | 'user' | 'default'; locked: boolean; userFileStatus: 'ok' | 'missing' | 'invalid' };
    pending: { resumeAt: string; attempts: number } | null;
    failure: { reason: string } | null;
  };
  // src/shared/api.ts
  autoResume: { status(sessionId: string): Promise<Response>; setEnabled(enabled: boolean): Promise<Response>; cancel(sessionId: string): Promise<Response> }
  // useAutoResume.ts
  export function useAutoResume(sessionId: string | null): {
    status: AutoResumeStatus | null; setEnabled(enabled: boolean): Promise<boolean>; cancel(): Promise<void>; refresh(): Promise<void>;
  };
  // AutoResumeToggle.tsx
  export function AutoResumeToggle(props: { status: AutoResumeStatus | null; onSetEnabled(enabled: boolean): void; onCancel(): void }): JSX.Element | null;
  ```
- `useAutoResume` mirrors `useScheduledMessages` (clears on session switch during render; ignores a fetch that resolves for a previous session) and also refetches every 30 s while mounted.
- Toggle: same 8×8 bordered button styling as the clock button; lucide `RotateCw` icon. States: off (muted); on (primary colour); pending (primary plus a small dot, title "Resuming at {{time}}", click cancels via `onCancel`); failed (destructive colour, title shows the reason, click dismisses via `onCancel`); locked or `userFileStatus === 'invalid'` (disabled, title explains). Clicking in the on/off states calls `onSetEnabled(!enabled)`. Renders `null` when `status` is null.
- `en/chat.json` keys under `autoResume`: `trigger`, `on`, `off`, `pending` (`Resuming at {{time}}`), `failed` (`Auto-resume stopped — {{reason}}`), `locked`, `invalid`.

- [ ] **Step 1: Write failing tests:** hook — `loads status for the session`, `ignores a stale response after a session switch`, `setEnabled posts and refreshes`; toggle — `renders nothing without status`, `click on an off toggle calls onSetEnabled(true)`, `a pending state shows the time in its title and click calls onCancel`, `a failed state shows the reason`, `locked and invalid states are disabled`. Model them on `useScheduledMessagesSessionSwitch.test.tsx`.
- [ ] **Step 2: Run to verify failure:** `npx vitest run src/modules/chat/tests/useAutoResume.test.tsx src/modules/chat/tests/AutoResumeToggle.test.tsx`.
- [ ] **Step 3: Implement** types, API block, hook, component, composer wiring, and English strings.
- [ ] **Step 4: Run to verify pass**, then `npm run test:client`, `npm run build:client`, and `npm run lint` (warnings are fine, errors are not).
- [ ] **Step 5: Commit:** `feat(chat): add an auto-resume toggle beside the schedule button (CCU-1)`.

---

### Task 8: Verify and open the PR

**Files:** none new.

- [ ] **Step 1:** Run the full server suite: `find server \( -name '*.test.ts' -o -name '*.test.js' \) -not -path '*/node_modules/*' | xargs npx tsx --tsconfig server/tsconfig.json --test` → 0 failures.
- [ ] **Step 2:** `npm run build` (client and server) → succeeds; `npm run typecheck` → only the baseline error listed under Global Constraints; `npm run lint` → exit 0.
- [ ] **Step 3:** Manual check with `npm run dev`: turn the toggle on, then simulate a limit by driving a fake run through the registry in a scratch script (scratch file outside the repo), confirm a pending state shows with the right time and that cancelling clears it.
- [ ] **Step 4:** Push the branch and open a PR with `gh pr create` (never push to `main`); body references CCU-1 and the spec. Comment the PR link on CCU-1 in Vikunja. Leave CCU-1 open until the PR is merged and verified.
