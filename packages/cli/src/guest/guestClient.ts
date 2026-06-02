/**
 * The guest: runs NO Claude. It is a live mirror of the host's thread plus a way
 * to type into it. It renders entirely from relay events.
 *
 * Late-join replay: `welcome.lastSeq` is the high-water mark at join time. Any
 * durable event with `seq <= replayUntil` is historical — rendered dim, with no
 * token animation (deltas aren't replayed at all). Once `seq > replayUntil`,
 * we're live. This is what prevents duplicated transcript and stale-token flicker.
 */
import process from 'node:process';
import { clearScreenDown, createInterface, cursorTo, moveCursor } from 'node:readline';
import { nanoid } from 'nanoid';
import {
  HEADER_JOIN_CODE,
  type AssistantBlock,
  type Author,
  type R2C,
} from '@spinal/collab-protocol';
import { RelayClient, assertSecureTransport } from '../shared/relayClient.js';
import {
  ansi,
  claudeTag,
  type InputLine,
  LineRenderer,
  nameplate,
  paint,
  passiveInputLine,
  promptTag,
  renderMarkdown,
  sanitizeForTerminal,
  statusBar,
  stripMarkdown,
} from '../shared/terminal.js';

export interface GuestOptions {
  link: string; // http(s)://host:port/claude-code/<id>/
  displayName: string;
  joinCode: string;
}

