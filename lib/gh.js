'use strict';

// Thin data layer over the `gh` CLI. gh owns auth, hosts and tokens, so this
// plugin never touches credentials.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const PR_LIMIT = 100;
const PER_PAGE = 100;

const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot[bot]', 'dependabot']);
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE']);
const CHECK_ORDER = { fail: 0, pending: 1, pass: 2, skip: 3 };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: MAX_BUFFER_BYTES });
  return stdout;
}

async function ghJson(args) {
  return JSON.parse(await gh(args));
}

// For `gh api --paginate --jq '.[]'`, which prints one JSON value per line.
async function ghJsonLines(args) {
  return (await gh(args))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function errorMessage(err) {
  const stderr = String(err.stderr || '').trim();
  return (stderr || err.message || String(err)).split('\n')[0];
}

const isNotFound = (err) => /HTTP 404/.test(errorMessage(err));

let ownersPromise;

// The signed-in user plus all their orgs. Cached for the process; a failure
// (not logged in yet, offline) is not cached so the next lookup retries.
function ownLogins() {
  ownersPromise ??= Promise.all([
    gh(['api', 'user', '--jq', '.login']),
    gh(['api', '--paginate', 'user/orgs', '--jq', '.[].login']),
  ])
    .then((outputs) => outputs.join('\n').split('\n').filter(Boolean))
    .catch((err) => {
      ownersPromise = undefined;
      throw err;
    });
  return ownersPromise;
}

// Repos named exactly `name` owned by the user or one of their orgs: originals
// before forks, then most recently pushed first.
async function findReposByName(name) {
  const owners = await ownLogins();
  const lookups = await Promise.allSettled(
    owners.map((owner) => ghJson(['api', `repos/${owner}/${encodeURIComponent(name)}`])),
  );
  const found = lookups.filter((l) => l.status === 'fulfilled').map((l) => l.value);
  const realError = lookups.find((l) => l.status === 'rejected' && !isNotFound(l.reason));
  if (found.length === 0 && realError) throw realError.reason;
  return found
    .sort((a, b) => Number(a.fork) - Number(b.fork) || String(b.pushed_at).localeCompare(String(a.pushed_at)))
    .map((repo) => repo.full_name);
}

// One entry of statusCheckRollup (a CheckRun or a StatusContext) → 'fail' | 'pending' | 'pass' | 'skip'.
function checkState(check) {
  const conclusion = String(check.conclusion || check.state || '').toUpperCase();
  const status = String(check.status || '').toUpperCase();
  if (FAILED.has(conclusion)) return 'fail';
  if (PENDING.has(conclusion) || (status && status !== 'COMPLETED')) return 'pending';
  if (SKIPPED.has(conclusion)) return 'skip';
  return 'pass';
}

function overallState(checks) {
  if (checks.length === 0) return 'none';
  return ['fail', 'pending'].find((state) => checks.some((c) => c.state === state)) || 'pass';
}

function toPr(pr) {
  const checks = (pr.statusCheckRollup || [])
    .map((check) => ({ name: check.name || check.context || '?', state: checkState(check) }))
    .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author?.login || '',
    isDependabot: DEPENDABOT_LOGINS.has(pr.author?.login),
    isDraft: pr.isDraft,
    url: pr.url,
    headSha: pr.headRefOid,
    review: pr.reviewDecision || '',
    checks,
    checkState: overallState(checks),
    comments: pr.comments?.length || 0,
    updatedAt: pr.updatedAt,
  };
}

async function fetchPrs(repo) {
  const fields = 'number,title,author,url,isDraft,headRefOid,reviewDecision,statusCheckRollup,comments,updatedAt';
  const prs = await ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', String(PR_LIMIT), '--json', fields]);
  return prs.map(toPr).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function fetchRuns(repo, limit) {
  const fields = 'databaseId,displayTitle,workflowName,headBranch,status,conclusion,createdAt,url';
  const runs = await ghJson(['run', 'list', '-R', repo, '--limit', String(limit), '--json', fields]);
  return runs.map((run) => ({
    id: run.databaseId,
    title: run.displayTitle,
    workflow: run.workflowName,
    branch: run.headBranch,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    createdAt: run.createdAt,
  }));
}

async function fetchAlerts(repo) {
  const alerts = await ghJsonLines(['api', '--paginate', `repos/${repo}/dependabot/alerts?state=open&per_page=${PER_PAGE}`, '--jq', '.[]']);
  const rank = (alert) => SEVERITY_RANK[alert.severity] ?? Object.keys(SEVERITY_RANK).length;
  return alerts
    .map((alert) => ({
      number: alert.number,
      ghsa: alert.security_advisory?.ghsa_id || '',
      severity: alert.security_advisory?.severity || 'unknown',
      summary: alert.security_advisory?.summary || '',
      pkg: `${alert.dependency?.package?.ecosystem || '?'}/${alert.dependency?.package?.name || '?'}`,
      fixedIn: alert.security_vulnerability?.first_patched_version?.identifier || '',
      url: alert.html_url,
    }))
    .sort((a, b) => rank(a) - rank(b));
}

// Approve and merge are pinned to the head commit the user was looking at, so a
// push that lands in the meantime is never approved or merged unseen.
const approvePr = (repo, number, headSha) =>
  gh(['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${headSha}`]);
const mergePr = (repo, number, method, headSha) =>
  gh(['pr', 'merge', String(number), '-R', repo, `--${method}`, '--match-head-commit', headSha]);
const commentPr = (repo, number, body) => gh(['pr', 'comment', String(number), '-R', repo, '--body', body]);
const rerunFailedJobs = (repo, runId) => gh(['run', 'rerun', String(runId), '-R', repo, '--failed']);

// True for the error fetchAlerts gets from a repo whose Dependabot alerts are off.
const alertsDisabled = (message) => /Dependabot alerts are disabled/i.test(message || '');

// Security updates (PRs that fix alerts) depend on alerts, so alerts are turned on first.
async function enableDependabot(repo, securityUpdates) {
  await gh(['api', '-X', 'PUT', `repos/${repo}/vulnerability-alerts`]);
  if (securityUpdates) await gh(['api', '-X', 'PUT', `repos/${repo}/automated-security-fixes`]);
}

module.exports = {
  findReposByName,
  checkState,
  overallState,
  fetchPrs,
  fetchRuns,
  fetchAlerts,
  approvePr,
  mergePr,
  commentPr,
  rerunFailedJobs,
  alertsDisabled,
  enableDependabot,
  errorMessage,
};
