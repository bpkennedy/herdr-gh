'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, loadConfig } = require('../bin/dashboard');
const { displayWidth } = require('../lib/text');
const { deferred, stripAnsi } = require('./helpers/fake');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const CONFIG = { refresh_seconds: 120, merge_method: 'squash', run_limit: 20 };

const pr = (number, overrides = {}) => ({
  number,
  title: `PR ${number}`,
  author: 'alice',
  isDependabot: false,
  isDraft: false,
  url: `https://github.com/acme/web/pull/${number}`,
  headSha: `sha${number}`,
  review: 'REVIEW_REQUIRED',
  checks: [{ name: 'build', state: 'pass' }],
  checkState: 'pass',
  comments: 0,
  updatedAt: '2026-11-17T00:00:00Z',
  ...overrides,
});
const run = (id, conclusion) => ({ id, workflow: 'CI', branch: 'main', title: `run ${id}`, status: 'completed', conclusion, url: `u${id}`, createdAt: '2026-11-17T00:00:00Z' });

// Builds an app wired to fakes. `data` is read on every fetch, so tests can change it between refreshes.
function setup({ space = 'web', repos = { web: ['acme/web'] }, columns = 60, rows = 30 } = {}) {
  const calls = [];
  const data = { prs: [pr(1), pr(2)], runs: [run(10, 'failure'), run(11, 'success')], alerts: [] };
  const value = (v, repo) => (typeof v === 'function' ? v(repo) : v);
  const gh = {
    findReposByName: async (name) => {
      calls.push(['find', name]);
      return repos[name] || [];
    },
    fetchPrs: async (repo) => value(data.prs, repo),
    fetchRuns: async (repo) => value(data.runs, repo),
    fetchAlerts: async (repo) => value(data.alerts, repo),
    approvePr: async (...args) => calls.push(['approve', ...args]),
    mergePr: async (...args) => calls.push(['merge', ...args]),
    commentPr: async (...args) => calls.push(['comment', ...args]),
    rerunFailedJobs: async (...args) => calls.push(['rerun', ...args]),
    errorMessage: (err) => err.message,
  };
  const herdr = { label: space, error: null };
  const currentSpace = async () => {
    if (herdr.error) throw herdr.error;
    return { label: herdr.label };
  };
  const frames = [];
  const terminal = {
    columns: () => columns,
    rows: () => rows,
    write: (text) => frames.push(text),
    page: (args) => calls.push(['page', ...args]),
    openUrl: (url, onError) => (terminal.openError ? onError(terminal.openError) : calls.push(['open', url])),
    quit: () => calls.push(['quit']),
    openError: null,
  };
  const app = createApp({ gh, currentSpace, config: CONFIG, terminal, now: () => NOW });
  const screen = () =>
    stripAnsi(frames[frames.length - 1].replace(/^\x1b\[H/, ''))
      .split('\r\n')
      .map((line) => line.replace(/\x1b\[[KJ]/g, ''));
  return { app, calls, data, herdr, gh, terminal, screen, frames, actionCalls: () => calls.filter(([name]) => name !== 'find') };
}

test('looks up the repo named after the Space and lists its PRs with checks', async () => {
  const t = setup();
  await t.app.watchSpace();
  assert.deepEqual(t.calls, [['find', 'web']]);
  assert.equal(t.app.getState().repo, 'acme/web');
  const screen = t.screen().join('\n');
  assert.match(screen, /acme\/web/);
  assert.match(screen, /✓ #1 PR 1/);
  assert.match(screen, /✓ 1 passed/);
});

test('switches repo when the Space name changes', async () => {
  const t = setup({ repos: { web: ['acme/web'], api: ['acme/api'] } });
  await t.app.watchSpace();
  t.data.prs = (repo) => (repo === 'acme/api' ? [pr(50)] : [pr(1)]);
  t.herdr.label = 'api';
  await t.app.watchSpace();
  assert.equal(t.app.getState().repo, 'acme/api');
  assert.deepEqual(t.app.getState().rows[0].map((p) => p.number), [50]);
});

test('results that arrive after a Space switch are dropped and the new Space is loaded', async () => {
  const t = setup({ repos: { web: ['acme/web'], api: ['acme/api'] } });
  const slowWeb = deferred();
  t.data.prs = (repo) => (repo === 'acme/web' ? slowWeb.promise : [pr(50)]);
  const firstLoad = t.app.watchSpace();
  await new Promise(setImmediate);
  t.herdr.label = 'api';
  await t.app.watchSpace();
  const framesAfterSwitch = t.frames.length;
  slowWeb.resolve([pr(1)]);
  await firstLoad;
  const shown = t.frames.slice(framesAfterSwitch).map(stripAnsi).join('\n');
  assert.doesNotMatch(shown, /PR 1/, 'the old Space\'s PRs never appear under the new Space');
  assert.equal(t.app.getState().repo, 'acme/api');
  assert.deepEqual(t.app.getState().rows[0].map((p) => p.number), [50]);
});

test('a Space with no matching repo shows a notice and blocks row actions', async () => {
  const t = setup({ space: 'Projects' });
  await t.app.watchSpace();
  assert.match(t.screen().join(' '), /No GitHub repo named "Projects"/);
  await t.app.handleInput('a');
  assert.equal(t.app.getState().confirm, null);
});

test('a transient Herdr error clears on the next good poll', async () => {
  const t = setup();
  await t.app.watchSpace();
  t.herdr.error = new Error('socket closed');
  await t.app.watchSpace();
  assert.match(t.screen().join(' '), /Could not read the current Space/);
  await t.app.handleInput('a');
  assert.equal(t.app.getState().confirm, null, 'no actions while the list is hidden');
  t.herdr.error = null;
  await t.app.watchSpace();
  assert.equal(t.app.getState().notice, null);
  assert.match(t.screen().join('\n'), /#1 PR 1/);
});

test('does not search GitHub when the Space is unknown', async () => {
  const t = setup();
  t.herdr.error = new Error('herdr not running');
  await t.app.watchSpace();
  await t.app.refresh();
  assert.deepEqual(t.calls, []);
});

test('selection follows the same PR when a refresh re-sorts the list', async () => {
  const t = setup();
  await t.app.watchSpace();
  await t.app.handleInput('j'); // select #2
  t.data.prs = [pr(3), pr(2), pr(1)]; // a new PR arrives on top
  await t.app.refresh();
  await t.app.handleInput('a');
  assert.match(t.app.getState().confirm.prompt, /approve #2 PR 2/);
  await t.app.handleInput('y');
  assert.deepEqual(t.actionCalls(), [['approve', 'acme/web', 2, 'sha2']]);
});

test('merge confirms first and passes method and head SHA; anything but y cancels', async () => {
  const t = setup();
  await t.app.watchSpace();
  await t.app.handleInput('m');
  assert.match(t.app.getState().confirm.prompt, /squash merge #1 PR 1/);
  await t.app.handleInput('n');
  assert.deepEqual(t.actionCalls(), []);
  await t.app.handleInput('m');
  await t.app.handleInput('y');
  assert.deepEqual(t.actionCalls(), [['merge', 'acme/web', 1, 'squash', 'sha1']]);
  assert.match(t.screen().at(-1), /Merge #1 ✓/);
});

test('a failed action reports the error and refreshes', async () => {
  const t = setup();
  await t.app.watchSpace();
  t.gh.mergePr = async () => {
    throw new Error('Pull request is not mergeable');
  };
  await t.app.handleInput('m');
  await t.app.handleInput('y');
  assert.match(t.screen().at(-1), /Merge #1 failed: Pull request is not mergeable/);
});

test('a second action is refused while the first is still running', async () => {
  const t = setup();
  await t.app.watchSpace();
  const slowApprove = deferred();
  t.gh.approvePr = () => slowApprove.promise;
  await t.app.handleInput('a');
  const approving = t.app.handleInput('y');
  await t.app.handleInput('m');
  assert.equal(t.app.getState().confirm, null);
  assert.match(t.screen().at(-1), /Still working/);
  slowApprove.resolve();
  await approving;
});

test('@dependabot rebase is only offered on Dependabot PRs', async () => {
  const t = setup();
  t.data.prs = [pr(1), pr(2, { isDependabot: true, author: 'app/dependabot' })];
  await t.app.watchSpace();
  await t.app.handleInput('b');
  assert.equal(t.app.getState().confirm, null);
  await t.app.handleInput('jb');
  await t.app.handleInput('y');
  assert.deepEqual(t.actionCalls(), [['comment', 'acme/web', 2, '@dependabot rebase']]);
});

test('CI: enter shows the failed log, R reruns only unsuccessful runs', async () => {
  const t = setup();
  await t.app.watchSpace();
  await t.app.handleInput('2');
  await t.app.handleInput('\r');
  assert.deepEqual(t.actionCalls().at(-1), ['page', 'run', 'view', '10', '-R', 'acme/web', '--log-failed']);
  await t.app.handleInput('jR'); // successful run
  assert.equal(t.app.getState().confirm, null);
  await t.app.handleInput('kR');
  assert.match(t.app.getState().confirm.prompt, /run 10/);
  await t.app.handleInput('y');
  assert.deepEqual(t.actionCalls().at(-1), ['rerun', 'acme/web', 10]);
});

test('a refresh requested during another refresh is queued, not dropped', async () => {
  const t = setup();
  await t.app.watchSpace();
  const slow = deferred();
  t.data.prs = () => slow.promise;
  const first = t.app.refresh();
  await new Promise(setImmediate);
  t.app.refresh(); // e.g. the refresh after a merge
  t.data.prs = [pr(9)];
  slow.resolve([pr(1)]);
  await first;
  assert.deepEqual(t.app.getState().rows[0].map((p) => p.number), [9]);
});

test('a browser that cannot be launched shows a message instead of crashing', async () => {
  const t = setup();
  await t.app.watchSpace();
  t.terminal.openError = new Error('spawn xdg-open ENOENT');
  await t.app.handleInput('o');
  assert.match(t.screen().at(-1), /Could not open browser: spawn xdg-open ENOENT/);
});

test('several keys in one input chunk are all handled', async () => {
  const t = setup();
  t.data.prs = [pr(1), pr(2), pr(3)];
  await t.app.watchSpace();
  await t.app.handleInput('jj\x1b[A');
  assert.equal(t.app.getState().selected[0], 2);
  await t.app.handleInput('q');
  assert.deepEqual(t.actionCalls().at(-1), ['quit']);
});

test('every frame fits the terminal, from a sidebar down to a tiny pane', async () => {
  for (const [columns, rows] of [[40, 30], [24, 8], [3, 2]]) {
    const t = setup({ columns, rows });
    t.data.prs = [pr(1, { title: '🚀 漢字 a very long title that will not fit', checkState: 'fail', checks: [{ name: 'x'.repeat(80), state: 'fail' }] })];
    await t.app.watchSpace();
    for (const key of ['', '2', '3', '?']) {
      await t.app.handleInput(key || '1');
      const screen = t.screen();
      assert.ok(screen.length <= rows, `${columns}x${rows}: ${screen.length} lines`);
      for (const line of screen) assert.ok(displayWidth(line) < Math.max(columns, 2), `${columns}x${rows}: "${line}"`);
      if (key === '?') await t.app.handleInput('x');
    }
  }
});

test('loadConfig writes defaults and rejects bad values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-gh-config-'));
  const file = path.join(dir, 'config.json');
  assert.deepEqual(loadConfig(file), CONFIG);
  fs.writeFileSync(file, JSON.stringify({ merge_method: 'yolo' }));
  assert.throws(() => loadConfig(file), /merge_method/);
  fs.writeFileSync(file, JSON.stringify({ run_limit: -1 }));
  assert.throws(() => loadConfig(file), /run_limit/);
  fs.writeFileSync(file, JSON.stringify({ refresh_seconds: 1 }));
  assert.equal(loadConfig(file).refresh_seconds, 30);
});
