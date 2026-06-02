/**
 * The host: the only machine that runs Claude. It
 *   1. mints a session on the relay and prints a share link + join code;
 *   2. opens a single Agent-SDK `query()` fed by a never-returning AsyncQueue;
 *   3. routes EVERY human prompt (its own stdin included) through the relay, then
 *      pushes the relay's sequenced echo into the queue — so the SDK consumes in
 *      one global order with no host/guest race;
 *   4. fans the SDK output stream out to the relay as host_events and renders it
 *      locally;
 *   5. answers tool-permission requests at the terminal — the safety boundary.
 *
 * Files Claude edits land HERE, on the host, with the host's credentials.
 */
import process from 'node:process';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  HEADER_HOST_TOKEN,
  type Author,
  type HostEventBody,
  type PermissionDecision,
  type R2C,
} from '@spinal/collab-protocol';
import { AsyncQueue } from './inputQueue.js';
import { SdkBridge } from './sdkBridge.js';
import { AuditLog } from './auditLog.js';
import { RelayClient, assertSecureTransport } from '../shared/relayClient.js';
import {
  ansi,
  claudeTag,
  LineRenderer,
  nameplate,
  paint,
  sanitizeForTerminal,
  statusBar,
} from '../shared/terminal.js';

export interface HostOptions {
  relayUrl: string; // ws://host:port
  displayName: string;
  /** Resume the previous SDK conversation (via options.resume) if one is saved. */
  resumeFromLast?: boolean;
  /** Start with guests observe-only (they can be opened later with /readonly off). */
  readonlyGuests?: boolean;
}

/** Where the host remembers the last SDK session_id for --resume. */
const stateFile = join(homedir(), '.collab', 'last-session.json');
const require = createRequire(import.meta.url);

function persistSdkSession(sdkSessionId: string): void {
  try {
    mkdirSync(join(homedir(), '.collab'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ sdkSessionId }), 'utf8');
  } catch {
    /* best-effort; resume is a convenience, not a guarantee */
  }
}

