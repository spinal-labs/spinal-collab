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

/** The speaker nameplate for Claude's own output — the assistant gets an identity too. */
export function claudeTag(): string {
  return paint('[claude]', claudeColor, ansi.bold) + ' ▸ ';
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
  mode: string;
  width?: number;
}): string {
  const roster =
    opts.members
      .map((m) => paint(m.displayName + (m.role === 'host' ? '*' : ''), colorForAuthor(m.id), ansi.bold))
      .join(' ') || paint('(no one connected)', ansi.gray);
  const stateColor = opts.state === 'active' ? ansi.green : opts.state === 'ended' ? ansi.red : ansi.yellow;
  const sep = paint('·', ansi.gray);
  const bar = `  ${roster}  ${sep}  ${paint(opts.state, stateColor)}  ${sep}  ${paint(opts.mode, ansi.gray)}`;
  return truncateVisible(bar, (opts.width ?? process.stdout.columns ?? 80) - 1);
}

/**
 * Renders committed scrollback above a single, persistent bottom row. That row
 * shows the live streaming line while a turn is in flight, and the sticky status
 * bar the rest of the time — one logical region, so there's no multi-line cursor
 * math and token streaming stays a cheap in-place append (only the first token of
 * a turn repaints, to swap the status bar out for the live line).
 */
export interface Writable {
  write(s: string): void;
}

export class LineRenderer {
  private live = '';
  private status = '';
  private readonly out: Writable;

  /** `out` is injectable so the renderer can be unit-tested without a real tty. */
  constructor(out: Writable = process.stdout) {
    this.out = out;
  }

  /** What currently occupies the bottom row: the live line wins while streaming. */
  private bottom(): string {
    return this.live !== '' ? this.live : this.status;
  }

  /** Print a permanent line above the bottom row, then redraw the bottom row. */
  commit(line: string): void {
    this.out.write('\r\x1b[K' + line + '\n' + this.bottom());
  }

  /**
   * Append a streamed token. On the first token of a line, `label` (e.g. the
   * Claude nameplate) is laid down and the status bar is swapped out; subsequent
   * tokens are a cheap in-place append.
   */
  appendLive(text: string, label = ''): void {
    if (this.live === '') {
      this.live = label + text;
      this.out.write('\r\x1b[K' + this.live);
    } else {
      this.live += text;
      this.out.write(text);
    }
  }

  /** Promote the streamed line to committed scrollback; restore the status bar. */
  flushLive(): void {
    if (this.live) {
      this.out.write('\r\x1b[K' + this.live + '\n' + this.status);
      this.live = '';
    }
  }

  /** Set the sticky status bar; redrawn immediately unless a turn is streaming. */
  setStatus(text: string): void {
    this.status = text;
    if (this.live === '') this.out.write('\r\x1b[K' + this.status);
  }

  /** Clear the bottom row (e.g. on shutdown) so no dangling bar is left behind. */
  clearBottom(): void {
    this.out.write('\r\x1b[K');
  }
}