export async function runGuest(opts: GuestOptions): Promise<void> {
  const { wsBase, sessionId } = parseLink(opts.link);
  // Don't send the join code over plaintext to a remote relay.
  assertSecureTransport(wsBase);

  // readline owns the editable input line at the bottom (terminal mode echoes and
  // edits the text itself); the renderer prints transcript output ABOVE it.
  const interactive = !!process.stdout.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive, prompt: '' });
  // Don't draw an input line until the welcome installs the real prompt — keeps a
  // stray default "> " from flickering under the early connection notices.
  let promptReady = false;
  const inputLine: InputLine = interactive
    ? {
        clear() {
          if (!promptReady) return;
          // Up over all rows the prompt+input occupies (wrap, or the two-line
          // nameplate prompt), then clear down — no input fragment left behind.
          const pos = rl.getCursorPos();
          moveCursor(process.stdout, 0, -pos.rows);
          cursorTo(process.stdout, 0);
          clearScreenDown(process.stdout);
          // Reset readline's row count so the next prompt(true) won't erase the line
          // we print. readline restores it on the redraw. (Internal; stable 18–22.)
          (rl as unknown as { prevRows?: number }).prevRows = 0;
        },
        redraw() {
          if (!promptReady) return;
          rl.prompt(true);
        },
      }
    : passiveInputLine;
  const render = new LineRenderer(process.stdout, inputLine);

  let me: Author | undefined;
  let readOnly = false; // host policy: when true, this guest can only observe
  const myClientMsgIds = new Set<string>();
  /** turnId currently streaming, if any. */
  let liveTurnId: string | undefined;
  // Stable for this process so our guest identity/color survives reconnects.
  const clientId = nanoid(12);

  // Roster/state, surfaced as a one-off line only when it changes (no sticky bar
  // — it fights the terminal's input line and redraws on every event).
  let members: Author[] = [];
  let sessionState = 'active';
  let lastStatus = '';
  function refreshStatus(): void {
    const line = statusBar({ members, state: sessionState, readOnly });
    if (line === lastStatus) return;
    lastStatus = line;
    render.commit(line);
  }

  /**
   * Label the input prompt with your nameplate (chat-style), so it's clear it's
   * your turn to type. An observe-only guest can't type, so it shows nothing there.
   */
  function refreshPrompt(): void {
    if (!interactive || !me) return;
    promptReady = true;
    rl.setPrompt(readOnly ? '' : promptTag(me.displayName, me.role, me.id));
    rl.prompt(true);
  }

  const relay = new RelayClient({
    url: `${wsBase}/guest?session=${sessionId}`,
    headers: { [HEADER_JOIN_CODE]: opts.joinCode },
    role: 'guest',
    displayName: opts.displayName,
    clientId,
    onStatus: (s) => {
      if (s === 'connecting') render.commit(paint('• connecting…', ansi.dim));
      if (s === 'reconnecting') render.commit(paint('• reconnecting…', ansi.yellow));
      if (s === 'closed') render.commit(paint('• disconnected', ansi.dim));
    },
    onEvent: (event) => handle(event),
  });

  function handle(event: R2C): void {
    switch (event.t) {
      case 'welcome':
        me = event.you;
        readOnly = event.guestsReadOnly;
        members = event.members;
        sessionState = event.state;
        render.commit(
          paint(
            `• joined session ${event.sessionId} as ${event.you.displayName} (guest) — state: ${event.state}`,
            ansi.cyan,
          ),
        );
        if (readOnly) render.commit(paint('• observe-only: the host has guests in read-only mode', ansi.yellow));
        if (event.lastSeq > 0) render.commit(paint('— history —', ansi.gray));
        refreshStatus();
        refreshPrompt();
        break;

      case 'transcript.user_message': {
        if (event.clientMsgId && myClientMsgIds.has(event.clientMsgId)) {
          myClientMsgIds.delete(event.clientMsgId);
          break; // already shown optimistically
        }
        const tag = nameplate(event.author.displayName, event.author.id);
        const suffix = event.queued ? paint(' (queued)', ansi.yellow, ansi.italic) : '';
        // content is untrusted — strip terminal control sequences before display.
        const body = sanitizeForTerminal(event.content);
        if (event.replay) {
          render.commit(paint(`${tag}${suffix}`, ansi.dim));
          render.commit(paint(body, ansi.dim));
        } else {
          render.commit(`${tag}${suffix}`); // nameplate line
          render.commit(body); // message body underneath
        }
        break;
      }

      case 'assistant.delta':
        // Deltas are never replayed, so this is always live.
        liveTurnId = event.turnId;
        render.appendLive(sanitizeForTerminal(event.text, true), claudeTag());
        break;

      case 'assistant.message': {
        const text = renderBlocks(event.blocks);
        if (liveTurnId === event.turnId) {
          // The live line already showed the streamed text; just finalize it.
          render.flushLive();
          liveTurnId = undefined;
        } else if (text) {
          // Non-streamed (e.g. replayed history): nameplate on its own line, body
          // beneath. Live text renders Markdown to ANSI; dim history strips markers
          // instead (per-span ANSI can't coexist with a single blanket dim).
          if (event.replay) {
            render.commit(paint('[claude]', ansi.dim));
            render.commit(paint(stripMarkdown(text), ansi.dim));
          } else {
            render.commit(claudeTag()); // [claude] header line
            render.commit(renderMarkdown(text)); // body underneath
          }
        }
        break;
      }

      case 'tool.use':
        render.commit(
          paint(`  ⚙ ${event.name}(${truncate(JSON.stringify(event.input ?? {}), 80)})`, ansi.dim),
        );
        break;

      case 'tool.result':
        render.commit(paint(`  ${event.ok ? '✓' : '✗'} ${sanitizeForTerminal(event.summary)}`, ansi.dim));
        break;

      case 'permission.request':
        render.commit(
          paint(`  🔐 ${sanitizeForTerminal(event.toolName)} — awaiting host approval…`, ansi.yellow),
        );
        break;

      case 'permission.resolved':
        render.commit(
          paint(
            `  🔐 ${event.requestId.slice(0, 6)} ${event.decision} by ${event.by.displayName}`,
            event.decision === 'allow' ? ansi.green : ansi.red,
          ),
        );
        break;

      case 'turn.result':
        // Per-turn success/cost is noise in a chat UI; only surface a failed turn.
        if (!event.replay && event.subtype !== 'success') {
          render.commit(paint(`  — turn ${event.subtype}`, ansi.yellow));
        }
        break;

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
        if (event.state === 'ended') {
          render.clearBottom();
          relay.close();
          process.exit(0);
        }
        break;

      case 'session.policy':
        readOnly = event.guestsReadOnly;
        if (!event.replay) {
          render.commit(
            paint(
              readOnly ? '• the host set guests to observe-only' : '• the host opened typing to guests',
              ansi.yellow,
            ),
          );
        }
        refreshStatus();
        refreshPrompt(); // show/hide the input prompt as typing is opened/closed
        break;

      case 'error':
        render.commit(paint(`! ${event.code}: ${event.message}`, ansi.red));
        if (event.fatal) process.exit(1);
        break;
    }
  }

  // ── stdin: send + (when non-interactive) echo; reconciled by clientMsgId. ──
  // readline echoes/edits the line itself in terminal mode, so it already leaves
  // your own message on screen — we suppress both the optimistic and the relay
  // echo for it (the latter via myClientMsgIds) to avoid a duplicate.
  let typingTimer: NodeJS.Timeout | undefined;
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      refreshPrompt();
      return;
    }
    if (text === '/quit') {
      render.clearBottom();
      relay.close();
      process.exit(0);
    }
    if (readOnly) {
      // The relay would reject this too; stop it here for a clearer message.
      render.commit(paint('• observe-only: the host has disabled guest typing', ansi.yellow));
      return;
    }
    const clientMsgId = nanoid(8);
    myClientMsgIds.add(clientMsgId);
    // Non-interactive (piped) has no echo, so print our own line; interactive
    // already shows it via readline's input line.
    if (!interactive) {
      render.commit(nameplate(me?.displayName ?? opts.displayName, me?.id ?? clientId));
      render.commit(sanitizeForTerminal(text));
    }
    relay.send({ t: 'user_message', clientMsgId, content: text });
    relay.send({ t: 'typing', isTyping: false });
    refreshPrompt();
  });
  // Whole-message typing signal: announce on first keystroke of a line, debounced.
  process.stdin.on('data', () => {
    relay.send({ t: 'typing', isTyping: true });
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => relay.send({ t: 'typing', isTyping: false }), 1500);
    typingTimer.unref?.();
  });

  const quit = (): void => {
    render.clearBottom();
    relay.close();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  rl.on('SIGINT', quit); // terminal-mode readline traps Ctrl+C itself

  relay.connect();
}

// ─────────────────────────────────────────────────────────────────── helpers

function renderBlocks(blocks: AssistantBlock[]): string {
  return sanitizeForTerminal(
    blocks
      .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim(),
    true,
  );
}


/** Parse a share link into the ws base + session id the guest connects with. */
export function parseLink(link: string): { wsBase: string; sessionId: string } {
  const u = new URL(link);
  const m = u.pathname.match(/\/claude-code\/([^/]+)\/?/);
  if (!m) throw new Error(`not a collab share link: ${link}`);
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return { wsBase: `${wsProto}//${u.host}`, sessionId: m[1]! };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
