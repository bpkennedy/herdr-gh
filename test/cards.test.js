'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFailedRun, prCard, runCard, alertCard } = require('../lib/cards');
const { renderLine, displayWidth } = require('../lib/text');
const { stripAnsi } = require('./helpers/fake');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const cardText = (card, width) => card.map((line) => stripAnsi(renderLine(line, width)));

const pr = (overrides = {}) => ({
  number: 95,
  title: 'chore(deps): bump the major-updates group',
  author: 'app/dependabot',
  isDependabot: true,
  isDraft: false,
  review: 'REVIEW_REQUIRED',
  checks: [],
  checkState: 'none',
  comments: 0,
  updatedAt: '2026-11-13T12:00:00Z',
  ...overrides,
});

test('isFailedRun: finished and not successful, including cancelled', () => {
  const run = (status, conclusion) => ({ status, conclusion });
  assert.equal(isFailedRun(run('completed', 'failure')), true);
  assert.equal(isFailedRun(run('completed', 'cancelled')), true);
  assert.equal(isFailedRun(run('completed', 'timed_out')), true);
  assert.equal(isFailedRun(run('completed', 'success')), false);
  assert.equal(isFailedRun(run('completed', 'skipped')), false);
  assert.equal(isFailedRun(run('in_progress', '')), false);
});

test('prCard names failing and pending checks and counts the rest', () => {
  const card = prCard(
    pr({
      checkState: 'fail',
      comments: 2,
      checks: [
        { name: 'build-test', state: 'fail' },
        { name: 'e2e', state: 'pending' },
        { name: 'lint', state: 'pass' },
        { name: 'types', state: 'pass' },
        { name: 'deploy', state: 'skip' },
      ],
    }),
    60,
    NOW,
  );
  assert.deepEqual(cardText(card, 60), [
    '✗ #95 chore(deps): bump the major-updates group',
    '  review required · app/dependabot · ✎2 · 5d',
    '  ✗ build-test  ● e2e  ✓ 2 passed  ⊘ 1 skipped',
  ]);
});

test('prCard says when a PR has no checks and marks drafts', () => {
  const lines = cardText(prCard(pr({ isDraft: true, review: '' }), 60, NOW), 60);
  assert.equal(lines[0], '· #95 [draft] chore(deps): bump the major-updates group');
  assert.equal(lines[1], '  no review needed · app/dependabot · 5d');
  assert.equal(lines[2], '  no checks');
});

test('cards stay within a narrow sidebar width', () => {
  const width = 30;
  const cards = [
    prCard(pr({ checkState: 'fail', checks: [{ name: 'a-very-long-check-name-that-overflows', state: 'fail' }] }), width, NOW),
    runCard({ status: 'completed', conclusion: 'failure', workflow: 'Basic PR Validation', branch: 'dependabot/npm/x', title: 'chore: 🚀 bump', createdAt: '2026-11-18T10:00:00Z' }, width, NOW),
    alertCard({ severity: 'high', pkg: 'composer/phpoffice/phpspreadsheet', fixedIn: '5.10.0', ghsa: 'GHSA-j2w7-387v-m2rq', summary: 'PhpSpreadsheet DoS' }),
  ];
  for (const card of cards) {
    for (const line of cardText(card, width)) assert.ok(displayWidth(line) <= width, line);
  }
});

test('runCard and alertCard show the key facts', () => {
  const run = { status: 'completed', conclusion: 'failure', workflow: 'CI', branch: 'main', title: 'Merge #29', createdAt: '2026-11-16T12:00:00Z' };
  assert.deepEqual(cardText(runCard(run, 60, NOW), 60), ['✗ CI · main', '  2d Merge #29']);
  const alert = { severity: 'medium', pkg: 'npm/glob', fixedIn: '', ghsa: 'GHSA-3g3m', summary: 'Glob issue' };
  assert.deepEqual(cardText(alertCard(alert), 60), ['medium npm/glob no fix yet', '  GHSA-3g3m Glob issue']);
});
