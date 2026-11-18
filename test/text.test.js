'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, seg, displayWidth, clip, renderLine, wrapChips, wrapText, age } = require('../lib/text');
const { stripAnsi } = require('./helpers/fake');

test('sanitize removes terminal escapes, controls and bidi overrides from GitHub text', () => {
  const hostile = 'Fix\x1b[2J\x1b]52;c;ZXZpbA==\x07 bug\x1b[1;1H‮!\u0085';
  const clean = sanitize(hostile);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f‮]/);
  assert.equal(clean, 'Fix[2J]52;c;ZXZpbA== bug[1;1H!');
});

test('sanitize turns newlines and tabs into single spaces', () => {
  assert.equal(sanitize('a\r\n\tb'), 'a b');
  assert.equal(sanitize(undefined), '');
});

test('displayWidth counts emoji and CJK as two columns and joiners as zero', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('🚀'), 2);
  assert.equal(displayWidth('✨'), 2);
  assert.equal(displayWidth('漢字'), 4);
  assert.equal(displayWidth('✓✗●⊘✎'), 5);
  assert.equal(displayWidth('a​b'), 2);
});

test('clip never exceeds the width and never splits a surrogate pair', () => {
  for (const text of ['🚀🚀🚀🚀', 'a🚀b🚀c', '漢字漢字漢字', 'plain ascii text']) {
    for (let width = 1; width <= 8; width++) {
      const out = clip(text, width);
      assert.ok(displayWidth(out) <= width, `${JSON.stringify(text)} @${width} → ${out}`);
      assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])/);
    }
  }
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 3), 'abc');
});

test('renderLine clips across segments to the visible width, ignoring colour codes', () => {
  const red = (t) => `\x1b[31m${t}\x1b[39m`;
  const line = renderLine([seg('#12 ', red), seg('🚀 Launch the rocket today')], 12);
  assert.ok(displayWidth(stripAnsi(line)) <= 12);
  assert.equal(stripAnsi(line), '#12 🚀 Laun…'); // 🚀 takes two of the 12 columns
});

test('wrapChips flows chips onto indented lines within the width', () => {
  const chips = ['✗ build', '✗ lint-and-typecheck', '● e2e', '✓ 4 passed'].map((t) => seg(t));
  const lines = wrapChips(chips, 20, '  ').map((l) => l.map((s) => s.text).join(''));
  assert.deepEqual(lines, ['  ✗ build', '  ✗ lint-and-typecheck', '  ● e2e  ✓ 4 passed']);
});

test('wrapText word-wraps with single spaces', () => {
  const lines = wrapText('No GitHub repo named "x" here', 12).map((l) => l.map((s) => s.text).join(''));
  assert.deepEqual(lines, ['No GitHub', 'repo named', '"x" here']);
});

test('age formats minutes, hours and days', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(age('2026-11-18T11:55:00Z', now), '5m');
  assert.equal(age('2026-11-18T09:00:00Z', now), '3h');
  assert.equal(age('2026-11-13T12:00:00Z', now), '5d');
  assert.equal(age('2026-11-18T12:05:00Z', now), '0m');
});
