# Auto-resume a Claude session after a usage limit

Tracked as CCU-1 (Vikunja, project `claudecodeui`). Branch: `feat/auto-resume-after-usage-limit`, cut from `v1.37.5`.

## Intent

The native Claude CLI can continue a session by itself once a usage limit resets (`autoContinueAtUsageLimit`). This UI cannot: when a limit is hit, the run ends and the session sits there until someone comes back and types "continue". The user wants the UI to do it for them.

The wait and the resume belong to the **server**. Nothing may depend on a browser tab being open when the limit resets.

## Goals

- When a Claude run is stopped by a usage limit, and the user has auto-continue on, the server sends the plain message `continue` to that same session shortly after the limit resets.
- The pending resume survives a server restart; one that came due while the server was down is sent after it comes back.
- The server checks that the resume actually worked. If the run hits a limit again, it handles that. It never retries a session indefinitely.
- The setting is the existing Claude setting, so the CLI and this UI agree. A toggle in the composer reads and writes it.
- The user can see that a resume is waiting, when it will fire, and cancel it.

## Non-goals

- No other providers (Codex, Cursor, OpenCode). Claude only.
- No custom resume text. It is always `continue`.
- No change to the existing scheduled-messages feature or its UI behaviour.
- No attempt to raise or work around the limit itself.
- Not a general retry system for other errors (network, overloaded, etc.).

## Anti-goals

- A resume loop: the server hammering a session that keeps failing, or burning the user's next window on repeats.
- A resume the user cannot see or stop.
- Silently doing nothing when the resume fails: the user must be able to tell it gave up and why.
- Sending "continue" to a session the user has since moved on in (see "Interaction with the user" below).

## What already exists (verified by reading the code)

- `server/modules/scheduled-messages/` stores messages in the `scheduled_messages` table (`pending | sent | failed | cancelled`), polls every 30 s, and sends via `runDetachedChatTurn` (`server/modules/websocket`) with no browser. Overdue messages are sent on the first poll after a restart. A due message uses `interruptActiveRun: true`.
- A second path sends a queued message when the session becomes idle (`dispatchQueuedMessages`), and treats a session with background work as busy.
- `server/modules/providers/services/claude-settings-permissions.service.ts` already resolves the user settings path (`CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`), decodes it the way the CLI does (BOM/UTF-16LE, 2 MB cap), and reports `ok | missing | invalid`. The managed-settings path is also resolved there.
- The Claude runtime (`server/modules/providers/list/claude/claude-runtime.provider.js`) consumes the Agent SDK message stream; the `result` message ends a turn.
- The Agent SDK (`@anthropic-ai/claude-agent-sdk` ^0.3.165) emits `rate_limit_event` messages with `rate_limit_info`: `status` (`allowed | allowed_warning | rejected`), `resetsAt` (epoch), `rateLimitType` (`five_hour`, `seven_day`, ...), `overageStatus`, and so on. Assistant messages can also carry `error: 'rate_limit'`.
- The frontend only reformats the old text `Claude AI usage limit reached|<ts>` for display (`src/modules/chat/utils/chatFormatting.ts`). Nothing server-side detects a limit hit today.
- The composer footer is `src/modules/chat/composer/ChatComposer.tsx`. The clock button is `ScheduleMessagePopover`, first item in the right-hand group of `PromptInputFooter`.

## The setting

