'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const { withFakeGh, SKIP_FAKE_CLI } = require('./helpers/fake');

const test = (name, fn) => nodeTest(name, { skip: SKIP_FAKE_CLI }, fn);

const OWNERS = [
  { match: '^api user --jq', stdout: 'me\n' },
  { match: '^api --paginate user/orgs', stdout: 'acme\nother\n' },
];
const notFound = (repo) => ({ match: `^api repos/${repo}$`, stderr: 'gh: Not Found (HTTP 404)\n', code: 1 });

test('checkState and overallState cover CheckRuns and StatusContexts', () => {
  const { gh } = withFakeGh([]);
  const cases = [
    [{ status: 'COMPLETED', conclusion: 'FAILURE' }, 'fail'],
    [{ status: 'COMPLETED', conclusion: 'CANCELLED' }, 'fail'],
    [{ status: 'IN_PROGRESS', conclusion: null }, 'pending'],
    [{ status: 'QUEUED', conclusion: '' }, 'pending'],
    [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, 'pass'],
    [{ status: 'COMPLETED', conclusion: 'SKIPPED' }, 'skip'],
    [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }, 'skip'],
    [{ state: 'ERROR' }, 'fail'],
    [{ state: 'PENDING' }, 'pending'],
    [{ state: 'SUCCESS' }, 'pass'],
  ];
  for (const [check, expected] of cases) assert.equal(gh.checkState(check), expected, JSON.stringify(check));
  assert.equal(gh.overallState([]), 'none');
  assert.equal(gh.overallState([{ state: 'pass' }, { state: 'pending' }]), 'pending');
  assert.equal(gh.overallState([{ state: 'pending' }, { state: 'fail' }]), 'fail');
  assert.equal(gh.overallState([{ state: 'pass' }, { state: 'skip' }]), 'pass');
});

test('findReposByName checks each owner exactly and prefers originals over forks', async () => {
  const { gh, fake } = withFakeGh([
    ...OWNERS,
    { match: '^api repos/me/web$', stdout: { full_name: 'me/web', fork: true, pushed_at: '2026-11-18T00:00:00Z' } },
    { match: '^api repos/acme/web$', stdout: { full_name: 'acme/web', fork: false, pushed_at: '2026-01-01T00:00:00Z' } },
    notFound('other/web'),
  ]);
  assert.deepEqual(await gh.findReposByName('web'), ['acme/web', 'me/web']);
  const lookups = fake.calls().filter((args) => args[1]?.startsWith('repos/'));
  assert.deepEqual(lookups.map((args) => args[1]).sort(), ['repos/acme/web', 'repos/me/web', 'repos/other/web']);
});

test('findReposByName returns [] when every owner says 404', async () => {
  const { gh } = withFakeGh([...OWNERS, notFound('me/nope'), notFound('acme/nope'), notFound('other/nope')]);
  assert.deepEqual(await gh.findReposByName('nope'), []);
});

test('findReposByName surfaces a real error when nothing was found', async () => {
  const { gh } = withFakeGh([
    ...OWNERS,
    { match: '^api repos/', stderr: 'gh: Bad credentials (HTTP 401)\n', code: 1 },
  ]);
  await assert.rejects(gh.findReposByName('web'), (err) => /HTTP 401/.test(gh.errorMessage(err)));
});

test('a failed owner lookup is retried instead of cached', async () => {
  const { gh, fake } = withFakeGh([{ match: '^api user', stderr: 'gh auth login required\n', code: 4 }]);
  await assert.rejects(gh.findReposByName('web'));
  fake.setResponses([...OWNERS, { match: '^api repos/acme/web$', stdout: { full_name: 'acme/web', fork: false } }, { match: '^api repos/', stderr: 'gh: Not Found (HTTP 404)\n', code: 1 }]);
  assert.deepEqual(await gh.findReposByName('web'), ['acme/web']);
});

