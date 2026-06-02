/**
 * Idle reaping and the join-code throttle, driven by an injected clock so time
 * is deterministic (no real sleeps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { R2C } from '@spinal/collab-protocol';
import { SessionStore } from './sessionStore.js';
import type { Client } from './session.js';

function fakeClient(id: string, sink?: R2C[]): Client {
  return {
    id,
    author: { id, displayName: id, role: 'guest' },
    alive: true,
    send: (e) => sink?.push(e),
  };
}

test('reapIdle drops a session that has been empty past the TTL', () => {
  let clock = 0;
  const store = new SessionStore(() => clock);
  const s = store.create(); // lastActiveAt = 0, no clients

  clock = 5_000;
  assert.deepEqual(store.reapIdle(10_000), [], 'not yet past TTL');
  assert.ok(store.get(s.id), 'still present');

  clock = 11_000;
  assert.deepEqual(store.reapIdle(10_000), [s.id], 'reaped past TTL');
  assert.equal(store.get(s.id), undefined, 'gone');
});

test('reapIdle keeps a session that still has a connected client', () => {
  let clock = 0;
  const store = new SessionStore(() => clock);
  const s = store.create();
  s.addClient(fakeClient('guest-1')); // bumps lastActiveAt, clientCount = 1

  clock = 100_000;
  assert.deepEqual(store.reapIdle(10_000), [], 'live client ⇒ never reaped');
  assert.ok(store.get(s.id));

  // Once the client leaves, the idle clock starts from departure.
  s.removeClient('guest-1'); // lastActiveAt = 100_000
  clock = 105_000;
  assert.deepEqual(store.reapIdle(10_000), [], 'not yet 10s since departure');
  clock = 111_000;
  assert.deepEqual(store.reapIdle(10_000), [s.id], 'reaped 11s after departure');
});

test('join throttle locks after too many bad codes, then self-clears', () => {
  let clock = 0;
  const store = new SessionStore(() => clock);
  const s = store.create();

  for (let i = 0; i < 7; i++) s.recordBadJoin();
  assert.equal(s.joinLocked(), false, '7 failures: still open');
  s.recordBadJoin(); // 8th trips the lock
  assert.equal(s.joinLocked(), true, 'locked after threshold');

  clock = 14_000;
  assert.equal(s.joinLocked(), true, 'still locked inside the window');
  clock = 16_000;
  assert.equal(s.joinLocked(), false, 'lock self-clears after the window');
});

test('the durable log is ring-buffered and signals a replay gap', () => {
  const store = new SessionStore(() => 0);
  const s = store.create();
  // Overflow the event cap (5_000) so the oldest events are evicted.
  for (let i = 0; i < 6_000; i++) {
    s.broadcast({
      t: 'transcript.user_message',
      author: { id: 'g', displayName: 'g', role: 'guest' },
      content: `m${i}`,
      ts: 0,
    });
  }
  const sink: R2C[] = [];
  s.replayTo(fakeClient('late', sink), 0); // a fresh joiner wants the whole history

  assert.ok(
    sink.some((e) => e.t === 'error' && e.code === 'replay_gap'),
    'a replay gap is signaled when history was evicted',
  );
  const replayed = sink.filter((e) => e.t === 'transcript.user_message');
  assert.ok(replayed.length <= 5_000, `log is capped, not unbounded (got ${replayed.length})`);
  // Only the tail survives — the earliest message is gone, the latest is present.
  assert.ok(!replayed.some((e) => e.t === 'transcript.user_message' && e.content === 'm0'));
  assert.ok(replayed.some((e) => e.t === 'transcript.user_message' && e.content === 'm5999'));
});

test('a good join clears the failure window', () => {
  const store = new SessionStore(() => 0);
  const s = store.create();
  for (let i = 0; i < 7; i++) s.recordBadJoin();
  s.recordGoodJoin();
  for (let i = 0; i < 7; i++) s.recordBadJoin(); // 7 again, not 14
  assert.equal(s.joinLocked(), false, 'counter reset by the good join');
});