- Key: `autoContinueAtUsageLimit` (boolean) in the user's Claude settings file, `~/.claude/settings.json` (honouring `CLAUDE_CONFIG_DIR`). The user's file already has it set to `true`.
- This is documented only by third-party sources (the CLI's `/config` shows it as "Continue automatically at usage limit"); it is not in the SDK type definitions. Treat it as an external contract that could change.
- Per those sources the CLI reads it only from user settings, `--settings` and managed settings, not from project-level settings. This feature does the same: **user settings only** (a managed-settings value, if present, is read-only to the UI; see builder's calls).
- Absent or non-boolean means off.
- The server reads the file when a limit is hit, not once at startup, so a change made in the CLI or another tab takes effect without a restart.
- The toggle writes the key back with a read-modify-write that keeps every other key and the file's existing encoding, and fails visibly if the file is `invalid` rather than overwriting it.

## Behaviour

### Detecting the limit
The Claude runtime watches for a `rate_limit_event` whose `status` is `rejected` together with the run ending because of it (the final `result`/assistant `error: 'rate_limit'`). It takes `resetsAt` from the event. If `resetsAt` is missing, it falls back to parsing the legacy text form; if neither gives a time, no resume is scheduled and the session is marked as stopped by the limit with an unknown reset.

An `allowed_warning` is not a limit hit and does nothing.

### Scheduling
If auto-continue is on, the server records a pending auto-resume for that session: reset time plus a small slack (a few seconds, so it does not fire before the limit has actually lifted). It is stored in the database, tied to the user and session, and distinguishable from a user-scheduled message (a user's own scheduled messages are never touched, counted or cancelled by this feature). One pending auto-resume per session; a new limit hit replaces it.

### Sending and checking
At the due time the server sends `continue` to the session through the same detached-turn path scheduled messages use. It then watches the resulting run and classifies the attempt:

- **Resumed:** the run started and produced assistant output without a new `rejected` limit event. The auto-resume is done, and the attempt counter for the session resets once that turn completes normally.
- **Limit again:** the run ends on a new usage limit. The server reads the new `resetsAt` and schedules another auto-resume. This counts as another attempt.
- **Did not start / no response:** the run could not be started (session deleted, provider unavailable) or nothing happened within a bounded time after the send. This counts as a failed attempt.

### Failsafe
- At most **3 consecutive attempts** per session. The counter resets after a turn completes normally (and also when the user sends their own message that completes normally).
- After the cap, or when a run cannot be started at all, the server stops, marks the auto-resume `failed` with a plain-language reason, and does not schedule anything further. It does not retry on a later poll.
- A hard ceiling on how far ahead it will wait (a reset time unreasonably far away, for example beyond the longest real window, is treated as failed rather than scheduled).
- The poll must never start two attempts for the same session at once.

### Interaction with the user
- If the user sends their own message to the session before the due time, the pending auto-resume is cancelled (they have already moved on).
- If the user disables the toggle, any pending auto-resume is cancelled.
- If a run is somehow active when the resume is due, the resume waits for it rather than interrupting it (unlike a user-scheduled message). The builder decides the details of "busy" using the existing `isSessionBusy` logic.

## UI

- A toggle button immediately **to the left of the clock (scheduled messages) button**, in the composer footer below the text input. It shows on/off state and has a tooltip. It reflects and writes `autoContinueAtUsageLimit`.
- While an auto-resume is pending for the current session, the control shows that it is waiting and when it will fire (local time), and clicking offers to cancel it.
- When an auto-resume has failed, the session shows that, with the reason, in the same place the existing scheduled-message failures appear.
- Follow the existing frontend conventions (`$frontend-module-standards`) and i18n.

## Constraints

- Backend work follows `$backend-module-standards`: a TypeScript module under `server/modules/<feature>/` with an `index.ts` barrel, thin routes, shared types in `server/shared/`, tests in `tests/`, no deep imports across modules.
- Frontend work follows `$frontend-module-standards`.
- Reuse the scheduled-messages machinery where it fits; do not fork a second timer or a second sender.
- Server tests and the client build must pass. (Known on this branch's base: `npm run typecheck` already fails on one unrelated test file, and `npm test` needs Node 22 for its glob; the pod has Node 20.)

## Decisions the user made

- The server does the waiting; no browser dependence.
- The resume message is plain `continue`.
- Reuse the existing Claude setting `autoContinueAtUsageLimit`.
- Add a UI toggle, left of the clock button.
- The server verifies the session resumed, handles a repeat limit, and has a failsafe against endless retries.

## Builder's calls (assistant's guesses, to confirm or change)

- Cap of 3 consecutive attempts.
- A few seconds of slack after `resetsAt`.
- A bounded "no response" wait of about two minutes.
- A new limit hit replaces any pending auto-resume for the session.
- A user message before the due time cancels the pending resume.
- Managed settings that set the key are shown as locked in the UI, not overridden.
- Reuse the `scheduled_messages` table with a marker for auto-resumes rather than a new table, unless that complicates the user-facing list.

## Resolved after builder review (assistant's calls unless noted)

- **What counts as a limit stop.** Schedule only when the run actually ends because of the limit: a `rejected` `rate_limit_event` followed by the run ending with a rate-limit error. A `rejected` event while the run carries on (for example overage is allowed, or the event's `overageStatus` shows the user can proceed) does nothing. A `rejected` event with no matching run end is ignored.
- **Reset time units.** The SDK's `resetsAt` is epoch time; normalise it the way `formatUsageLimitText` does (a value below 1e12 is seconds, otherwise milliseconds). The legacy text timestamp gets the same normalisation. This fallback is best-effort and only reachable if the SDK path yields no `resetsAt`.
- **Ceiling.** Do not schedule further ahead than 7 days plus one hour. Anything later is marked `failed` ("reset time too far away").
- **Cancelling and the counter.** Any message the user sends to the session before the due time cancels the pending resume, from any tab, and so does a user-scheduled message that fires before it. The counter resets after any turn in that session completes normally. A user turn that itself ends on a limit is treated as a new limit hit (replaces the pending resume, and the counter restarts from one).
- **Busy at due time.** If the session is busy (use `isSessionBusy`, which includes background work), wait and re-check on each poll. The wait does not count as an attempt and does not start the no-response timer. Give up after 1 hour of waiting and mark the resume `failed` ("session stayed busy").
- **Observing the outcome.** The shared sender may be extended additively (for example to return or report the run outcome) as long as existing scheduled-message behaviour and tests are unchanged.
- **Where it shows.** Auto-resumes are hidden from the existing scheduled-messages list and its counts. Pending state is shown on the toggle; a failure is shown as a notice next to the toggle for that session. One pending auto-resume per session is enforced in the database (a partial unique index) as well as in code.
- **Settings edge cases.** Effective value: if managed settings set `autoContinueAtUsageLimit`, that value wins (as in the CLI); otherwise the user value; otherwise off. When managed settings set it, the toggle is shown locked. Toggling with a `missing` user file creates it containing only that key. An `invalid` user file makes the toggle show an error and write nothing.
- **Scope of the setting.** It is one machine-wide key, so it applies to every user and session on this server; this tool is single-user in practice. Switching it off cancels all pending auto-resumes on the server.

## Left to the builder

- Exact table/column changes and migration.
- API shape for reading/writing the setting and for cancelling a pending resume.
- How the run result is observed (hooks into the runtime vs. the chat run registry).
- Component structure and copy for the toggle and pending state.
- Test layout.
