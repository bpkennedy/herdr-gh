'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fakeCli, SKIP_FAKE_CLI } = require('./helpers/fake');

const test = (name, fn) => nodeTest(name, { skip: SKIP_FAKE_CLI }, fn);

const OPEN_JS = path.join(__dirname, '..', 'bin', 'open.js');
const PLUGIN_ID = 'bpkennedy.herdr-gh';

const paneList = (panes) => ({ match: '^pane list$', stdout: { result: { panes } } });
const editor = { pane_id: 'w1:p1', tab_id: 'w1:t1', focused: true, cwd: '/work/web' };
const sidebar = { pane_id: 'w1:p2', tab_id: 'w1:t1', focused: false, label: 'GitHub Ops', cwd: '/work/web' };
const ok = { match: '.', stdout: { result: { type: 'ok' } } };
const opened = { match: '^plugin pane open .*--placement split', stdout: { result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } } };

function runOpen(responses, { args = [], paneId = 'w1:p1' } = {}) {
  const herdr = fakeCli('herdr', responses);
  const result = spawnSync(process.execPath, [OPEN_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...herdr.env, HERDR_BIN_PATH: herdr.bin, HERDR_PLUGIN_ID: PLUGIN_ID, HERDR_PANE_ID: paneId },
  });
  return { ...result, calls: herdr.calls() };
}

test('opens a right sidebar beside the focused pane, in its folder, then narrows it', () => {
  const { status, calls } = runOpen([paneList([editor]), opened, ok]);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ['pane', 'list'],
    ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'dashboard', '--placement', 'split', '--direction', 'right', '--target-pane', 'w1:p1', '--cwd', '/work/web'],
    ['pane', 'resize', '--pane', 'w1:p9', '--direction', 'right', '--amount', '0.15'],
  ]);
});

test('closes the sidebar when one is already open in the same tab', () => {
  const { status, calls } = runOpen([paneList([editor, sidebar]), ok]);
  assert.equal(status, 0);
  assert.deepEqual(calls, [['pane', 'list'], ['plugin', 'pane', 'close', 'w1:p2']]);
});

test('a sidebar in another tab does not count', () => {
  const otherTab = { ...sidebar, pane_id: 'w1:p7', tab_id: 'w1:t2' };
  const { calls } = runOpen([paneList([editor, otherTab]), opened, ok]);
  assert.equal(calls[1][2], 'open');
});

test('falls back to the focused pane when HERDR_PANE_ID is missing', () => {
  const { calls } = runOpen([paneList([editor]), opened, ok], { paneId: '' });
  assert.ok(calls[1].includes('w1:p1'));
});

test('fails with a clear message when there is no focused pane', () => {
  const { status, stderr, calls } = runOpen([paneList([{ ...editor, focused: false }])], { paneId: '' });
  assert.equal(status, 1);
  assert.match(stderr, /No focused pane/);
  assert.equal(calls.length, 1);
});

test('reports Herdr errors instead of crashing with a stack trace', () => {
  const { status, stderr } = runOpen([{ match: '.', stdout: { error: { code: 'invalid_params', message: 'nope' } } }]);
  assert.equal(status, 1);
  assert.equal(stderr, 'herdr-gh: nope\n');
});

test('--popup opens the popup entrypoint', () => {
  const { status, calls } = runOpen([ok], { args: ['--popup'] });
  assert.equal(status, 0);
  assert.deepEqual(calls, [['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'dashboard']]);
});
