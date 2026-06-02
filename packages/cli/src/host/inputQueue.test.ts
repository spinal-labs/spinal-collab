import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncQueue } from './inputQueue.js';

test('yields buffered items in FIFO order', async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  assert.deepEqual(await q.next(), { value: 1, done: false });
  assert.deepEqual(await q.next(), { value: 2, done: false });
});

test('does NOT terminate while momentarily empty; resolves on a later push', async () => {
  // The core invariant: push 2, start iterating, push a 3rd after a delay.
  // All three must be yielded in order and the iterator must not end early.
  const q = new AsyncQueue<string>();
  q.push('a');
  q.push('b');

  const seen: string[] = [];
  const consumer = (async () => {
    for await (const item of q) {
      seen.push(item);
      if (seen.length === 3) q.close(); // stop after we get the delayed third
    }
  })();

  // At this point the consumer has drained 'a','b' and is parked on an empty,
  // still-open queue. If the queue wrongly returned `done`, the loop would have
  // already ended with only 2 items.
  await delay(25);
  assert.equal(seen.length, 2, 'consumer should still be parked, not finished');

  q.push('c');
  await consumer;
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('a consumer parked on empty is released by close() with done', async () => {
  const q = new AsyncQueue<number>();
  const pending = q.next(); // parks
  q.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test('drains remaining buffer before reporting done after close()', async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.close();
  assert.deepEqual(await q.next(), { value: 1, done: false });
  assert.deepEqual(await q.next(), { value: 2, done: false });
  assert.deepEqual(await q.next(), { value: undefined, done: true });
});

test('push after close() is ignored', async () => {
  const q = new AsyncQueue<number>();
  q.close();
  q.push(99);
  assert.deepEqual(await q.next(), { value: undefined, done: true });
});

test('interleaved push/pull preserves order across awaits', async () => {
  const q = new AsyncQueue<number>();
  const seen: number[] = [];
  const consumer = (async () => {
    for await (const n of q) {
      seen.push(n);
      if (n === 5) q.close();
    }
  })();

  for (let i = 1; i <= 5; i++) {
    q.push(i);
    await delay(5); // force the consumer to park between pushes
  }
  await consumer;
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('multiple producers interleave in arrival order', async () => {
  const q = new AsyncQueue<string>();
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const m of q) {
      seen.push(m);
      if (seen.length === 4) q.close();
    }
  })();

  // Simulate host stdin + a guest pushing concurrently.
  q.push('host:1');
  q.push('guest:1');
  await delay(10);
  q.push('guest:2');
  q.push('host:2');
  await consumer;
  assert.deepEqual(seen, ['host:1', 'guest:1', 'guest:2', 'host:2']);
});
