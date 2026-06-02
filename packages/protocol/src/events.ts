/**
 * The wire contract between host, guests, and the relay.
 *
 * Roles & data flow (decided):
 *   - The HOST runs the single Claude Agent-SDK loop. It is the sole PRODUCER of
 *     assistant-side events (deltas, messages, tool use/results, permission
 *     requests, turn results). It sends them UP to the relay inside a
 *     `host_event` envelope; the relay (host-only) assigns a `seq`, logs, and
 *     fans them out to everyone.
 *   - Any client (host or guest) sends `user_message` UP. The relay sequences it
 *     and broadcasts `transcript.user_message` DOWN to everyone — including the
 *     host, which pushes it into the SDK in that globally-sequenced order. This
 *     single ordering point means no client-side dedupe and no host/guest race.
 *   - Presence/typing are ephemeral: broadcast live, never logged, never replayed.
 *
 * The relay is the single sequencer. Every durable event carries a monotonic
 * per-session `seq`. `assistant.delta` carries a seq for live ordering but is
 * EXCLUDED from the replay log (a late joiner gets the finalized
 * `assistant.message`, never a flood of stale tokens).
 *
 * Everything is JSON and zod-validated at the relay and on clients. Validation
 * is the trust boundary: clients claim a `displayName` but never an `id`/`role`
 * (relay-assigned), and only the host may emit `host_event`.
 */
import { z } from 'zod';

/**
 * Credential transport. The session id is an identifier (it lives in the share
 * link), but the host token and join code are SECRETS — they go in headers on
 * the WebSocket upgrade, never in the URL, so they can't leak via proxy/access
 * logs or `Referer`. Names are shared here so client and relay can't drift.
 */
export const HEADER_HOST_TOKEN = 'x-collab-token';
export const HEADER_JOIN_CODE = 'x-collab-code';

export const Role = z.enum(['host', 'guest']);
export type Role = z.infer<typeof Role>;

export const Author = z.object({
  id: z.string(),
  displayName: z.string(),
  role: Role,
});
export type Author = z.infer<typeof Author>;

/** A finalized assistant content block, normalized for rendering on guests. */
export const AssistantBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
]);
export type AssistantBlock = z.infer<typeof AssistantBlock>;

