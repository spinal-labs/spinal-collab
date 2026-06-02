/**
 * The terminal sanitizer is a security boundary: it stops a guest (or tool
 * output, or model text) from emitting control sequences that repaint the host's
 * screen — where tool approval happens. These tests pin that behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ansi,
  claudeTag,
  colorForAuthor,
  LineRenderer,
  nameplate,
  renderMarkdown,
  sanitizeForTerminal,
  statusBar,
  stripMarkdown,
} from './terminal.js';

test('strips SGR color and other CSI sequences', () => {
  assert.equal(sanitizeForTerminal('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(sanitizeForTerminal('a\x1b[2Kb'), 'ab'); // erase line
  assert.equal(sanitizeForTerminal('a\x1b[10;5Hb'), 'ab'); // cursor move
});

test('strips OSC sequences (window title / hyperlinks)', () => {
  assert.equal(sanitizeForTerminal('\x1b]0;pwned\x07ok'), 'ok'); // BEL-terminated
  assert.equal(sanitizeForTerminal('\x1b]8;;http://x\x1b\\link'), 'link'); // ST-terminated
});

test('neutralizes a fake approval-line spoof', () => {
  // CR + erase used to overwrite the host prompt with a forged "approved".
  const attack = 'innocent\r\x1b[2K  \x1b[32m✓ approved by host\x1b[0m';
  const out = sanitizeForTerminal(attack);
  assert.ok(!out.includes('\x1b'), 'no escape chars survive');
  assert.ok(!out.includes('\r'), 'no carriage return survives');
});

test('single-line mode collapses newlines/tabs to spaces', () => {
  assert.equal(sanitizeForTerminal('a\nb\tc'), 'a b c');
  assert.equal(sanitizeForTerminal('line1\r\nline2'), 'line1 line2');
});

test('multiline mode preserves newlines and tabs but strips escapes', () => {
  assert.equal(sanitizeForTerminal('a\nb\tc', true), 'a\nb\tc');
  assert.equal(sanitizeForTerminal('a\x1b[31m\nb', true), 'a\nb');
});

test('leaves ordinary text (incl. unicode/emoji) untouched', () => {
  assert.equal(sanitizeForTerminal('hello 世界 🚀'), 'hello 世界 🚀');
});

test('strips a lone ESC and C1 controls', () => {
  assert.equal(sanitizeForTerminal('a\x1bb'), 'ab');
  assert.equal(sanitizeForTerminal('a\x9bb'), 'ab'); // C1 CSI
});

test('identity colors never overlap the status colors', () => {
  const status = new Set([ansi.red, ansi.yellow, ansi.green]);
  // Many ids → exercise the whole author palette; none may be a status hue.
  for (let i = 0; i < 50; i++) {
    assert.ok(!status.has(colorForAuthor(`id-${i}`)), `author color ${i} collides with a status color`);
  }
  // Claude's reserved color is also disjoint from status.
  assert.ok(!status.has(ansi.brightMagenta));
});

test('claudeTag gives Claude a labelled, colored nameplate', () => {
  const tag = claudeTag();
  assert.ok(tag.includes('[claude]'));
  assert.ok(tag.includes(ansi.brightMagenta));
  assert.ok(tag.includes('▸'));
});

test('statusBar: bracketed roster with (host), notable-only badges, width-bounded', () => {
  const bar = statusBar({
    members: [
      { id: 'host', displayName: 'Alice', role: 'host' },
      { id: 'g1', displayName: 'Bob', role: 'guest' },
    ],
    state: 'active',
    readOnly: true,
    width: 80,
  });
  // The roster uses the same [name] nameplate as message lines (visual consistency).
  assert.ok(bar.includes('[Alice]') && bar.includes('(host)'), 'host marked with (host)');
  assert.ok(bar.includes('[Bob]'));
  assert.ok(!bar.includes('active'), 'the default "active" state is not shown (no noise)');
  assert.ok(bar.includes('observe-only'), 'read-only surfaces a badge');

  // A *notable* state (paused) IS shown.
  const paused = statusBar({ members: [{ id: 'host', displayName: 'Alice', role: 'host' }], state: 'paused' });
  assert.ok(paused.includes('paused'));

  // A very wide roster is truncated to the given width (visible chars only).
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, displayName: `Guest${i}`, role: 'guest' }));
  const narrow = statusBar({ members: many, state: 'active', width: 30 });
  const visible = narrow.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
  assert.ok(visible.length <= 30, `truncated to width (got ${visible.length})`);
  assert.ok(visible.includes('…'), 'shows an ellipsis when truncated');
});

test('nameplate: bracketed, colored, bold — and the same for a given id', () => {
  const a = nameplate('Alice', 'host');
  assert.ok(a.includes('[Alice]'));
  assert.ok(a.includes(colorForAuthor('host')) && a.includes(ansi.bold));
  assert.equal(nameplate('Alice', 'host'), a, 'stable for the same id');
});

test('renderMarkdown: renders emphasis/code/headings/bullets, drops the markers', () => {
  const md = renderMarkdown('# Title\n**bold** and *em* and `code`\n- item');
  assert.ok(!md.includes('**') && !md.includes('`'), 'raw markers are gone');
  assert.ok(!/(^|\n)#/.test(md), 'heading hashes are gone');
  assert.ok(md.includes(ansi.bold) && md.includes(ansi.italic) && md.includes(ansi.cyan));
  assert.ok(md.includes('•'), 'bullet rendered as •');
  assert.ok(md.includes('Title') && md.includes('bold') && md.includes('code'));
});

test('renderMarkdown: fenced code is colored verbatim, not emphasis-parsed', () => {
  const md = renderMarkdown('```js\nconst x = a * b * c;\n```');
  assert.ok(!md.includes('```'), 'fence markers are gone');
  assert.ok(md.includes('const x = a * b * c;'), 'code body left intact (no italic mangling)');
});

test('stripMarkdown: plain text for dim history, no ANSI', () => {
  const s = stripMarkdown('**bold** and `code`\n- item');
  assert.ok(!s.includes('\x1b'), 'no escapes (stays uniformly dim)');
  assert.ok(!s.includes('**') && !s.includes('`'));
  assert.ok(s.includes('bold') && s.includes('code') && s.includes('• item'));
});

test('LineRenderer: streams a label once, repainting the live line in place', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) });
  r.appendLive('Hello', '[claude] ▸ ');
  r.appendLive(' world');
  const joined = out.join('');
  assert.ok(joined.includes('[claude] ▸ Hello'), 'label laid down on first token');
  // No newline yet → nothing committed; the bottom row holds the full live line,
  // repainted (not bare-appended) so Markdown can be applied to it.
  assert.ok(out[out.length - 1]!.includes('[claude] ▸ Hello world'), 'live line repainted in full');
});

test('LineRenderer: multi-line streamed output commits each line once (no duplication)', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) });
  // Stream three lines, then finalize — the classic shape that used to reprint
  // every line but the last on flush.
  r.appendLive('line one\nline two\n', '[claude] ▸ ');
  r.appendLive('line three', '[claude] ▸ ');
  r.flushLive();
  const joined = out.join('');
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  // A line lands in permanent scrollback exactly once — counted by its committing
  // newline. (The trailing partial line is repainted live AND finalized on the same
  // row, so it appears twice as raw bytes but only once as a committed `…\n` line.)
  assert.equal(count(joined, 'line one\n'), 1, 'first line committed exactly once');
  assert.equal(count(joined, 'line two\n'), 1, 'middle line committed exactly once');
  assert.equal(count(joined, 'line three\n'), 1, 'last line committed exactly once');
  // The nameplate rides only the first line; continuation lines have none.
  assert.equal(count(joined, '[claude] ▸ '), 1, 'nameplate appears once, on the first line');
});

test('LineRenderer: streamed Markdown is rendered when its line commits', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) });
  r.appendLive('**Directories:**\nrest', '[claude] ▸ ');
  const joined = out.join('');
  assert.ok(!joined.includes('**Directories:**'), 'raw bold markers do not survive commit');
  assert.ok(joined.includes(ansi.bold) && joined.includes('Directories:'));
});

test('LineRenderer: a committed line redraws the sticky status bar below it', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) });
  r.setStatus('STATUS');
  out.length = 0;
  r.commit('a permanent line');
  const joined = out.join('');
  assert.ok(joined.includes('a permanent line\n'), 'the line is committed');
  assert.ok(joined.endsWith('STATUS'), 'status bar is redrawn after the committed line');
});
