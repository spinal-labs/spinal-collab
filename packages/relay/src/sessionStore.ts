/**
 * In-memory session registry (MVP). One process, one Map. A real deployment
 * would back this with Redis/DB for multi-instance + persistence, but the
 * Session interface stays the same.
 */
import { customAlphabet, nanoid } from 'nanoid';
import { Session } from './session.js';

/** Short, unambiguous join codes — no 0/O/1/l confusion when spoken aloud. */
const joinCodeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeJoinCode = customAlphabet(joinCodeAlphabet, 6);

export class SessionStore {
  private readonly byId = new Map<string, Session>();

  /** `now` is injectable so idle reaping can be tested deterministically. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  create(): Session {
    const session = new Session({
      id: nanoid(10),
      joinCode: makeJoinCode(),
      hostToken: nanoid(32),
      now: this.now,
    });
    this.byId.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  /**
   * Drop sessions that have had no connected clients for longer than
   * `maxIdleMs` — a host that crashed or a session whose host never connected.
   * Sessions with live clients are kept regardless of quiet (the heartbeat
   * reaps their dead sockets first, which then makes them eligible). Returns the
   * ids reaped, for logging.
   */
  reapIdle(maxIdleMs: number): string[] {
    const cutoff = this.now() - maxIdleMs;
    const reaped: string[] = [];
    for (const [id, session] of this.byId) {
      if (session.clientCount === 0 && session.lastActiveAt <= cutoff) {
        this.byId.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }
}