function readPersistedSdkSession(): string | undefined {
  try {
    const { sdkSessionId } = JSON.parse(readFileSync(stateFile, 'utf8'));
    return typeof sdkSessionId === 'string' ? sdkSessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Claude Code IDE extension (VS Code / Cursor / etc.) ships a real `claude`
 * binary but doesn't put it on PATH. Tons of users have Claude Code *only* via the
 * IDE, so we discover that binary as a fallback — letting the small (SDK-pruned)
 * release host a session with no standalone CLI install and no env vars.
 */
function findIdeClaudeExecutable(): string | undefined {
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const roots = [
    join(homedir(), '.cursor', 'extensions'),
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-server', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
  ];
  const found: { path: string; mtime: number }[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // root doesn't exist
    }
    for (const e of entries) {
      if (!e.startsWith('anthropic.claude-code-')) continue;
      const candidate = join(root, e, 'resources', 'native-binary', bin);
      try {
        const st = statSync(candidate);
        if (st.isFile()) found.push({ path: candidate, mtime: st.mtimeMs });
      } catch {
        /* not this version */
      }
    }
  }
  // Newest-installed wins (handles multiple extension versions side by side).
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path;
}

/**
 * Locate the Claude Code executable to drive, in priority order:
 *   1. SPINAL_CLAUDE_PATH (explicit override)
 *   2. `claude` on PATH (standalone CLI)
 *   3. the Claude Code IDE extension's bundled binary (VS Code / Cursor / …)
 *   4. the Agent SDK's bundled cli.js (present only in an unpruned/dev tree)
 */
function resolveClaudeExecutable(): string | undefined {
  const explicit = process.env.SPINAL_CLAUDE_PATH?.trim();
  if (explicit) return explicit;
  try {
    const found = execFileSync('command', ['-v', 'claude'], {
      encoding: 'utf8',
      shell: true,
    }).trim();
    if (found) return found;
  } catch {
    /* not on PATH — fall through */
  }
  const ide = findIdeClaudeExecutable();
  if (ide) return ide;
  try {
    return require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  } catch {
    return undefined;
  }
}

interface SessionCredentials {
  sessionId: string;
  joinCode: string;
  hostToken: string;
}

export async function runHost(opts: HostOptions): Promise<void> {
  const { httpBase, wsBase } = splitRelayUrl(opts.relayUrl);
  // Don't mint or send credentials over plaintext to a remote relay.
  assertSecureTransport(wsBase);
  const creds = await mintSession(httpBase);

  const shareLink = `${httpBase}/claude-code/${creds.sessionId}/`;
  printBanner(shareLink, creds.joinCode, opts.displayName);

  const render = new LineRenderer();
  const bridge = new SdkBridge();
  const audit = new AuditLog(creds.sessionId);
  render.commit(paint(`• audit log: ${audit.path}`, ansi.dim));
  if (opts.readonlyGuests) render.commit(paint('• guests start observe-only (/readonly off to open)', ansi.dim));

  // The load-bearing queue feeding the SDK. Never returns until close().
  const inputQueue = new AsyncQueue<SDKUserMessage>();

  // Tool-permission requests awaiting a y/n. Claude can request several tools in
  // one turn (parallel calls), so we ask STRICTLY ONE AT A TIME: only the head of
  // the queue is shown, and an answer always applies to the tool on screen — no
  // FIFO/visible-prompt mismatch that could approve or deny the wrong tool.
  interface PendingPermission {
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    resolve: (d: PermissionDecision) => void;
  }
  const permissionQueue: PendingPermission[] = [];
  let askingNow = false;

  /** Render the prompt for the next queued tool, if any. */
  function promptNextPermission(): void {
    const next = permissionQueue[0];
    if (!next) {
      askingNow = false;
      return;
    }
    askingNow = true;
    render.commit(
      paint(`\n🔐 ${sanitizeForTerminal(next.toolName)} wants to run. Approve? [y/N]`, ansi.yellow, ansi.bold) +
        paint(`\n   ${truncate(JSON.stringify(next.input), 200)}`, ansi.dim),
    );
  }

  let me: Author | undefined;

  // Roster/state, surfaced as a one-off line only when it changes — a sticky
  // bottom bar fights the terminal's own input line and redraws on every event.
  let members: Author[] = [];
  let sessionState = 'active';
  let guestsReadOnly = false;
  let lastStatus = '';
  function refreshStatus(): void {
    const line = statusBar({ members, state: sessionState, readOnly: guestsReadOnly });
    if (line === lastStatus) return; // no change → don't reprint
    lastStatus = line;
    render.commit(line);
  }

  const relay = new RelayClient({
    url: `${wsBase}/host?session=${creds.sessionId}`,
    headers: { [HEADER_HOST_TOKEN]: creds.hostToken },
    role: 'host',
    displayName: opts.displayName,
    onStatus: (s) => {
      if (s === 'reconnecting') render.commit(paint('• relay connection lost, reconnecting…', ansi.yellow));
      if (s === 'open' && me) render.commit(paint('• relay connected', ansi.dim));
    },
    onEvent: (event) => handleRelayEvent(event),
  });

  function broadcast(body: HostEventBody): void {
    relay.send({ t: 'host_event', body });
  }

  function handleRelayEvent(event: R2C): void {
    switch (event.t) {
      case 'welcome':
        me = event.you;
        members = event.members;
        sessionState = event.state;
        guestsReadOnly = event.guestsReadOnly;
        refreshStatus();
        // Apply the host's initial guest policy once the relay knows who we are.
        if (opts.readonlyGuests && !event.guestsReadOnly) {
          relay.send({ t: 'set_policy', guestsReadOnly: true });
        }
        break;

      case 'transcript.user_message': {
        // The single ordering point: push the sequenced human prompt into the
        // SDK queue (author-prefixed so Claude can attribute), and render it.
        audit.record({
          type: 'prompt',
          author: event.author,
          content: event.content,
          queued: !!event.queued,
        });
        const tag = `[${event.author.displayName}]`;
        inputQueue.push({
          type: 'user',
          message: { role: 'user', content: `${tag}: ${event.content}` },
          parent_tool_use_id: null,
          session_id: '',
        } as SDKUserMessage);
        const suffix = event.queued ? paint(' (queued)', ansi.yellow, ansi.italic) : '';
        // content is untrusted (any guest with the link). Strip terminal control
        // sequences before display so it can't spoof this host's approval UI.
        const safe = sanitizeForTerminal(event.content);
        render.commit(`${nameplate(event.author.displayName, event.author.id)} ▸ ${safe}${suffix}`);
        break;
      }

      case 'presence':
        members = event.members;
        refreshStatus();
        break;

      case 'typing':
        if (event.isTyping && event.author.id !== me?.id) {
          render.commit(paint(`  ${event.author.displayName} is typing…`, ansi.dim));
        }
        break;

      case 'session.state':
        sessionState = event.state;
        render.commit(paint(`• session ${event.state}`, ansi.dim));
        refreshStatus();
        break;

      case 'session.policy':
        guestsReadOnly = event.guestsReadOnly;
        render.commit(
          paint(`• guests are now ${event.guestsReadOnly ? 'observe-only' : 'able to type'}`, ansi.dim),
        );
        refreshStatus();
        break;

      case 'error':
        render.commit(paint(`! relay error [${event.code}]: ${event.message}`, ansi.red));
        // A fatal error (e.g. version mismatch) won't recover — don't leave the
        // SDK loop hanging on a queue the dead relay can no longer feed.
        if (event.fatal) shutdown();
        break;

      // Assistant-side events are produced by THIS host and rendered locally
      // from the SDK stream directly (below). We ignore our own echoes here to
      // avoid double-rendering.
      default:
        break;
    }
  }

  // ── Tool permission: the safety boundary. Host answers at the terminal. ──
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
  > => {
    const requestId = nanoid(8);
    audit.record({ type: 'tool_request', requestId, toolName, input });
    broadcast({ t: 'permission.request', requestId, toolName, input });

    const decision = await new Promise<PermissionDecision>((resolve) => {
      permissionQueue.push({ requestId, toolName, input, resolve });
      // Show this prompt now only if nothing else is currently being asked;
      // otherwise it waits its turn and is shown when the prior one is answered.
      if (!askingNow) promptNextPermission();
    });

    const by = me ?? { id: 'host', displayName: opts.displayName, role: 'host' };
    audit.record({ type: 'tool_decision', requestId, toolName, decision, by: by.displayName });
    broadcast({ t: 'permission.resolved', requestId, decision, by });

    return decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Denied by host.' };
  };

  // ── stdin: multiplexes permission answers and prompts on one reader. ──
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();

    // If a tool prompt is on screen, this line answers THAT tool (the head of the
    // queue), then we advance to the next pending one.
    if (askingNow) {
      const current = permissionQueue.shift();
      if (current) {
        const decision: PermissionDecision = /^y(es)?$/i.test(text) ? 'allow' : 'deny';
        render.commit(
          paint(
            `   → ${sanitizeForTerminal(current.toolName)}: ${decision}`,
            decision === 'allow' ? ansi.green : ansi.red,
          ),
        );
        current.resolve(decision);
        promptNextPermission();
      }
      return;
    }

    if (!text) return;
    if (text === '/end' || text === '/quit') {
      shutdown();
      return;
    }
    // Host control: toggle the guest write policy.
    if (text === '/readonly' || text === '/readonly on') {
      relay.send({ t: 'set_policy', guestsReadOnly: true });
      return;
    }
    if (text === '/readonly off') {
      relay.send({ t: 'set_policy', guestsReadOnly: false });
      return;
    }
    // Route through the relay; the echo will push it into the SDK queue.
    relay.send({ t: 'user_message', clientMsgId: nanoid(8), content: text });
  });

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    render.flushLive();
    render.clearBottom(); // drop the sticky status bar before final output
    render.commit(paint('• ending session', ansi.dim));
    // Tell everyone the session ended BEFORE dropping the socket, so guests see
    // `ended` rather than the `paused` the relay would infer from a bare close.
    relay.send({ t: 'end_session' });
    inputQueue.close(); // ends the SDK loop gracefully
    rl.close();
    // Give the end_session frame a moment to flush, then close + exit.
    setTimeout(() => {
      relay.close();
      process.exit(0);
    }, 200).unref?.();
  }
  process.on('SIGINT', shutdown);

  relay.connect();

  // Resume the prior conversation if asked and one is saved.
  const resumeId = opts.resumeFromLast ? readPersistedSdkSession() : undefined;
  if (resumeId) render.commit(paint(`• resuming SDK session ${resumeId.slice(0, 8)}…`, ansi.dim));

  // Drive the user's installed Claude Code, not a bundled copy (see resolver).
  // We drive the user's OWN Claude Code; the SDK's bundled copy is pruned from the
  // release, so `claude` MUST be resolvable. Fail fast with a clear message rather
  // than let the SDK error cryptically on a missing executable.
  const claudePath = resolveClaudeExecutable();
  if (!claudePath) {
    render.flushLive();
    render.clearBottom();
    render.commit(
      paint(
        '! Claude Code not found. Install it (https://claude.com/claude-code) — the CLI or the\n' +
          '  VS Code/Cursor extension both work — or set SPINAL_CLAUDE_PATH. (The host runs Claude locally.)',
        ansi.red,
      ),
    );
    process.exit(1);
  }

  // ── The single SDK loop. Fed by the queue; output fanned out + rendered. ──
  const stream = query({
    prompt: inputQueue,
    options: {
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool,
      resume: resumeId,
      pathToClaudeCodeExecutable: claudePath,
    },
  });

  try {
    for await (const msg of stream) {
      const { events, sessionId } = bridge.translate(msg);
      if (sessionId) persistSdkSession(sessionId); // for a future --resume
      for (const ev of events) {
        broadcast(ev); // fan out to guests
        renderHostEvent(render, ev); // render locally from our own stream
      }
    }
  } catch (err) {
    render.commit(paint(`! SDK loop error: ${(err as Error).message}`, ansi.red));
  } finally {
    shutdown();
  }
}

