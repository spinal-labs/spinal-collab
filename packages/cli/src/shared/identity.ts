/**
 * Display-name acquisition. Identity is "anyone with the link": the user types a
 * name, the relay assigns the stable id + role. We never trust a self-asserted
 * id/role on the wire.
 */
import { createInterface } from 'node:readline/promises';
import { sanitizeDisplayName } from '@spinal/collab-protocol';
import os from 'node:os';

/** Resolve a display name from a flag, else the OS username, else a prompt. */
export async function resolveDisplayName(fromFlag?: string): Promise<string> {
  if (fromFlag && fromFlag.trim()) return sanitizeDisplayName(fromFlag);

  const fallback = sanitizeDisplayName(os.userInfo().username || 'anon');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Display name [${fallback}]: `);
    return sanitizeDisplayName(answer.trim() || fallback);
  } finally {
    rl.close();
  }
}

/** Prompt for the join code if not provided on the command line. */
export async function resolveJoinCode(fromFlag?: string): Promise<string> {
  if (fromFlag && fromFlag.trim()) return fromFlag.trim().toUpperCase();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Join code: ');
    return answer.trim().toUpperCase();
  } finally {
    rl.close();
  }
}
