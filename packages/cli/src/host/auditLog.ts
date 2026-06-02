/**
 * Host-side audit log. Every guest-attributed prompt and every tool
 * request/decision is appended, on the host, as one JSON object per line —
 * accountability lives where the actions actually run. Best-effort: a write
 * failure never interrupts the session.
 *
 * The file holds prompt content and tool inputs, which can be sensitive, so the
 * directory is 0700 and the file 0600 (owner-only).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AuditEntry =
  | { type: 'prompt'; author: { id: string; displayName: string; role: string }; content: string; queued: boolean }
  | { type: 'tool_request'; requestId: string; toolName: string; input: unknown }
  | { type: 'tool_decision'; requestId: string; toolName: string; decision: string; by: string };

export class AuditLog {
  readonly path: string;
  private readonly now: () => number;

  constructor(sessionId: string, now: () => number = () => Date.now()) {
    const dir = join(homedir(), '.collab', 'audit');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${sessionId}.jsonl`);
    this.now = now;
  }

  record(entry: AuditEntry): void {
    try {
      appendFileSync(this.path, JSON.stringify({ ts: this.now(), ...entry }) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      /* best-effort; auditing must never break the session */
    }
  }
}