// ───────────────────────────────────────────────────────────── local rendering

function renderHostEvent(render: LineRenderer, ev: HostEventBody): void {
  switch (ev.t) {
    case 'assistant.delta':
      // Model output: keep newlines/tabs, strip cursor/erase/OSC control seqs.
      // The Claude nameplate is laid down on the first token of the line.
      render.appendLive(sanitizeForTerminal(ev.text, true), claudeTag());
      break;
    case 'assistant.message':
      render.flushLive(); // promote streamed text to a committed line
      break;
    case 'tool.use':
      // JSON.stringify already escapes control chars in the input.
      render.commit(paint(`  ⚙ ${ev.name}(${truncate(JSON.stringify(ev.input ?? {}), 80)})`, ansi.dim));
      break;
    case 'tool.result':
      render.commit(paint(`  ${ev.ok ? '✓' : '✗'} ${sanitizeForTerminal(ev.summary)}`, ansi.dim));
      break;
    case 'turn.result':
      if (ev.costUsd != null) {
        render.commit(paint(`  — turn ${ev.subtype} ($${ev.costUsd.toFixed(4)})`, ansi.gray));
      }
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────── helpers

function printBanner(shareLink: string, joinCode: string, name: string): void {
  const joinCmd = `spinal-collab join "${shareLink}" --code ${joinCode}`;
  process.stdout.write(
    [
      '',
      paint('  ┌─ collab: shared Claude Code session ─────────────────', ansi.cyan),
      paint(`  │ you        : ${name} (host)`, ansi.cyan),
      paint('  └──────────────────────────────────────────────────────', ansi.cyan),
      paint('  Guests join with (copy–paste — it will ask their name):', ansi.dim),
      '    ' + paint(joinCmd, ansi.cyan, ansi.bold),
      '',
      paint(`  (share link: ${shareLink}  ·  join code: ${joinCode})`, ansi.dim),
      paint('  ⚠ Anyone with the link + code can drive Claude on THIS machine.', ansi.red, ansi.bold),
      paint('  Type a prompt and press Enter. /end to stop.', ansi.dim),
      '',
    ].join('\n') + '\n',
  );
}

async function mintSession(httpBase: string): Promise<SessionCredentials> {
  // If the relay gates minting behind a control token, present it.
  const controlToken = process.env.COLLAB_CONTROL_TOKEN?.trim();
  const headers = controlToken ? { authorization: `Bearer ${controlToken}` } : undefined;
  const res = await fetch(`${httpBase}/sessions`, { method: 'POST', headers });
  if (!res.ok) throw new Error(`relay rejected session creation (${res.status})`);
  const body = (await res.json()) as SessionCredentials;
  return body;
}

/** ws://host:port → { httpBase: http://host:port, wsBase: ws://host:port }. */
function splitRelayUrl(relayUrl: string): { httpBase: string; wsBase: string } {
  const u = new URL(relayUrl);
  const wsBase = `${u.protocol.startsWith('ws') ? u.protocol : 'ws:'}//${u.host}`;
  const httpProto = u.protocol === 'wss:' ? 'https:' : 'http:';
  const httpBase = `${httpProto}//${u.host}`;
  return { httpBase, wsBase };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
