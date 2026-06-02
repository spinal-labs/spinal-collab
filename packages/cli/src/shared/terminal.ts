/**
 * Minimal ANSI + readline primitives. No Ink/blessed for the MVP — just enough
 * to render attributed lines, a live streaming line, and a sticky status bar.
 *
 * Color discipline (two disjoint palettes so the channels never blur):
 *   - STATUS hues — red/yellow/green — mean deny/attention/allow and NOTHING else.
 *   - IDENTITY hues — a cool set for humans, brightMagenta for Claude — name who
 *     is speaking. No identity color is ever a status color, so a participant's
 *     nameplate can't be mistaken for a warning or an approval.
 */
import process from 'node:process';

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  reverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
} as const;

/**
 * Human identity colors — a COOL palette, deliberately excluding red/yellow/green
 * (reserved for status) and magenta (reserved for Claude). Names always print too,
 * so identity never depends on color alone.
 */
const AUTHOR_COLORS = [ansi.cyan, ansi.blue, ansi.brightCyan, ansi.brightBlue];

/** Claude's reserved identity color — distinct from every human and every status. */
export const claudeColor = ansi.brightMagenta;

export function colorForAuthor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length]!;
}

export function paint(s: string, ...codes: string[]): string {
  return `${codes.join('')}${s}${ansi.reset}`;
}

/**
 * A speaker's nameplate — `[name]` in their identity color, used identically
 * wherever a participant is named (message lines, the status-bar roster), so the
 * same person reads the same way everywhere.
 */
export function nameplate(displayName: string, id: string): string {
  return paint(`[${displayName}]`, colorForAuthor(id), ansi.bold);
}

/** The speaker nameplate for Claude's own output — the assistant gets an identity too. */
export function claudeTag(): string {
  return paint('[claude]', claudeColor, ansi.bold) + ' ▸ ';
}

/**
 * Your own input prompt — `[name - role] ▸ ` in your identity color — shown on the
 * bottom row when it's your turn to type, so the session reads like a chat: every
 * line you send is preceded by the same nameplate you'll see it committed under.
 */
export function promptTag(displayName: string, role: string, id: string): string {
  return paint(`[${displayName} - ${role}]`, colorForAuthor(id), ansi.bold) + ' ▸ ';
}

// ─────────────────────────────────────────────────────────────────── markdown
//
// Claude speaks Markdown; a plain terminal would show the raw markers (literal
// `**bold**`). These helpers render the handful of constructs Claude actually
// emits — emphasis, inline code, ATX headings, bullets, fenced code — to ANSI.
// Line-oriented and forgiving by design: an unterminated span (which is normal
// mid-stream, before the closing marker has arrived) is just left as typed.

/** Render inline spans (`**bold**`, `*italic*`, `` `code` ``) within one line. */
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => paint(c, ansi.cyan)) // `inline code`
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => paint(c, ansi.bold)) // **bold**
    .replace(/\*([^*\n]+)\*/g, (_m, c) => paint(c, ansi.italic)); // *italic*
}

/**
 * Format ONE Markdown line, given whether we're inside a fenced code block, and
 * return the rendered line plus the (possibly toggled) fence state. Per-line so
 * the streaming renderer can commit finished lines the moment their newline lands.
 */
export function formatMarkdownLine(line: string, inFence: boolean): { out: string; inFence: boolean } {
  if (/^\s*```/.test(line)) {
    const lang = line.replace(/```/g, '').trim();
    return { out: paint(lang || '─── code ───', ansi.dim), inFence: !inFence };
  }
  if (inFence) return { out: paint(line, ansi.cyan), inFence }; // code body — verbatim, no inline parsing
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return { out: paint(mdInline(heading[2]!), ansi.bold), inFence };
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { out: `${bullet[1]}${paint('•', ansi.dim)} ${mdInline(bullet[2]!)}`, inFence };
  return { out: mdInline(line), inFence };
}

/** Render a (possibly multi-line) Markdown block to ANSI. */
export function renderMarkdown(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      const r = formatMarkdownLine(line, inFence);
      inFence = r.inFence;
      return r.out;
    })
    .join('\n');
}

/**
 * Strip Markdown markers to plain text — for replayed history, which is printed
 * uniformly dim and so can't carry the per-span ANSI that renderMarkdown emits.
 */
