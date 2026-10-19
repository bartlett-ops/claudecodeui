import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createCompleteMessage, readObjectRecord } from '@/shared/utils.js';

type ChatSessionWriterOptions = {
  connection: RealtimeClientConnection | null;
  userId: string | number | null;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /**
   * Invoked the moment the provider runtime reveals its native session id
   * (either via `setSessionId` or a `session_created` event). The registry
   * persists the app-id-to-provider-id mapping from this callback.
   */
  onProviderSessionId: (providerSessionId: string) => void;
  /**
   * Remaps/sequences/buffers one outbound live event. Implemented by the chat
   * run registry; the writer never forwards a provider event untouched.
   * Returns `null` when the event must be dropped (duplicate terminal
   * `complete` after an abort already completed the run).
   */
  decorateOutboundEvent: (message: NormalizedMessage) => NormalizedMessage | null;
};

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket writer.
 *
 * It exposes the exact same surface as `WebSocketWriter` (`send`,
 * `setSessionId`, `getSessionId`, `updateWebSocket`, `userId`,
 * `isWebSocketWriter`) so the provider runtime adapters need zero changes —
 * but everything that flows through
 * it is translated from the provider's world into the app's protocol:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well.
 */
export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Some runtimes feature-detect their writer with this flag; keep it so the
   * gateway writer is a drop-in replacement for `WebSocketWriter`.
   */
  isWebSocketWriter = true;

  private readonly options: ChatSessionWriterOptions;
  /**
   * Every socket currently watching this run, not just the one that started
   * it. A session can legitimately be open in more than one place — a second
   * browser tab, a phone alongside a laptop, the desktop app beside the web
   * app — and each of those subscribes through `attachConnection`.
   *
   * Holding a single connection here meant the newest subscriber took the
   * stream away from everyone before it, so a second tab silently froze
   * mid-run and only caught up on the next REST history refresh.
   */
  private readonly connections = new Set<RealtimeClientConnection>();
  /**
   * The provider-native session id as the runtime knows it. Kept locally
   * (besides the registry) because runtimes read it back via `getSessionId()`
   * to label their own outgoing events — those labels are remapped on send
   * anyway, but the runtime-visible value must stay provider-native.
   */
  private providerSessionId: string | null;
  /** Set by the registry's dispatcher; receives the reset time of a confirmed usage-limit stop. */
  private usageLimitReporter: ((resetsAtMs: number | null) => void) | null = null;
  /**
   * Content of the last `error` message the runtime emitted. Runtimes report a
   * failed turn this way and still resolve normally, so it is the only sign
   * the turn failed.
   */
  private emittedError: string | null = null;

  constructor(options: ChatSessionWriterOptions) {
    this.options = options;
    // A run started by a timer has no audience yet. Everything still goes
    // through `decorateOutboundEvent` into the run's replay buffer, so a
    // client that subscribes mid-run catches up from the beginning.
    if (options.connection) {
      this.connections.add(options.connection);
    }
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
  }

  send(data: unknown): void {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') {
      // Provider runtimes only emit kind-based normalized messages. Anything
      // else indicates a programming error; drop it rather than leaking an
      // un-remapped payload to the client.
      console.error('[ChatSessionWriter] Dropping non-normalized outbound payload', data);
      return;
    }

    const message = record as NormalizedMessage;

    if (message.kind === 'session_created') {
      const announcedId =
        typeof message.newSessionId === 'string' && message.newSessionId
          ? message.newSessionId
          : message.sessionId;
      if (announcedId) {
        this.captureProviderSessionId(announcedId);
      }
      // Swallowed on purpose: the frontend already has the stable app session
      // id, so there is no client-side handoff to perform anymore.
      return;
    }

    if (message.kind === 'error') {
      this.emittedError = typeof message.content === 'string' && message.content
        ? message.content
        : 'The run reported an error.';
    }

    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Consumer: the auto-resume module (via the run registry's run), to record a
   * resumed turn that failed even though its runtime resolved. Returns the
   * content of the last `error` message sent through this writer, or null.
   */
  getEmittedError(): string | null {
    return this.emittedError;
  }

  /**
   * Emits the synthetic terminal `complete` for runs that ended without one
   * (runtime crash before completing, or user abort).
   */
  sendComplete(opts: { exitCode: number; aborted?: boolean }): void {
    const message = createCompleteMessage({
      provider: this.options.provider,
      sessionId: this.providerSessionId,
      exitCode: opts.exitCode,
      aborted: opts.aborted,
    });
    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Adds a socket to the run's live audience. Named for the `WebSocketWriter`
   * method it stands in for, so runtime adapters keep working unchanged —
   * but it adds rather than replaces.
   */
  updateWebSocket(newConnection: RealtimeClientConnection): void {
    this.connections.add(newConnection);
  }

  setSessionId(sessionId: string): void {
    this.captureProviderSessionId(sessionId);
  }

  /** Consumer: chat-websocket.service (dispatchRun wires the run's usage-limit report). */
  setUsageLimitReporter(reporter: ((resetsAtMs: number | null) => void) | null): void {
    this.usageLimitReporter = reporter;
  }

  /**
   * Called by a provider runtime when the run stopped on a usage limit. A
   * no-op without a reporter; a throwing reporter is logged and swallowed so
   * it can never break the run.
   */
  reportUsageLimit(resetsAtMs: number | null): void {
    try {
      this.usageLimitReporter?.(resetsAtMs);
    } catch (error) {
      console.error('[ChatSessionWriter] Usage-limit reporter failed', error);
    }
  }

  getSessionId(): string | null {
    return this.providerSessionId;
  }

  private captureProviderSessionId(providerSessionId: string): void {
    if (!providerSessionId || this.providerSessionId === providerSessionId) {
      return;
    }

    this.providerSessionId = providerSessionId;
    this.options.onProviderSessionId(providerSessionId);
  }

  private forward(message: NormalizedMessage): void {
    const payload = JSON.stringify(message);

    // Sending is also when dead sockets get collected: a refreshed tab leaves
    // its old connection behind, and without dropping it here the set would
    // grow for the whole life of the run. Deleting during iteration is safe
    // for a Set — the removed entry is simply not revisited.
    for (const connection of this.connections) {
      if (connection.readyState === WS_OPEN_STATE) {
        connection.send(payload);
      } else {
        this.connections.delete(connection);
      }
    }
  }
}
