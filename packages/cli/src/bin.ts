#!/usr/bin/env node
/**
 * `spinal-collab` — shared Claude Code session.
 *
 *   spinal-collab share [options]            host a session (runs Claude here)
 *   spinal-collab join  <share-link> [opts]  mirror a session + type into it
 *
 * `share` runs Claude on THIS machine and prints a link + join code.
 * `join`  mirrors that session and lets you type into it (runs no Claude).
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { runHost } from './host/hostSession.js';
import { runGuest } from './guest/guestClient.js';
import { resolveDisplayName, resolveJoinCode } from './shared/identity.js';

const USAGE = `spinal-collab — drive one shared Claude Code session from multiple terminals

USAGE
  spinal-collab share [options]               host a session (Claude runs here)
  spinal-collab join <share-link> [options]   join a session (mirror + type, no Claude)
  spinal-collab help [share|join]             show help
  spinal-collab --version

QUICK START
  # Host — needs Claude Code installed and logged in:
  spinal-collab share --name Alice
  → prints a share link + a 6-char join code; send BOTH to your guests.

  # Guest — on another machine/terminal:
  spinal-collab join "<share-link>" --name Bob --code <JOINCODE>

IN-SESSION
  <text> + Enter      send a prompt into the shared thread
  y / N               (host) approve or deny a tool Claude wants to run
  /readonly on|off    (host) lock guests to observe-only / reopen typing
  /end                (host) end the session for everyone
  /quit               (guest) leave the session

See \`spinal-collab help share\` or \`help join\` for all options and env vars.`;

const SHARE_HELP = `spinal-collab share — host a shared Claude Code session

Claude runs on THIS machine, with YOUR login, and edits YOUR files. Anyone with
the share link + join code can drive it — but every tool call stops for YOUR y/N.

USAGE
  spinal-collab share [options]

OPTIONS
  --name <name>       your display name (you'll be prompted if omitted)
  --relay <url>       relay to use (default: $COLLAB_RELAY or wss://share.getspinal.com)
  --resume            continue your previous SDK conversation
  --readonly-guests   start with guests observe-only (reopen later: /readonly off)
  -h, --help          show this help

ENV
  COLLAB_RELAY            default relay URL
  COLLAB_CONTROL_TOKEN   sent as 'Authorization: Bearer …' when minting, if the
                         relay requires it
  COLLAB_ALLOW_INSECURE=1 allow plaintext ws:// to a non-local relay (dev only)
  SPINAL_CLAUDE_PATH     path to the 'claude' binary to drive (else found on PATH,
                         else the SDK's bundled copy)

FILES
  ~/.collab/last-session.json         last SDK session id (used by --resume)
  ~/.collab/audit/<sessionId>.jsonl   audit log: prompts + tool decisions (0600)`;

const JOIN_HELP = `spinal-collab join — mirror a shared session and type into it (runs no Claude)

USAGE
  spinal-collab join <share-link> [options]

ARGUMENTS
  <share-link>   the http(s):// link the host gave you

OPTIONS
  --name <name>  your display name (you'll be prompted if omitted)
  --code <code>  the 6-char join code (you'll be prompted if omitted)
  -h, --help     show this help

ENV
  COLLAB_ALLOW_INSECURE=1   allow plaintext ws:// to a non-local relay (dev only)`;

function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    const topic = rest[0]; // the word after `help`, if any
    if (topic === 'share') return void out(SHARE_HELP);
    if (topic === 'join') return void out(JOIN_HELP);
    return void out(USAGE);
  }
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    return void out(cliVersion());
  }

  if (sub === 'share') {
    const { values } = parseArgs({
      args: rest,
      options: {
        relay: { type: 'string', default: process.env.COLLAB_RELAY ?? 'wss://share.getspinal.com' },
        name: { type: 'string' },
        resume: { type: 'boolean', default: false },
        'readonly-guests': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return void out(SHARE_HELP);
    const displayName = await resolveDisplayName(values.name);
    await runHost({
      relayUrl: values.relay!,
      displayName,
      resumeFromLast: values.resume,
      readonlyGuests: values['readonly-guests'],
    });
    return;
  }

  if (sub === 'join') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        code: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) return void out(JOIN_HELP);
    const link = positionals[0];
    if (!link) {
      fail(`join requires a share link:\n  spinal-collab join "http://host:port/claude-code/<id>/"\n\n${JOIN_HELP}`);
    }
    const displayName = await resolveDisplayName(values.name);
    const joinCode = await resolveJoinCode(values.code);
    await runGuest({ link: link!, displayName, joinCode });
    return;
  }

  fail(`unknown command: ${sub}\n\n${USAGE}`);
}

function out(message: string): void {
  process.stdout.write(message + '\n');
}

function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
