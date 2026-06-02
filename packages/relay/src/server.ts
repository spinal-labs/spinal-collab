/**
 * The cloud relay. It does NOT run Claude. It:
 *   - mints sessions (POST /sessions) with {sessionId, joinCode, hostToken};
 *   - upgrades WebSocket connections at /host and /guest, validating credentials;
 *   - per session, sequences durable events, broadcasts, and replays to joiners.
 *
 * Health: GET /health. Friendly landing: GET /claude-code/<id>/.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseC2R,
  sanitizeDisplayName,
  PROTOCOL_VERSION,
  HEADER_HOST_TOKEN,
  HEADER_JOIN_CODE,
  type Author,
  type R2C,
  type Role,
} from '@spinal/collab-protocol';
import { SessionStore } from './sessionStore.js';
import { type Client, type Session } from './session.js';
import { secureEquals } from './auth.js';

const store = new SessionStore();

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

export const relayHttpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  // Host mints a session before connecting. Returns the credentials it will
  // print as a share link + join code. hostToken stays secret to that process.
  if (req.method === 'POST' && url.pathname === '/sessions') {
    // Control-plane gate: when COLLAB_CONTROL_TOKEN is set (recommended for any
    // non-local deployment), minting requires `Authorization: Bearer <token>`,
    // so a reachable relay can't be turned into an open session factory. Unset
    // ⇒ open minting, fine for localhost/dev.
    const required = process.env.COLLAB_CONTROL_TOKEN;
    if (required) {
      const authz = req.headers['authorization'] ?? '';
      const presented = authz.startsWith('Bearer ') ? authz.slice(7) : '';
      if (!secureEquals(presented, required)) {
        return json(res, 401, { error: 'unauthorized' });
      }
    }
    const session = store.create();
    return json(res, 200, {
      sessionId: session.id,
      joinCode: session.joinCode,
      hostToken: session.hostToken,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  // Friendly landing for a shared link (the guest CLI parses the URL, but a
  // human clicking it gets a hint).
  const landing = url.pathname.match(/^\/claude-code\/([^/]+)\/?$/);
  if (req.method === 'GET' && landing) {
    const exists = !!store.get(landing[1]!);
    res.writeHead(exists ? 200 : 404, { 'content-type': 'text/plain' });
    return res.end(
      exists
        ? `collab session ${landing[1]}\n\nJoin from your terminal:\n  collab join "${url.href}"\n\nYou'll be asked for a display name and the 6-char join code.\n`
        : `No such collab session: ${landing[1]}\n`,
    );
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

// Bound a single frame. JSON control messages and prompts are small; 1 MiB is
// generous for a long assistant message while capping the ws default of 100 MiB,
// so a hostile client can't push huge frames at the relay. (Per-field caps —
// e.g. user_message content — are enforced by the zod schema.)
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

/** A ws connection tagged with the heartbeat liveness flag. */
type TrackedSocket = WebSocket & { isAlive?: boolean };

/**
 * Heartbeat. TCP won't surface a half-open connection (laptop sleeps, a proxy
 * drops the link), so a dead host would hold its slot forever and block a
 * legitimate reconnect. Each sweep terminates any socket that didn't answer the
 * previous ping, then pings the rest; the ws client library auto-replies with a
 * pong, which clears the flag. `terminate()` (not `close()`) reaps immediately.
 */
const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<TrackedSocket>) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

/** Outbound buffer a client may accumulate before we treat it as a dead/slow consumer. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Idle reaping. A crashed host (or a session whose host never connected) would
 * otherwise sit in memory forever. Once a session has been empty for longer than
 * SESSION_IDLE_MS, drop it. Sweeps run lazily; the heartbeat first reaps dead
 * sockets, which is what makes an abandoned session go empty.
 */
const SESSION_IDLE_MS = 10 * 60_000;
const reaper = setInterval(() => {
  store.reapIdle(SESSION_IDLE_MS);
}, 60_000);
reaper.unref?.();

/** First value of a (possibly array) header, as a string. */
function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/**
 * Validate the upgrade request and resolve which session/role it is for.
 * The session id is an identifier (query param); the credentials are SECRETS and
 * arrive in headers (never the URL, which leaks via logs/Referer).
 */
function authorizeUpgrade(
  url: URL,
  req: IncomingMessage,
): { session: Session; role: Role } | { error: string } {
  const path = url.pathname;
  const sessionId = url.searchParams.get('session') ?? '';
  const session = store.get(sessionId);
  if (!session) return { error: 'unknown session' };
  // `ended` is terminal — no one rejoins (the session is also deleted on /end,
  // so this mostly guards a race where state is set but deletion hasn't run).
  if (session.state === 'ended') return { error: 'session ended' };

  if (path === '/host') {
    const token = header(req, HEADER_HOST_TOKEN);
    if (!secureEquals(token, session.hostToken)) return { error: 'bad host token' };
    if (session.hasHost()) return { error: 'host already connected' };
    return { session, role: 'host' };
  }
  if (path === '/guest') {
    // Throttle brute force against the 6-char join code (the gate if the link
    // leaks): once too many bad codes hit this session, lock guest joins briefly.
    if (session.joinLocked()) return { error: 'too many attempts; try again shortly' };
    const code = header(req, HEADER_JOIN_CODE);
    if (!secureEquals(code.toUpperCase(), session.joinCode)) {
      session.recordBadJoin();
      return { error: 'bad join code' };
    }
    session.recordGoodJoin();
    return { session, role: 'guest' };
  }
  return { error: 'unknown path' };
}

relayHttpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const auth = authorizeUpgrade(url, req);
  if ('error' in auth) {
    // Politely reject before the WS handshake completes.
    socket.write(
      `HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${auth.error}\n`,
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleConnection(ws, auth.session, auth.role);
  });
});