export const PermissionDecision = z.enum(['allow', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const SessionState = z.enum(['active', 'paused', 'ended']);
export type SessionState = z.infer<typeof SessionState>;

// ─────────────────────────────── Assistant-side event bodies (no seq, host-produced)
// Defined seq-free so they can be (a) wrapped in a host_event envelope going UP,
// and (b) re-used to build the seq-carrying R2C variants going DOWN.

const assistantDeltaBody = z.object({
  t: z.literal('assistant.delta'),
  turnId: z.string(),
  text: z.string(),
});
const assistantMessageBody = z.object({
  t: z.literal('assistant.message'),
  turnId: z.string(),
  blocks: z.array(AssistantBlock),
});
const toolUseBody = z.object({
  t: z.literal('tool.use'),
  turnId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBody = z.object({
  t: z.literal('tool.result'),
  turnId: z.string(),
  ok: z.boolean(),
  summary: z.string(), // human summary; raw tool output is never broadcast
});
const permissionRequestBody = z.object({
  t: z.literal('permission.request'),
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});
const permissionResolvedBody = z.object({
  t: z.literal('permission.resolved'),
  requestId: z.string(),
  decision: PermissionDecision,
  by: Author,
});
const turnResultBody = z.object({
  t: z.literal('turn.result'),
  turnId: z.string(),
  subtype: z.string(),
  costUsd: z.number().optional(),
  usage: z.unknown().optional(),
});

/** Everything the host is allowed to ask the relay to broadcast. */
export const HostEventBody = z.discriminatedUnion('t', [
  assistantDeltaBody,
  assistantMessageBody,
  toolUseBody,
  toolResultBody,
  permissionRequestBody,
  permissionResolvedBody,
  turnResultBody,
]);
export type HostEventBody = z.infer<typeof HostEventBody>;

// ───────────────────────────────────────────────────────────── Client → Relay

export const C2R = z.discriminatedUnion('t', [
  /**
   * First frame after connect. `resumeFromSeq` drives late-join replay.
   * `clientId` is a self-minted, process-stable token; the relay derives a
   * stable Author id from it so a guest keeps the same identity (and color)
   * across reconnects. It is NOT a credential — auth is the link + join code.
   */
  z.object({
    t: z.literal('hello'),
    role: Role,
    displayName: z.string().min(1).max(40),
    clientId: z.string().min(1).max(64).optional(),
    resumeFromSeq: z.number().int().nonnegative().optional(),
    /** Wire version the client speaks; the relay rejects a mismatch (see version.ts). */
    protocolVersion: z.number().int().optional(),
  }),
  /** A human prompt to inject into the shared thread. */
  z.object({
    t: z.literal('user_message'),
    clientMsgId: z.string().max(64),
    // Capped so a single prompt can't bloat the durable log; generous enough for
    // pasted code/logs. (The ws frame is separately bounded by maxPayload.)
    content: z.string().min(1).max(100_000),
  }),
  /** Ephemeral typing signal (whole-message boolean, debounced). */
  z.object({ t: z.literal('typing'), isTyping: z.boolean() }),
  /** Host-only: ask the relay to broadcast an assistant-side event. */
  z.object({ t: z.literal('host_event'), body: HostEventBody }),
  /** Host-only: end the session for everyone (→ session.state: ended). */
  z.object({ t: z.literal('end_session') }),
  /** Host-only: set whether guests may type prompts (vs observe only). */
  z.object({ t: z.literal('set_policy'), guestsReadOnly: z.boolean() }),
  /** App-level keepalive. */
  z.object({ t: z.literal('ping') }),
]);
export type C2R = z.infer<typeof C2R>;

// ───────────────────────────────────────────────────────────── Relay → Client

const seq = z.number().int();
/**
 * Fields stamped on every durable (sequenced) event. `replay: true` is set ONLY
 * on events the relay re-sends to a late joiner, so the client can render them
 * as dim history with no animation — it never has to infer "is this history?"
 * from seq arithmetic.
 */
const durableMeta = { seq, replay: z.boolean().optional() } as const;

export const R2C = z.discriminatedUnion('t', [
  /** Sent once on join. `you` is the relay-assigned identity. */
  z.object({
    t: z.literal('welcome'),
    sessionId: z.string(),
    you: Author,
    members: z.array(Author),
    lastSeq: z.number().int().nonnegative(),
    protocolVersion: z.number().int(),
    state: SessionState,
    /** True if guests are observe-only in this session (host policy). */
    guestsReadOnly: z.boolean(),
  }),
  /** Ephemeral roster update. */
  z.object({ t: z.literal('presence'), members: z.array(Author) }),
  /** Ephemeral typing broadcast. */
  z.object({ t: z.literal('typing'), author: Author, isTyping: z.boolean() }),

  /** A human prompt entered the thread (replayed to late joiners). */
  z.object({
    t: z.literal('transcript.user_message'),
    ...durableMeta,
    author: Author,
    content: z.string(),
    ts: z.number().int(),
    clientMsgId: z.string().optional(),
    /** True if it arrived mid-turn and is waiting its place in the queue. */
    queued: z.boolean().optional(),
  }),

  // Durable assistant-side variants = host bodies + seq + replay flag.
  assistantDeltaBody.extend(durableMeta), // NOT replayed (see module doc)
  assistantMessageBody.extend(durableMeta),
  toolUseBody.extend(durableMeta),
  toolResultBody.extend(durableMeta),
  permissionRequestBody.extend(durableMeta),
  permissionResolvedBody.extend(durableMeta),
  turnResultBody.extend(durableMeta),

  /** Lifecycle transitions. */
  z.object({ t: z.literal('session.state'), ...durableMeta, state: SessionState }),
  /** Guest write-policy change (durable so the timeline shows when it flipped). */
  z.object({ t: z.literal('session.policy'), ...durableMeta, guestsReadOnly: z.boolean() }),
  /** Transport/protocol error. fatal=true means the client should give up. */
  z.object({
    t: z.literal('error'),
    code: z.string(),
    message: z.string(),
    fatal: z.boolean(),
  }),
]);
export type R2C = z.infer<typeof R2C>;

/** R2C events the relay sequences. (Everything with a `seq` field.) */
export type DurableEvent = Extract<R2C, { seq: number }>;

/** Event `t` discriminators that carry a seq but must NOT be replayed. */
export const NON_REPLAYABLE: ReadonlySet<string> = new Set(['assistant.delta']);

// ───────────────────────────────────────────────────────────────── Helpers

export function parseC2R(raw: unknown): C2R {
  return C2R.parse(raw);
}

export function parseR2C(raw: unknown): R2C {
  return R2C.parse(raw);
}

/**
 * Sanitize a display name before it is prefixed into Claude's prompt content.
 * NOT a security boundary — just keeps attribution readable and prevents a name
 * from injecting `[`/control chars that would corrupt the `[name]: text` format.
 */
export function sanitizeDisplayName(name: string): string {
  return (
    name
      // C0 + DEL + C1 control chars (covers ESC \x1b, used for ANSI/OSC injection).
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .replace(/[[\]]/g, '')
      .trim()
      .slice(0, 40) || 'anon'
  );
}
