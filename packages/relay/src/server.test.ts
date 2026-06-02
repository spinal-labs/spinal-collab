/**
 * Integration test: relay + a synthetic host + a guest, over real WebSockets.
 *
 * This covers the entire collab data path EXCEPT the Agent-SDK loop itself (the
 * synthetic host stands in for it by sending host_events directly). It verifies:
 *   - session minting + credential checks (bad code / bad token rejected);
 *   - sequencing + attribution of user messages;
 *   - host_event fan-out to guests;
 *   - the permission boundary (a guest cannot forge a host_event);
 *   - late-join replay (durable history replays; deltas do not).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {
  parseR2C,
  HEADER_HOST_TOKEN,
  HEADER_JOIN_CODE,
  PROTOCOL_VERSION,
  type C2R,
  type R2C,
} from '@claude-collab/protocol';
import { startTestServer } from './testHarness.js';

interface Conn {
  ws: WebSocket;
  events: R2C[];
  send(msg: C2R): void;
  waitFor(pred: (e: R2C) => boolean, ms?: number): Promise<R2C>;
  close(): void;
}

function connect(url: string, headers?: Record<string, string>): Promise<Conn> {
  const ws = new WebSocket(url, { headers });
  const events: R2C[] = [];
  const waiters: Array<{ pred: (e: R2C) => boolean; resolve: (e: R2C) => void }> = [];
  ws.on('message', (data) => {
    const ev = parseR2C(JSON.parse(data.toString()));
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(ev)) {
        waiters[i]!.resolve(ev);
        waiters.splice(i, 1);
      }
    }
  });
  const conn: Conn = {
    ws,
    events,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: (pred, ms = 1000) =>
      new Promise<R2C>((resolve, reject) => {
        const existing = events.find(pred);
        if (existing) return resolve(existing);
        const t = setTimeout(() => reject(new Error('waitFor timed out')), ms);
        waiters.push({ pred: (e) => pred(e), resolve: (e) => { clearTimeout(t); resolve(e); } });
      }),
    close: () => ws.close(),
  };
  return once(ws, 'open').then(() => conn);
}

test('full host↔relay↔guest path: sequencing, attribution, fan-out, permission boundary, replay', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const hostUrl = `${wsBase}/host?session=${creds.sessionId}`;
    const guestUrl = `${wsBase}/guest?session=${creds.sessionId}`;
    const hostHeaders = { [HEADER_HOST_TOKEN]: creds.hostToken };
    const guestHeaders = { [HEADER_JOIN_CODE]: creds.joinCode };

    // Bad join code is rejected at upgrade (non-101 → ws errors/closes, never opens).
    const badGuest = new WebSocket(guestUrl, { headers: { [HEADER_JOIN_CODE]: 'WRONG1' } });
    const badOpened = await Promise.race([
      once(badGuest, 'open').then(() => true),
      once(badGuest, 'error').then(() => false),
      once(badGuest, 'unexpected-response').then(() => false),
    ]).catch(() => false);
    assert.equal(badOpened, false, 'bad join code must not open a socket');
    badGuest.terminate();

    // Host connects with the right token.
    const host = await connect(hostUrl, hostHeaders);
    host.send({ t: 'hello', role: 'host', displayName: 'Alice', protocolVersion: PROTOCOL_VERSION });
    const hostWelcome = await host.waitFor((e) => e.t === 'welcome');
    assert.equal(hostWelcome.t === 'welcome' && hostWelcome.you.role, 'host');

    // Guest connects with the right code.
    const guest = await connect(guestUrl, guestHeaders);
    guest.send({ t: 'hello', role: 'guest', displayName: 'Bob', protocolVersion: PROTOCOL_VERSION });
    await guest.waitFor((e) => e.t === 'welcome');

    // Guest sends a prompt → relay broadcasts attributed transcript to both.
    guest.send({ t: 'user_message', clientMsgId: 'm1', content: 'list files' });
    const onHost = await host.waitFor(
      (e) => e.t === 'transcript.user_message' && e.content === 'list files',
    );
    assert.ok(onHost.t === 'transcript.user_message');
    assert.equal(onHost.author.displayName, 'Bob');
    assert.equal(onHost.author.role, 'guest');
    const seq1 = onHost.seq;

    // Synthetic host (standing in for the SDK loop) produces assistant output.
    host.send({ t: 'host_event', body: { t: 'assistant.delta', turnId: 't1', text: 'Here ' } });
    host.send({ t: 'host_event', body: { t: 'assistant.delta', turnId: 't1', text: 'you go.' } });
    host.send({
      t: 'host_event',
      body: { t: 'assistant.message', turnId: 't1', blocks: [{ type: 'text', text: 'Here you go.' }] },
    });
    const guestMsg = await guest.waitFor((e) => e.t === 'assistant.message');
    assert.ok(guestMsg.t === 'assistant.message' && guestMsg.seq > seq1);

    // Permission boundary: a guest CANNOT forge a host_event.
    guest.send({ t: 'host_event', body: { t: 'assistant.message', turnId: 'x', blocks: [{ type: 'text', text: 'forged' }] } });
    const guestErr = await guest.waitFor((e) => e.t === 'error');
    assert.ok(guestErr.t === 'error' && guestErr.code === 'forbidden');

    // Late-join replay: a second guest gets durable history but NOT the deltas.
    const late = await connect(guestUrl, guestHeaders);
    late.send({
      t: 'hello',
      role: 'guest',
      displayName: 'Carol',
      resumeFromSeq: 0,
      protocolVersion: PROTOCOL_VERSION,
    });
    await late.waitFor((e) => e.t === 'welcome');
    await delay(50); // let replay flush
    const replayed = late.events;
    assert.ok(
      replayed.some((e) => e.t === 'transcript.user_message' && e.content === 'list files'),
      'history transcript replayed',
    );
    assert.ok(
      replayed.some((e) => e.t === 'assistant.message'),
      'finalized assistant message replayed',
    );
    assert.ok(
      !replayed.some((e) => e.t === 'assistant.delta'),
      'token deltas are NOT replayed',
    );

    // Replayed events must carry the explicit replay flag (no seq inference).
    const replayedTranscript = late.events.find(
      (e) => e.t === 'transcript.user_message' && e.content === 'list files',
    );
    assert.ok(
      replayedTranscript && 'replay' in replayedTranscript && replayedTranscript.replay === true,
      'replayed events are flagged replay:true',
    );

    host.close();
    guest.close();
    late.close();
  } finally {
    await stop();
  }
});

test('a guest keeps a stable id across reconnects when it supplies a clientId', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const url = `${wsBase}/guest?session=${creds.sessionId}`;
    const headers = { [HEADER_JOIN_CODE]: creds.joinCode };

    const g1 = await connect(url, headers);
    g1.send({ t: 'hello', role: 'guest', displayName: 'Bob', clientId: 'cid-bob', protocolVersion: PROTOCOL_VERSION });
    const w1 = await g1.waitFor((e) => e.t === 'welcome');
    const firstId = w1.t === 'welcome' ? w1.you.id : '';
    g1.close();
    await delay(20);

    const g2 = await connect(url, headers);
    g2.send({ t: 'hello', role: 'guest', displayName: 'Bob', clientId: 'cid-bob', protocolVersion: PROTOCOL_VERSION });
    const w2 = await g2.waitFor((e) => e.t === 'welcome');
    const secondId = w2.t === 'welcome' ? w2.you.id : '';

    assert.equal(secondId, firstId, 'same clientId → same author id');
    g2.close();
  } finally {
    await stop();
  }
});

test('/end broadcasts session.state: ended to guests', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const host = await connect(`${wsBase}/host?session=${creds.sessionId}`, {
      [HEADER_HOST_TOKEN]: creds.hostToken,
    });
    host.send({ t: 'hello', role: 'host', displayName: 'Alice', protocolVersion: PROTOCOL_VERSION });
    await host.waitFor((e) => e.t === 'welcome');

    const guest = await connect(`${wsBase}/guest?session=${creds.sessionId}`, {
      [HEADER_JOIN_CODE]: creds.joinCode,
    });
    guest.send({ t: 'hello', role: 'guest', displayName: 'Bob', protocolVersion: PROTOCOL_VERSION });
    await guest.waitFor((e) => e.t === 'welcome');

    host.send({ t: 'end_session' });
    const ended = await guest.waitFor((e) => e.t === 'session.state' && e.state === 'ended');
    assert.ok(ended.t === 'session.state' && ended.state === 'ended');

    host.close();
    guest.close();

    // `ended` is terminal: the host token no longer reopens the session.
    const rejoin = new WebSocket(`${wsBase}/host?session=${creds.sessionId}`, {
      headers: { [HEADER_HOST_TOKEN]: creds.hostToken },
    });
    const reopened = await Promise.race([
      once(rejoin, 'open').then(() => true),
      once(rejoin, 'error').then(() => false),
      once(rejoin, 'unexpected-response').then(() => false),
    ]).catch(() => false);
    assert.equal(reopened, false, 'an ended session must not reopen');
    rejoin.terminate();
  } finally {
    await stop();
  }
});

test('a client with a mismatched protocol version is rejected with a fatal error', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const guest = await connect(`${wsBase}/guest?session=${creds.sessionId}`, {
      [HEADER_JOIN_CODE]: creds.joinCode,
    });
    guest.send({ t: 'hello', role: 'guest', displayName: 'Bob', protocolVersion: 999 });
    const err = await guest.waitFor((e) => e.t === 'error');
    assert.ok(err.t === 'error' && err.code === 'version_mismatch' && err.fatal === true);
    guest.close();
  } finally {
    await stop();
  }
});

test('read-only policy: host can lock guests to observe-only', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const host = await connect(`${wsBase}/host?session=${creds.sessionId}`, {
      [HEADER_HOST_TOKEN]: creds.hostToken,
    });
    host.send({ t: 'hello', role: 'host', displayName: 'Alice', protocolVersion: PROTOCOL_VERSION });
    await host.waitFor((e) => e.t === 'welcome');
    const guest = await connect(`${wsBase}/guest?session=${creds.sessionId}`, {
      [HEADER_JOIN_CODE]: creds.joinCode,
    });
    guest.send({ t: 'hello', role: 'guest', displayName: 'Bob', protocolVersion: PROTOCOL_VERSION });
    const welcome = await guest.waitFor((e) => e.t === 'welcome');
    assert.ok(welcome.t === 'welcome' && welcome.guestsReadOnly === false, 'open by default');

    // Host enables read-only; the policy change is broadcast.
    host.send({ t: 'set_policy', guestsReadOnly: true });
    await guest.waitFor((e) => e.t === 'session.policy' && e.guestsReadOnly === true);

    // A guest prompt is now soft-rejected.
    guest.send({ t: 'user_message', clientMsgId: 'r1', content: 'can I drive?' });
    const err = await guest.waitFor((e) => e.t === 'error' && e.code === 'read_only');
    assert.ok(err.t === 'error' && err.fatal === false);

    // And a guest cannot set policy itself.
    guest.send({ t: 'set_policy', guestsReadOnly: false });
    const forbidden = await guest.waitFor((e) => e.t === 'error' && e.code === 'forbidden');
    assert.ok(forbidden.t === 'error');

    host.close();
    guest.close();
  } finally {
    await stop();
  }
});

test('a prompt arriving mid-turn is marked queued', async () => {
  const { port, mint, stop } = await startTestServer();
  try {
    const creds = await mint();
    const wsBase = `ws://localhost:${port}`;
    const host = await connect(`${wsBase}/host?session=${creds.sessionId}`, {
      [HEADER_HOST_TOKEN]: creds.hostToken,
    });
    host.send({ t: 'hello', role: 'host', displayName: 'Alice', protocolVersion: PROTOCOL_VERSION });
    await host.waitFor((e) => e.t === 'welcome');
    const guest = await connect(`${wsBase}/guest?session=${creds.sessionId}`, {
      [HEADER_JOIN_CODE]: creds.joinCode,
    });
    guest.send({ t: 'hello', role: 'guest', displayName: 'Bob', protocolVersion: PROTOCOL_VERSION });
    await guest.waitFor((e) => e.t === 'welcome');

    // Host begins a turn (no turn.result yet) → turn is active.
    host.send({ t: 'host_event', body: { t: 'assistant.delta', turnId: 't1', text: 'thinking…' } });
    await guest.waitFor((e) => e.t === 'assistant.delta');

    // A prompt now should be flagged queued.
    guest.send({ t: 'user_message', clientMsgId: 'q1', content: 'and the tests?' });
    const queued = await guest.waitFor(
      (e) => e.t === 'transcript.user_message' && e.content === 'and the tests?',
    );
    assert.ok(queued.t === 'transcript.user_message' && queued.queued === true);

    // After the turn ends, a later prompt is NOT queued.
    host.send({ t: 'host_event', body: { t: 'turn.result', turnId: 't1', subtype: 'success' } });
    await delay(20);
    guest.send({ t: 'user_message', clientMsgId: 'q2', content: 'next question' });
    const live = await guest.waitFor(
      (e) => e.t === 'transcript.user_message' && e.content === 'next question',
    );
    assert.ok(live.t === 'transcript.user_message' && !live.queued);

    host.close();
    guest.close();
  } finally {
    await stop();
  }
});
