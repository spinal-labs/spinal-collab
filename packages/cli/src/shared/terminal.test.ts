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
  promptTag,
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

test('claudeTag gives Claude a labelled, colored nameplate (its own header line)', () => {
  const tag = claudeTag();
  assert.ok(tag.includes('[claude]'));
  assert.ok(tag.includes(ansi.brightMagenta));
});

test('promptTag: nameplate with role, on its own line (trailing newline)', () => {
  const p = promptTag('Alice', 'host', 'host');
  assert.ok(p.includes('[Alice - host]'));
  assert.ok(p.endsWith('\n'), 'cursor drops to the next line for typing');
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

/** A spy InputLine that records the clear()/redraw() calls around each commit. */
function spyInput(log: string[]) {
  return {
    line: { clear: () => log.push('<clear>'), redraw: () => log.push('<redraw>') },
    log,
  };
}

test('LineRenderer: commit prints a line sandwiched by input clear()/redraw()', () => {
  const log: string[] = [];
  const { line } = spyInput(log);
  const r = new LineRenderer({ write: (s) => log.push(s) }, line);
  r.commit('a permanent line');
  // The input line is tucked away, the transcript line is printed with a newline,
  // then the prompt + in-progress buffer is redrawn below it.
  assert.deepEqual(log, ['<clear>', 'a permanent line\n', '<redraw>']);
});

test('LineRenderer: streamed nameplate is its own line, then one line per body line', () => {
  const log: string[] = [];
  const { line } = spyInput(log);
  const r = new LineRenderer({ write: (s) => log.push(s) }, line);
  // Stream three lines, then finalize.
  r.appendLive('line one\nline two\n', '[claude]');
  r.appendLive('line three', '[claude]');
  r.flushLive();
  const written = log.filter((s) => s.endsWith('\n'));
  assert.deepEqual(
    written,
    ['[claude]\n', 'line one\n', 'line two\n', 'line three\n'],
    'nameplate on its own line, then each body line once (no per-line nameplate)',
  );
  // Every printed line is wrapped by a clear()/redraw() pair (input stays pinned).
  assert.equal(log.filter((s) => s === '<clear>').length, 4);
  assert.equal(log.filter((s) => s === '<redraw>').length, 4);
});

test('LineRenderer: no nameplate is emitted for an empty stream', () => {
  const log: string[] = [];
  const { line } = spyInput(log);
  const r = new LineRenderer({ write: (s) => log.push(s) }, line);
  r.appendLive('', '[claude]'); // a streaming turn that produces no text
  r.flushLive();
  assert.deepEqual(log.filter((s) => s.endsWith('\n')), [], 'no dangling nameplate with no body');
});

test('LineRenderer: streamed Markdown is rendered as each line commits', () => {
  const log: string[] = [];
  const { line } = spyInput(log);
  const r = new LineRenderer({ write: (s) => log.push(s) }, line);
  r.appendLive('**Directories:**\nrest', '[claude]');
  const joined = log.join('');
  assert.ok(joined.includes('[claude]\n'), 'nameplate printed on its own line first');
  assert.ok(!joined.includes('**Directories:**'), 'raw bold markers do not survive commit');
  assert.ok(joined.includes(ansi.bold) && joined.includes('Directories:'));
  // "rest" has no trailing newline yet — held back until the next newline/flush.
  assert.ok(!joined.includes('rest'), 'trailing partial line is not committed early');
  r.flushLive();
  assert.ok(log.join('').includes('rest'), 'flushLive commits the final partial line');
});

test('LineRenderer: a passive input line (non-tty) just prints lines', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) }); // defaults to passiveInputLine
  r.commit('hello');
  assert.deepEqual(out, ['hello\n']);
});
