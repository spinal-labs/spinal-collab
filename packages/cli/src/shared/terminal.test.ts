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
  sanitizeForTerminal,
  statusBar,
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

test('statusBar shows roster, state, and mode, and stays within width', () => {
  const bar = statusBar({
    members: [
      { id: 'host', displayName: 'Alice', role: 'host' },
      { id: 'g1', displayName: 'Bob', role: 'guest' },
    ],
    state: 'active',
    mode: 'observe-only',
    width: 80,
  });
  assert.ok(bar.includes('Alice*'), 'host marked with *');
  assert.ok(bar.includes('Bob'));
  assert.ok(bar.includes('active'));
  assert.ok(bar.includes('observe-only'));

  // A very wide roster is truncated to the given width (visible chars only).
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, displayName: `Guest${i}`, role: 'guest' }));
  const narrow = statusBar({ members: many, state: 'active', mode: 'host', width: 30 });
  const visible = narrow.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
  assert.ok(visible.length <= 30, `truncated to width (got ${visible.length})`);
  assert.ok(visible.includes('…'), 'shows an ellipsis when truncated');
});

test('LineRenderer: streams a label once, then appends tokens in place', () => {
  const out: string[] = [];
  const r = new LineRenderer({ write: (s) => out.push(s) });
  r.appendLive('Hello', '[claude] ▸ ');
  r.appendLive(' world');
  const joined = out.join('');
  assert.ok(joined.includes('[claude] ▸ Hello'), 'label laid down on first token');
  // The second token is written bare (cheap append), not re-prefixed.
  assert.equal(out[out.length - 1], ' world');
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
