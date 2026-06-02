/**
 * AsyncQueue — the load-bearing piece of the host.
 *
 * It is an async iterator we hand to the Agent SDK as its `prompt`. Unlike a
 * normal generator over a finite array, this one must:
 *   1. yield items in the exact order they were pushed (FIFO);
 *   2. when momentarily empty, *await* the next push rather than returning —
 *      a `return` would end the SDK's `query()` loop and tear down the session;
 *   3. only ever terminate when `close()` is called explicitly.
 *
 * Multiple producers (host stdin + each guest's relay messages) push into the
 * same queue; the single SDK consumer pulls in arrival order. That ordering is
 * what serializes a multi-person conversation into one coherent thread.
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  /** Buffered items waiting to be pulled. */
  private readonly buffer: T[] = [];
  /** Consumers parked on an empty buffer, awaiting the next push. */
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  /** Push an item. Wakes a parked consumer if one is waiting. No-op after close. */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * Close the queue. Any future `push` is ignored; once the buffer drains, the
   * iterator reports `done` and the SDK loop ends gracefully.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Release everyone currently parked — nothing more is coming.
    let waiter: ((result: IteratorResult<T>) => void) | undefined;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift() as T, done: false };
    }
    if (this.closed) {
      return { value: undefined as never, done: true };
    }
    // Buffer empty and still open: park until the next push (or close()).
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Allow `for await` consumers to break out cleanly (treated as close). */
  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { value: undefined as never, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