test('fetchPrs maps fields, carries the head SHA and sorts newest first', async () => {
  const { gh, fake } = withFakeGh([
    {
      match: '^pr list -R acme/web',
      stdout: [
        { number: 1, title: 'old', author: { login: 'alice' }, headRefOid: 'aaa', updatedAt: '2026-11-01T00:00:00Z', statusCheckRollup: [], comments: [] },
        {
          number: 2,
          title: 'new',
          author: { login: 'app/dependabot' },
          headRefOid: 'bbb',
          reviewDecision: 'APPROVED',
          updatedAt: '2026-11-10T00:00:00Z',
          statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'ci/legacy', state: 'FAILURE' }],
          comments: [{}, {}],
        },
      ],
    },
  ]);
  const prs = await gh.fetchPrs('acme/web');
  assert.deepEqual(prs.map((pr) => pr.number), [2, 1]);
  assert.equal(prs[0].headSha, 'bbb');
  assert.equal(prs[0].isDependabot, true);
  assert.equal(prs[0].checkState, 'fail');
  assert.deepEqual(prs[0].checks, [{ name: 'ci/legacy', state: 'fail' }, { name: 'lint', state: 'pass' }]);
  assert.equal(prs[0].comments, 2);
  assert.equal(prs[1].checkState, 'none');
  assert.match(fake.calls()[0].join(' '), /--json .*headRefOid/);
});

test('fetchAlerts reads every page and sorts by severity', async () => {
  const alert = (number, severity) =>
    JSON.stringify({ number, html_url: `u${number}`, security_advisory: { ghsa_id: `G${number}`, severity, summary: 's' }, dependency: { package: { ecosystem: 'npm', name: 'x' } } });
  const { gh, fake } = withFakeGh([{ match: '^api --paginate repos/acme/web/dependabot/alerts', stdout: `${alert(1, 'low')}\n${alert(2, 'critical')}\n${alert(3, 'high')}\n` }]);
  const alerts = await gh.fetchAlerts('acme/web');
  assert.deepEqual(alerts.map((a) => a.severity), ['critical', 'high', 'low']);
  assert.deepEqual(fake.calls()[0].slice(-2), ['--jq', '.[]']);
});

test('approve and merge are pinned to the head commit the user saw', async () => {
  const { gh, fake } = withFakeGh([{ match: '.', stdout: '' }]);
  await gh.approvePr('acme/web', 7, 'abc123');
  await gh.mergePr('acme/web', 7, 'squash', 'abc123');
  const [approve, merge] = fake.calls();
  assert.deepEqual(approve, ['api', '-X', 'POST', 'repos/acme/web/pulls/7/reviews', '-f', 'event=APPROVE', '-f', 'commit_id=abc123']);
  assert.deepEqual(merge, ['pr', 'merge', '7', '-R', 'acme/web', '--squash', '--match-head-commit', 'abc123']);
});

test('comment and rerun pass the right arguments', async () => {
  const { gh, fake } = withFakeGh([{ match: '.', stdout: '' }]);
  await gh.commentPr('acme/web', 7, '@dependabot rebase');
  await gh.rerunFailedJobs('acme/web', 99);
  assert.deepEqual(fake.calls(), [
    ['pr', 'comment', '7', '-R', 'acme/web', '--body', '@dependabot rebase'],
    ['run', 'rerun', '99', '-R', 'acme/web', '--failed'],
  ]);
});

test('enableDependabot turns on alerts, then security updates only when asked', async () => {
  const { gh, fake } = withFakeGh([{ match: '.', stdout: '' }]);
  await gh.enableDependabot('acme/web', false);
  await gh.enableDependabot('acme/web', true);
  assert.deepEqual(fake.calls(), [
    ['api', '-X', 'PUT', 'repos/acme/web/vulnerability-alerts'],
    ['api', '-X', 'PUT', 'repos/acme/web/vulnerability-alerts'],
    ['api', '-X', 'PUT', 'repos/acme/web/automated-security-fixes'],
  ]);
});

// Not `test`: this needs no fake gh, so it also runs on Windows.
nodeTest('alertsDisabled recognises only the alerts-off error', () => {
  const gh = require('../lib/gh');
  assert.equal(gh.alertsDisabled('gh: Dependabot alerts are disabled for this repository. (HTTP 403)'), true);
  assert.equal(gh.alertsDisabled('gh: Dependabot alerts are disabled for this repository. (HTTP 403)\r'), true, 'Windows line ending');
  assert.equal(gh.alertsDisabled('gh: Resource not accessible by integration (HTTP 403)'), false);
  assert.equal(gh.alertsDisabled(null), false);
});

test('errorMessage prefers the first line of stderr', () => {
  const { gh } = withFakeGh([]);
  assert.equal(gh.errorMessage({ stderr: 'gh: Not Found (HTTP 404)\nmore', message: 'Command failed' }), 'gh: Not Found (HTTP 404)');
  assert.equal(gh.errorMessage(new Error('boom')), 'boom');
});
