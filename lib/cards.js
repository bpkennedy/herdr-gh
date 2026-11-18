'use strict';

// Turns PRs, CI runs and alerts into "cards": arrays of lines of segments.

const { green, red, yellow, magenta, cyan, dim, bold } = require('./ansi');
const { plain, seg, wrapChips, age } = require('./text');

const CHECK = {
  fail: { icon: '✗', paint: red },
  pending: { icon: '●', paint: yellow },
  pass: { icon: '✓', paint: green },
  skip: { icon: '⊘', paint: dim },
  none: { icon: '·', paint: dim },
};
const REVIEW = {
  APPROVED: { text: 'approved', paint: green },
  CHANGES_REQUESTED: { text: 'changes requested', paint: red },
  REVIEW_REQUIRED: { text: 'review required', paint: yellow },
  '': { text: 'no review needed', paint: dim },
};
const SEVERITY_PAINT = { critical: magenta, high: red, medium: yellow, low: dim };
const SUCCESSFUL_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

// Completed without succeeding: failed, cancelled, timed out, ... — the runs
// `gh run rerun --failed` can act on.
const isFailedRun = (run) => run.status === 'completed' && !SUCCESSFUL_CONCLUSIONS.has(run.conclusion);

function runState(run) {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success') return 'pass';
  return isFailedRun(run) ? 'fail' : 'skip';
}

function prCard(pr, width, now) {
  const overall = CHECK[pr.checkState];
  const review = REVIEW[pr.review] || { text: pr.review.toLowerCase(), paint: dim };
  const count = (state) => pr.checks.filter((c) => c.state === state).length;
  const chips = [
    ...pr.checks
      .filter((c) => c.state === 'fail' || c.state === 'pending')
      .map((c) => seg(`${CHECK[c.state].icon} ${c.name}`, CHECK[c.state].paint)),
    ...(count('pass') ? [seg(`✓ ${count('pass')} passed`, green)] : []),
    ...(count('skip') ? [seg(`⊘ ${count('skip')} skipped`, dim)] : []),
  ];
  return [
    [seg(`${overall.icon} `, overall.paint), seg(`#${pr.number} `, cyan), seg(`${pr.isDraft ? '[draft] ' : ''}${pr.title}`, bold)],
    [
      seg('  '),
      seg(review.text, review.paint),
      seg(` · ${pr.author}`, dim),
      seg(pr.comments ? ` · ✎${pr.comments}` : '', dim),
      seg(` · ${age(pr.updatedAt, now)}`, dim),
    ],
    ...(chips.length ? wrapChips(chips, width, '  ') : [[seg('  no checks', dim)]]),
  ];
}

function runCard(run, width, now) {
  const state = CHECK[runState(run)];
  return [
    [seg(`${state.icon} `, state.paint), seg(run.workflow, bold), seg(` · ${run.branch}`, dim)],
    [seg(`  ${age(run.createdAt, now)} `, dim), seg(run.title)],
  ];
}

function alertCard(alert) {
  return [
    [
      seg(`${alert.severity} `, SEVERITY_PAINT[alert.severity] || plain),
      seg(alert.pkg, bold),
      alert.fixedIn ? seg(` → ${alert.fixedIn}`, green) : seg(' no fix yet', dim),
    ],
    [seg(`  ${alert.ghsa} `, dim), seg(alert.summary)],
  ];
}

module.exports = { isFailedRun, prCard, runCard, alertCard };
