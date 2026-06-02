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
import { createInterface } from 'node:readline';
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
  LineRenderer,
  nameplate,
  paint,
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
  const render = new LineRenderer();

  let me: Author | undefined;
  let readOnly = false; // host policy: when true, this guest can only observe
  const myClientMsgIds = new Set<string>();
  /** turnId currently streaming into the live line, if any. */
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
   * Park your nameplate on the bottom row as the input prompt (chat-style), so it's
   * clear it's your turn to type. An observe-only guest can't type, so it shows
   * nothing there. flushLive restores this after each Claude turn.
   */
  function refreshPrompt(): void {
    if (!me) return;
    render.setStatus(readOnly ? '' : promptTag(me.displayName, me.role, me.id));
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
        const line = `${tag} ▸ ${sanitizeForTerminal(event.content)}${suffix}`;
        render.commit(event.replay ? paint(line, ansi.dim) : line);
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
          // Non-streamed (e.g. replayed history): give Claude its nameplate too.
          // Live text renders Markdown to ANSI; dim history strips markers instead
          // (per-span ANSI can't coexist with a single blanket dim).
          render.commit(
            event.replay
              ? paint(`[claude] ▸ ${stripMarkdown(text)}`, ansi.dim)
              : claudeTag() + renderMarkdown(text),
          );
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

  // ── stdin: optimistic echo + send; reconciled by clientMsgId on relay echo. ──
  const rl = createInterface({ input: process.stdin });
  let typingTimer: NodeJS.Timeout | undefined;
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
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
    // Render our own message exactly as others see it (same nameplate everyone uses).
    const tag = nameplate(me?.displayName ?? opts.displayName, me?.id ?? clientId);
    render.commit(`${tag} ▸ ${sanitizeForTerminal(text)}`); // optimistic
    relay.send({ t: 'user_message', clientMsgId, content: text });
    relay.send({ t: 'typing', isTyping: false });
  });
  // Whole-message typing signal: announce on first keystroke of a line, debounced.
  process.stdin.on('data', () => {
    relay.send({ t: 'typing', isTyping: true });
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => relay.send({ t: 'typing', isTyping: false }), 1500);
    typingTimer.unref?.();
  });

  process.on('SIGINT', () => {
    render.clearBottom();
    relay.close();
    process.exit(0);
  });

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
