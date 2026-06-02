/**
 * A single shared session: the sequenced event log + connected clients.
 *
 * The relay is the single sequencer. Every durable event gets the next `seq`
 * here, is appended to `eventLog`, then broadcast. Late joiners replay the log
 * from their `resumeFromSeq`. `assistant.delta` is broadcast live but never
 * logged (a late joiner gets the finalized `assistant.message` instead).
 *
 * This class is transport-agnostic: it knows about `Client` send functions, not
 * about WebSockets directly, so it can be unit-tested without a socket.
 */
import { nanoid } from 'nanoid';
import {
  type Author,
  type R2C,
  type Role,
  type SessionState,
  NON_REPLAYABLE,
} from '@claude-collab/protocol';

export interface Client {
  id: string;
  author: Author;
  /** Serialize + send one event to this client. */
  send(event: R2C): void;
  /** True once the underlying socket is open and welcomed. */
  alive: boolean;
}

/** A durable event as stored: the R2C payload minus the `seq` we assign here. */
type DurablePayload = Extract<R2C, { seq: number }>;
/** Distributive omit — `Omit<Union, 'seq'>` would collapse to common keys only. */
type WithoutSeq<E> = E extends unknown ? Omit<E, 'seq'> : never;

/** Bad join codes tolerated before guest joins are briefly locked. */
const MAX_JOIN_FAILS = 8;
/** How long guest joins stay locked after the threshold (brute-force throttle). */
const JOIN_LOCK_MS = 15_000;
/** Durable replay-log caps — a long-lived session can't grow memory unbounded. */
const MAX_LOG_EVENTS = 5_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export class Session {
  readonly id: string;
  readonly joinCode: string;
  readonly hostToken: string;
  state: SessionState = 'active';
  /** When true, guests may observe but not inject prompts (host-set policy). */
  guestsReadOnly = false;
  /** Wall-clock of the last connect/disconnect/broadcast — drives idle reaping. */
  lastActiveAt: number;

  private seq = 0;
  private readonly eventLog: DurablePayload[] = [];
  /** Byte estimate per logged event, parallel to eventLog, for the byte cap. */
  private readonly logSizes: number[] = [];
  private logBytes = 0;
  /** Highest seq evicted from the log; replay below this is a gap. */
  private droppedThrough = 0;
  private readonly clients = new Map<string, Client>();
  private guestCounter = 0;
  /** Stable guest ids keyed by self-minted clientId, so reconnects keep identity. */
  private readonly guestIdByClient = new Map<string, string>();
  /** True between the first assistant-side event of a turn and its turn.result. */
  private turnActive = false;
  private readonly now: () => number;
  private joinFails = 0;
  private joinLockUntil = 0;

  constructor(args: { id: string; joinCode: string; hostToken: string; now?: () => number }) {
    this.id = args.id;
    this.joinCode = args.joinCode;
    this.hostToken = args.hostToken;
    this.now = args.now ?? (() => Date.now());
    this.lastActiveAt = this.now();
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Number of currently-connected clients (0 ⇒ a candidate for idle reaping). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** True while guest joins are locked after too many bad join codes. */
  joinLocked(): boolean {
    return this.now() < this.joinLockUntil;
  }

  /** Record a rejected join code; lock guest joins once the threshold is hit. */
  recordBadJoin(): void {
    if (++this.joinFails >= MAX_JOIN_FAILS) {
      this.joinLockUntil = this.now() + JOIN_LOCK_MS;
      this.joinFails = 0; // start a fresh window behind the lock
    }
  }

  /** A good join clears the failure window. */
  recordGoodJoin(): void {
    this.joinFails = 0;
    this.joinLockUntil = 0;
  }

  members(): Author[] {
    return [...this.clients.values()].map((c) => c.author);
  }

  /**
   * Assign a stable Author for a newly-connected client. Relay owns id+role.
   * If the client supplied a `clientId`, the same guest id is reused on
   * reconnect (so identity/color persist); otherwise a fresh one is minted.
   */
  assignAuthor(role: Role, displayName: string, clientId?: string): Author {
    if (role === 'host') return { id: 'host', displayName, role };
    let id: string;
    if (clientId) {
      id = this.guestIdByClient.get(clientId) ?? `guest-${++this.guestCounter}`;
      this.guestIdByClient.set(clientId, id);
    } else {
      id = `guest-${++this.guestCounter}-${nanoid(4)}`;
    }
    return { id, displayName, role };
  }

  /** Whether a Claude turn is currently in progress (drives the (queued) marker). */
  isTurnActive(): boolean {
    return this.turnActive;
  }

  addClient(client: Client): void {
    this.clients.set(client.id, client);
    this.lastActiveAt = this.now();
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    // Stamp departure so the idle clock starts when the session empties out.
    this.lastActiveAt = this.now();
  }

  hasHost(): boolean {
    return [...this.clients.values()].some((c) => c.author.role === 'host');
  }

  /**
   * Sequence + log + broadcast a durable event. Returns the assigned seq.
   * `assistant.delta` is broadcast but intentionally not appended to the log.
   */
  broadcast(payload: WithoutSeq<DurablePayload>): number {
    const seq = ++this.seq;
    this.lastActiveAt = this.now();
    const event = { ...payload, seq } as DurablePayload;
    // Track turn boundaries so the server can mark mid-turn prompts as queued.
    if (event.t === 'tool.use' || event.t === 'assistant.delta' || event.t === 'assistant.message') {
      this.turnActive = true;
    } else if (event.t === 'turn.result') {
      this.turnActive = false;
    }
    if (!NON_REPLAYABLE.has(event.t)) {
      this.eventLog.push(event);
      this.logSizes.push(estimateSize(event));
      this.logBytes += this.logSizes[this.logSizes.length - 1]!;
      this.evictOverflow();
    }
    for (const client of this.clients.values()) {
      if (client.alive) client.send(event);
    }
    return seq;
  }

  /** Ring-buffer the log: evict oldest events past the count or byte cap. */
  private evictOverflow(): void {
    while (this.eventLog.length > MAX_LOG_EVENTS || this.logBytes > MAX_LOG_BYTES) {
      const evicted = this.eventLog.shift();
      if (!evicted) break;
      this.logBytes -= this.logSizes.shift() ?? 0;
      this.droppedThrough = evicted.seq; // history below this is no longer replayable
    }
  }

  /** Send an ephemeral (un-sequenced, un-logged) event to everyone. */
  broadcastEphemeral(event: Extract<R2C, { t: 'presence' | 'typing' }>): void {
    for (const client of this.clients.values()) {
      if (client.alive) client.send(event);
    }
  }

  /** Send one event to a single client (e.g. welcome, targeted error). */
  sendTo(clientId: string, event: R2C): void {
    this.clients.get(clientId)?.send(event);
  }

  /**
   * Replay the durable log to a (re)joining client, only events newer than
   * `resumeFromSeq`. Caller has already sent `welcome`.
   */
  replayTo(client: Client, resumeFromSeq: number): void {
    // Replay-gap signal: if events the client missed were evicted by the cap,
    // tell it some history is gone rather than silently presenting a partial log.
    if (resumeFromSeq < this.droppedThrough) {
      client.send({
        t: 'error',
        code: 'replay_gap',
        message: 'some earlier history was dropped to bound memory',
        fatal: false,
      });
    }
    for (const event of this.eventLog) {
      // `replay: true` lets the client render history as dim, un-animated.
      if (event.seq > resumeFromSeq) client.send({ ...event, replay: true });
    }
  }

  setState(state: SessionState): number {
    this.state = state;
    return this.broadcast({ t: 'session.state', state });
  }

  /** Set the guest write policy and announce it on the durable timeline. */
  setGuestsReadOnly(readOnly: boolean): number {
    this.guestsReadOnly = readOnly;
    return this.broadcast({ t: 'session.policy', guestsReadOnly: readOnly });
  }
}

/** Rough byte size of an event for the log's byte cap (JSON length is close enough). */
function estimateSize(event: DurablePayload): number {
  return JSON.stringify(event).length;
}