export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*```.*$/, '')
        .replace(/^(#{1,6})\s+/, '')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1'),
    )
    .join('\n');
}

/* eslint-disable no-control-regex */
// Terminal control sequences a remote participant could use to move the cursor,
// erase lines, set the window title, or otherwise repaint the HOST's screen —
// where tool approval happens. Stripped from ALL untrusted text before display.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g; // cursor moves, erase, SGR colors, …
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // window title, hyperlinks
const ESC_PAIR = /\x1b[@-Z\\-_]/g; // other two-char escapes (\x1bc reset, …)
const LONE_ESC = /\x1b/g;
const CTRL_NO_NL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g; // controls except \t,\n
const CTRL_ALL = /[\x00-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/**
 * Neutralize terminal control sequences in untrusted text so a guest (or model,
 * or tool output) cannot spoof the host's approval UI. This is a SECURITY
 * boundary: apply it to every externally-sourced string before it reaches the
 * terminal, keeping the raw value only for non-display uses (e.g. Claude's
 * prompt). With `multiline`, `\n`/`\t` survive (for streamed model output);
 * otherwise the result is collapsed to a single safe line.
 */
export function sanitizeForTerminal(s: string, multiline = false): string {
  const stripped = s.replace(CSI, '').replace(OSC, '').replace(ESC_PAIR, '').replace(LONE_ESC, '');
  return multiline
    ? stripped.replace(CTRL_NO_NL, '')
    : stripped.replace(/[\t\n\r]+/g, ' ').replace(CTRL_ALL, '');
}

/** Visible (ANSI-stripped) length of a string. */
function visibleLength(s: string): number {
  return s.replace(CSI, '').length;
}

/** Truncate to `max` VISIBLE columns, preserving ANSI codes (which are zero-width). */
function truncateVisible(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  let out = '';
  let visible = 0;
  for (let i = 0; i < s.length && visible < max; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + '…' + ansi.reset;
}

/** A participant for the status bar (structurally compatible with protocol Author). */
export interface BarMember {
  id: string;
  displayName: string;
  role: string;
}

/**
 * Build the sticky status bar: who's connected (host marked `*`, each in their
 * identity color) · session state (colored) · your mode. Truncated to the
 * terminal width so it stays a single, non-wrapping row.
 */
export function statusBar(opts: {
  members: BarMember[];
  state: string;
  /** Guests are observe-only — shown as a badge (only when true). */
  readOnly?: boolean;
  width?: number;
}): string {
  const roster =
    opts.members
      .map((m) => {
        const name = nameplate(m.displayName, m.id);
        return m.role === 'host' ? `${name}${paint(' (host)', ansi.gray)}` : name;
      })
      .join(' ') || paint('(no one connected)', ansi.gray);
  const sep = paint('  ·  ', ansi.gray);
  // Only surface state/mode when they're *notable* — "active" and "you can type"
  // are the boring defaults and just add noise.
  const parts = [`  ${roster}`];
  if (opts.state !== 'active') {
    parts.push(paint(opts.state, opts.state === 'ended' ? ansi.red : ansi.yellow));
  }
  if (opts.readOnly) parts.push(paint('observe-only', ansi.yellow));
  return truncateVisible(parts.join(sep), (opts.width ?? process.stdout.columns ?? 80) - 1);
}

export interface Writable {
  write(s: string): void;
}

/**
 * The terminal's editable input line — owned by readline (terminal mode) and
 * always pinned to the bottom. The renderer tucks it away before printing a
 * transcript line and redraws it after, so output above never collides with what
 * the user is mid-typing (readline preserves the in-progress buffer on redraw).
 * A passive (no-op) implementation is used when stdin isn't a TTY.
 */
export interface InputLine {
  /** Erase readline's current input render so a transcript line can be printed. */
  clear(): void;
  /** Redraw the prompt + the user's in-progress input below the new transcript. */
  redraw(): void;
}

/** No input line to manage (non-interactive / piped). */
export const passiveInputLine: InputLine = { clear() {}, redraw() {} };

/**
 * Renders the transcript ABOVE a readline-owned input line.
 *
 * Why this shape: a terminal has exactly one "line you're appending to," and the
 * input box wants it. So Claude's output can't share the bottom row — instead the
 * renderer reveals it a LINE AT A TIME, committing each line above the input the
 * moment its newline arrives (the trailing partial waits for the next newline or
 * flushLive). Every print is sandwiched between input.clear()/redraw(), so the
 * prompt stays put at the bottom and type-ahead is never clobbered. readline does
 * its own echo and editing in terminal mode, so there's no cooked-mode double echo
 * to clean up — the user's own sent line is left on screen by readline itself.
 */
export class LineRenderer {
  private readonly out: Writable;
  private readonly input: InputLine;

  // Streaming accumulation: completed lines are committed as their newlines land;
  // only the trailing incomplete line (never containing a \n) is held back.
  private streaming = false;
  private liveLabel = ''; // nameplate, carried by the FIRST line of a run only
  private liveBody = ''; // text of the current incomplete line
  private inFence = false; // inside a ``` fenced code block?

  /** `out`/`input` are injectable so the renderer is unit-testable without a tty. */
  constructor(out: Writable = process.stdout, input: InputLine = passiveInputLine) {
    this.out = out;
    this.input = input;
  }

  /**
   * Print a permanent transcript line above the input line: tuck the input away,
   * emit the line, then redraw the prompt + the user's in-progress text below it.
   */
  commit(line: string): void {
    this.input.clear();
    this.out.write(line + '\n');
    this.input.redraw();
  }

  /**
   * Feed streamed assistant tokens. Each completed line is committed above the
   * input the moment its newline arrives (Markdown-rendered, nameplate on the
   * first line only); the trailing partial line is held until the next newline or
   * flushLive(). A token-by-token live line is impossible here — it would have to
   * occupy the input's bottom row — so we reveal whole lines instead, which also
   * keeps the input live for type-ahead throughout a turn.
   */
  appendLive(text: string, label = ''): void {
    if (!this.streaming) {
      this.streaming = true;
      this.liveLabel = label;
      this.liveBody = '';
      this.inFence = false;
    }
    const parts = (this.liveBody + text).split('\n');
    this.liveBody = parts.pop() ?? ''; // the last part is the still-incomplete line
    for (const finished of parts) {
      const { out, inFence } = formatMarkdownLine(finished, this.inFence);
      this.inFence = inFence;
      this.commit(this.liveLabel + out);
      this.liveLabel = ''; // only the first line of a run carries the nameplate
    }
  }

  /** Commit the final partial line of a streamed turn (if any). */
  flushLive(): void {
    if (!this.streaming) return;
    if (this.liveBody !== '' || this.liveLabel !== '') {
      const { out } = formatMarkdownLine(this.liveBody, this.inFence);
      this.commit(this.liveLabel + out);
    }
    this.streaming = false;
    this.liveLabel = '';
    this.liveBody = '';
    this.inFence = false;
  }

  /** Erase the input line (e.g. on shutdown) so no prompt is left dangling. */
  clearBottom(): void {
    this.input.clear();
  }
}
