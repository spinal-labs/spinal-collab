/**
 * WebSocket client shared by host and guest. Handles: connect, hello,
 * seq-tracking for replay, reconnect-with-backoff, and app-level ping.
 *
 * On reconnect it re-sends `hello` with `resumeFromSeq = lastSeenSeq`, so the
 * relay replays only the durable events this client missed — no duplicate
 * transcript, no stale token flicker (deltas aren't in the replay log).
 */
import WebSocket from 'ws';
import { parseR2C, PROTOCOL_VERSION, type C2R, type R2C, type Role } from '@claude-collab/protocol';

export interface RelayClientOptions {
  url: string; // ws(s):// URL with the session id only — credentials go in headers
  role: Role;
  displayName: string;
  /** Credentials for the upgrade (host token / join code). Never in the URL. */
  headers?: Record<string, string>;
  /** Process-stable token so identity survives reconnects (see hello in protocol). */
  clientId?: string;
  onEvent: (event: R2C) => void;
  onStatus?: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  /** ms between app-level pings. */
  pingIntervalMs?: number;
}

/**
 * Refuse to carry credentials over plaintext to a non-local relay. ws:// is fine
 * for localhost dev; anything else needs wss:// (TLS) or an explicit opt-out for
 * a trusted private network. Call this BEFORE minting/connecting.
 */
export function assertSecureTransport(wsBase: string): void {
  const { protocol, hostname } = new URL(wsBase);
  const isLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost');
  if (protocol === 'wss:' || isLocal || process.env.COLLAB_ALLOW_INSECURE === '1') return;
  throw new Error(
    `refusing to send credentials over insecure ws:// to '${hostname}'. ` +
      `Use a wss:// relay, or set COLLAB_ALLOW_INSECURE=1 to override on a trusted network.`,
  );
}

export class RelayClient {
  private ws?: WebSocket;
  private lastSeenSeq = 0;
  private closedByUser = false;
  /** Set when the relay sends a fatal error (e.g. version mismatch): stop reconnecting. */
  private gaveUp = false;
  private reconnectAttempts = 0;
  private pingTimer?: NodeJS.Timeout;
  private hasConnectedOnce = false;

  constructor(private readonly opts: RelayClientOptions) {}

  connect(): void {
    this.opts.onStatus?.(this.hasConnectedOnce ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.opts.url, { headers: this.opts.headers });
    this.ws = ws;

    ws.on('open', () => {
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;
      this.opts.onStatus?.('open');
      this.send({
        t: 'hello',
        role: this.opts.role,
        displayName: this.opts.displayName,
        clientId: this.opts.clientId,
        resumeFromSeq: this.lastSeenSeq,
        protocolVersion: PROTOCOL_VERSION,
      });
      this.startPing();
    });

    ws.on('message', (data) => {
      let event: R2C;
      try {
        event = parseR2C(JSON.parse(data.toString()));
      } catch {
        return; // ignore frames we can't validate
      }
      if ('seq' in event && typeof event.seq === 'number') {
        // Track the high-water mark for replay-on-reconnect. delta carries a seq
        // too, which is fine — we just won't be re-sent deltas on replay.
        if (event.seq > this.lastSeenSeq) this.lastSeenSeq = event.seq;
      }
      // A fatal error (e.g. version mismatch) is terminal — don't reconnect into
      // the same rejection over and over.
      if (event.t === 'error' && event.fatal) this.gaveUp = true;
      this.opts.onEvent(event);
    });

    ws.on('close', () => {
      this.stopPing();
      if (this.closedByUser || this.gaveUp) {
        this.opts.onStatus?.('closed');
        return;
      }
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' fires after 'error'; let the close handler drive reconnect.
    });
  }

  send(msg: C2R): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    this.opts.onStatus?.('reconnecting');
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.closedByUser && !this.gaveUp) this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.opts.pingIntervalMs ?? 20_000;
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), interval);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