function handleConnection(ws: WebSocket, session: Session, role: Role): void {
  let client: Client | undefined; // assigned once `hello` arrives
  let alive = true;

  // Heartbeat liveness: a pong (auto-sent by the ws client on our ping) keeps the
  // socket alive across the next sweep; silence reaps it. See HEARTBEAT_MS.
  const tracked = ws as TrackedSocket;
  tracked.isAlive = true;
  ws.on('pong', () => {
    tracked.isAlive = true;
  });

  const fail = (code: string, message: string, fatal = true) => {
    const ev: R2C = { t: 'error', code, message, fatal };
    try {
      ws.send(JSON.stringify(ev));
    } catch {
      /* socket may already be gone */
    }
    if (fatal) ws.close();
  };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = parseC2R(JSON.parse(data.toString()));
    } catch {
      return fail('bad_frame', 'malformed or invalid frame', false);
    }

    // The first frame MUST be hello; it establishes identity.
    if (!client) {
      if (msg.t !== 'hello') return fail('expected_hello', 'first frame must be hello');
      if (msg.role !== role) return fail('role_mismatch', 'role does not match endpoint');
      // Reject an incompatible client up front, so a stale relay/client pair fails
      // fast with a clear message instead of looping on malformed traffic.
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        return fail(
          'version_mismatch',
          `protocol ${msg.protocolVersion ?? 'unset'} ≠ relay ${PROTOCOL_VERSION}; update collab`,
        );
      }

      const author: Author = session.assignAuthor(
        role,
        sanitizeDisplayName(msg.displayName),
        msg.clientId,
      );
      client = {
        id: author.id,
        author,
        alive: true,
        send: (event) => {
          if (!alive) return;
          // Backpressure: if a slow consumer lets the outbound buffer grow past
          // the cap, drop it rather than let the relay buffer unbounded. It can
          // reconnect and replay from its last seq.
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.terminate();
            return;
          }
          try {
            ws.send(JSON.stringify(event));
          } catch {
            /* drop on dead socket */
          }
        },
      };
      session.addClient(client);

      client.send({
        t: 'welcome',
        sessionId: session.id,
        you: author,
        members: session.members(),
        lastSeq: session.lastSeq,
        protocolVersion: PROTOCOL_VERSION,
        state: session.state,
        guestsReadOnly: session.guestsReadOnly,
      });
      // Late-join replay: durable log after the client's last-seen seq.
      session.replayTo(client, msg.resumeFromSeq ?? 0);
      session.broadcastEphemeral({ t: 'presence', members: session.members() });

      // A host (re)connecting reactivates a PAUSED session — never an ended one
      // (ended is terminal; an ended session is rejected at upgrade anyway).
      if (role === 'host' && session.state === 'paused') session.setState('active');
      return;
    }

    handleClientMessage(session, client, msg, fail);
  });

  const cleanup = () => {
    alive = false;
    if (!client) return;
    session.removeClient(client.id);
    session.broadcastEphemeral({ t: 'presence', members: session.members() });
    // Host leaving pauses the session; guests' prompts are soft-rejected until
    // the host returns. (Host persists session_id and can resume.)
    if (client.author.role === 'host' && session.state === 'active') {
      session.setState('paused');
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function handleClientMessage(
  session: Session,
  client: Client,
  msg: ReturnType<typeof parseC2R>,
  fail: (code: string, message: string, fatal?: boolean) => void,
): void {
  switch (msg.t) {
    case 'hello':
      // Identity is already established; a second hello is a protocol error.
      return fail('unexpected_hello', 'already initialized', false);

    case 'ping':
      return; // liveness only; ws-level pong handled by the library

    case 'typing':
      return session.broadcastEphemeral({
        t: 'typing',
        author: client.author,
        isTyping: msg.isTyping,
      });

    case 'user_message': {
      // Guests' prompts are soft-rejected while the host is away.
      if (session.state !== 'active') {
        return fail('session_paused', 'host is away; message not delivered', false);
      }
      // Read-only policy: guests observe, only the host drives.
      if (client.author.role === 'guest' && session.guestsReadOnly) {
        return fail('read_only', 'guests are observe-only in this session', false);
      }
      session.broadcast({
        t: 'transcript.user_message',
        author: client.author,
        content: msg.content,
        ts: nowMs(),
        clientMsgId: msg.clientMsgId,
        // Arrived mid-turn → it will be answered after the current turn.
        queued: session.isTurnActive() || undefined,
      });
      return;
    }

    case 'set_policy': {
      if (client.author.role !== 'host') {
        return fail('forbidden', 'only the host may set session policy', false);
      }
      session.setGuestsReadOnly(msg.guestsReadOnly);
      return;
    }

    case 'end_session': {
      if (client.author.role !== 'host') {
        return fail('forbidden', 'only the host may end the session', false);
      }
      // Broadcast `ended` to everyone, then drop the session: its credentials
      // stop working and its memory (event log included) is freed. Connected
      // sockets stay up just long enough to deliver the state change.
      session.setState('ended');
      store.delete(session.id);
      return;
    }

    case 'host_event': {
      // Only the host may produce assistant-side events. This is the line that
      // keeps a guest from forging Claude output or self-approving a tool.
      if (client.author.role !== 'host') {
        return fail('forbidden', 'only the host may emit assistant events', false);
      }
      session.broadcast(msg.body);
      return;
    }
  }
}

/**
 * Timestamp source. `Date.now()` is fine in the relay (a long-lived server);
 * isolated here so it is the single clock reference.
 */
function nowMs(): number {
  return Date.now();
}

export function start(port: number, host = '0.0.0.0'): void {
  relayHttpServer.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    // eslint-disable-next-line no-console
    console.log(`relay listening on ws://${shown}:${port}`);
  });
}
