#!/usr/bin/env node
'use strict';

// GitHub Ops panel for the GitHub repo named after the current Herdr Space.
// Tabs: open PRs (with their checks), recent CI runs, open Dependabot (GHSA) alerts.
// Items are stacked cards so it reads well in a narrow sidebar and in a popup.
// Run outside Herdr with `node bin/dashboard.js owner/repo`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const gh = require('../lib/gh');
const { currentSpace } = require('../lib/herdr');
const { ESC, green, red, yellow, cyan, dim, bold, inverse } = require('../lib/ansi');
const { seg, renderLine, wrapText } = require('../lib/text');
const { isFailedRun, prCard, runCard, alertCard } = require('../lib/cards');

const MIN_NODE_MAJOR = 22;
const DEFAULT_CONFIG = { refresh_seconds: 120, merge_method: 'merge', run_limit: 20 };
const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const MIN_REFRESH_SECONDS = 30;
const MAX_RUN_LIMIT = 100;
const SPACE_POLL_MS = 2000;
const HEADER_LINES = 3;
const FOOTER_LINES = 1;
const GUTTER = 2;
const PAGE_STEP = 5;
const VULNS_TAB = 2;
const IS_WINDOWS = process.platform === 'win32';
const PAGER_MAX_BUFFER_BYTES = 64 * 1024 * 1024; // failed-job logs can be large
// rundll32 rather than `cmd /c start`, which would treat & in URLs as a command separator.
const BROWSER_OPENER = {
  darwin: ['open'],
  linux: ['xdg-open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
};

const KEY = {
  up: ['\x1b[A', '\x1bOA', 'k'],
  down: ['\x1b[B', '\x1bOB', 'j'],
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  shiftTab: '\x1b[Z',
  escape: '\x1b',
  ctrlC: '\x03',
  enter: '\r',
  tab: '\t',
};
// One token per key press: CSI/SS3 escape sequences, a lone ESC, or one character.
const KEY_TOKEN = /\x1b\[[0-9;?]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;

// ---------------------------------------------------------------- config

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  const config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  if (!MERGE_METHODS.includes(config.merge_method)) {
    throw new Error(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  }
  const runLimit = Number(config.run_limit);
  if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > MAX_RUN_LIMIT) {
    throw new Error(`run_limit must be a whole number from 1 to ${MAX_RUN_LIMIT}`);
  }
  return {
    ...config,
    run_limit: runLimit,
    refresh_seconds: Math.max(MIN_REFRESH_SECONDS, Number(config.refresh_seconds) || 0),
  };
}

// ---------------------------------------------------------------- app

// `deps`: { gh, currentSpace, config, repo?, terminal, now? }
// `terminal`: { columns(), rows(), write(text), page(ghArgs), openUrl(url, onError), quit() }
function createApp({ gh, currentSpace, config, repo = null, terminal, now = Date.now }) {
  const TABS = [
    {
      title: 'PRs',
      load: (r) => gh.fetchPrs(r),
      card: prCard,
      key: (pr) => pr.number,
      filter: (pr, s) => !s.dependabotOnly || pr.isDependabot,
      count: (rows) => String(rows.length),
      hint: '⏎ view · c checks · a approve · m merge',
    },
    {
      title: 'CI',
      load: (r) => gh.fetchRuns(r, config.run_limit),
      card: runCard,
      key: (run) => run.id,
      filter: (run, s) => !s.failuresOnly || isFailedRun(run),
      count: (rows) => `${rows.filter(isFailedRun).length}✗`,
      hint: '⏎ log · R rerun failed · f failures',
    },
    {
      title: 'Vulns',
      load: (r) => gh.fetchAlerts(r),
      card: alertCard,
      key: (alert) => alert.number,
      filter: () => true,
      count: (rows) => String(rows.length),
      hint: '⏎ open advisory',
    },
  ];

  const HELP = [
    ['Any tab', ''],
    ['1 2 3, tab', 'switch tab'],
    ['j k, ↑ ↓', 'move (g G top/bottom)'],
    ['r', 'refresh now'],
    ['o', 'open in browser'],
    ['q, esc', 'close'],
    ['PRs', ''],
    ['enter', 'PR and comments'],
    ['c', 'all checks'],
    ['a', 'approve'],
    ['m', `merge (${config.merge_method})`],
    ['b', '@dependabot rebase'],
    ['d', 'Dependabot PRs only'],
    ['CI', ''],
    ['enter', 'failed log or summary'],
    ['R', 'rerun failed jobs'],
    ['f', 'failures only'],
    ['Vulns', ''],
    ['enter', 'open advisory'],
    ['e', 'turn on alerts (when off)'],
  ];

  const emptyTabs = (value) => TABS.map(() => value);
  const replaceAt = (list, index, value) => list.map((item, i) => (i === index ? value : item));

  let state = {
    space: null,
    repo,
    otherMatches: 0,
    notice: null,
    tab: 0,
    rows: emptyTabs([]),
    errors: emptyTabs(null),
    selected: emptyTabs(null), // key of the selected row per tab, so re-sorts never move the selection
    scroll: emptyTabs(0),
    loading: false,
    refreshQueued: false,
    busy: false,
    updatedAt: null,
    message: null,
    confirm: null,
    help: false,
    dependabotOnly: false,
    failuresOnly: false,
  };

  function setState(patch) {
    state = { ...state, ...patch };
    render();
  }

  const visibleRows = () => state.rows[state.tab].filter((row) => TABS[state.tab].filter(row, state));

  function cursorIndex(rows) {
    const index = rows.findIndex((row) => TABS[state.tab].key(row) === state.selected[state.tab]);
    return Math.max(0, index);
  }

  const selectedRow = () => {
    const rows = visibleRows();
    return rows[cursorIndex(rows)];
  };

  const listHeight = () => Math.max(1, terminal.rows() - HEADER_LINES - FOOTER_LINES);

  const canEnableAlerts = () => state.tab === VULNS_TAB && !state.notice && gh.alertsDisabled(state.errors[VULNS_TAB]);

  // ------------------------------------------------------------ render

  function headerLines(width) {
    const time = state.updatedAt ? state.updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const status = state.loading ? seg('  refreshing…', yellow) : seg(time && `  ${time}`, dim);
    const filters = [state.dependabotOnly && 'dependabot', state.failuresOnly && 'failures'].filter(Boolean);
    const title = [
      seg(state.repo || state.space || 'herdr-gh', bold),
      seg(state.otherMatches ? ` (+${state.otherMatches} same name)` : '', dim),
      status,
      seg(filters.length ? `  only: ${filters.join(', ')}` : '', cyan),
    ];
    const tabs = TABS.flatMap((tab, i) => {
      const count = state.errors[i] ? '!' : state.repo ? tab.count(state.rows[i]) : '-';
      return [seg(` ${i + 1} ${tab.title} ${count} `, i === state.tab ? (t) => inverse(bold(t)) : undefined), seg(' ')];
    });
    return [renderLine(title, width), renderLine(tabs, width), dim('─'.repeat(width))];
  }

  function bodyLines(width) {
    if (state.help) {
      return HELP.map(([key, text]) => (text ? renderLine([seg(`  ${key.padEnd(11)} `, cyan), seg(text)], width) : bold(key)));
    }
    if (state.notice) return wrapText(state.notice.text, width, state.notice.paint).map((l) => renderLine(l, width));
    const error = state.errors[state.tab];
    if (error) {
      const offer = canEnableAlerts() ? [[], ...wrapText('Press e to turn them on (needs admin access to the repo).', width)] : [];
      return [...wrapText(error, width, red), ...offer].map((l) => renderLine(l, width));
    }

    const rows = visibleRows();
    if (rows.length === 0) return state.loading || !state.repo ? [] : [dim('Nothing to show.')];

    const cursor = cursorIndex(rows);
    const cardWidth = Math.max(1, width - GUTTER);
    const lines = rows.flatMap((row, index) => {
      const gutter = index === cursor ? cyan('▌ ') : '  ';
      const card = TABS[state.tab].card(row, cardWidth, now()).map((l) => gutter + renderLine(l, cardWidth));
      return [...card, ''].map((text) => ({ text, index }));
    });
    const height = listHeight();
    const first = lines.findIndex((l) => l.index === cursor);
    const last = lines.findLastIndex((l) => l.index === cursor);
    const scroll = Math.min(Math.max(state.scroll[state.tab], last - height + 1), first);
    state = { ...state, scroll: replaceAt(state.scroll, state.tab, scroll) };
    return lines.slice(scroll, scroll + height).map((l) => l.text);
  }

  function footerLine(width) {
    if (state.confirm) {
      const keys = state.confirm.onNo ? '[y/n/esc] ' : '[y/N] ';
      return renderLine([seg(keys, (t) => bold(yellow(t))), seg(state.confirm.prompt, yellow)], width);
    }
    if (state.message) return renderLine([seg(state.message.text, state.message.paint)], width);
    const tabHint = canEnableAlerts() ? 'e turn on alerts' : TABS[state.tab].hint;
    const hint = state.help ? 'any key to go back' : `${tabHint} · ? keys`;
    return renderLine([seg(hint, dim)], width);
  }

  function render() {
    // One spare column so a full-width line never triggers the terminal's autowrap.
    const width = Math.max(1, terminal.columns() - 1);
    const body = bodyLines(width).slice(0, listHeight());
    const padding = Array.from({ length: listHeight() - body.length }, () => '');
    const lines = [...headerLines(width), ...body, ...padding, footerLine(width)].slice(0, Math.max(1, terminal.rows()));
    terminal.write(`${ESC}H${lines.map((line) => `${line}${ESC}K`).join('\r\n')}${ESC}J`);
  }

  // ------------------------------------------------------------ data

  // → { repo, otherMatches, notice } for the repo named after `space`.
  async function findRepo(space) {
    try {
      const matches = await gh.findReposByName(space);
      if (matches.length === 0) {
        const text = `No GitHub repo named "${space}" in your account or orgs. cd into a repo, or rename this Space to the repo name, then press r.`;
        return { repo: null, otherMatches: 0, notice: { text, paint: yellow } };
      }
      return { repo: matches[0], otherMatches: matches.length - 1, notice: null };
    } catch (err) {
      return { repo: null, otherMatches: 0, notice: { text: `Could not look up "${space}": ${gh.errorMessage(err)}`, paint: red } };
    }
  }

  async function refresh(tabIndexes = TABS.map((_, i) => i)) {
    if (state.loading) {
      state = { ...state, refreshQueued: true };
      return;
    }
    if (!state.repo && !state.space) return;
    const space = state.space;
    setState({ loading: true, refreshQueued: false });
    const stale = () => state.space !== space;

    if (!state.repo) {
      setState({ notice: { text: `Looking for a GitHub repo named "${space}"…`, paint: dim } });
      const found = await findRepo(space);
      if (!stale()) setState(found);
    }
    const currentRepo = state.repo;
    if (currentRepo && !stale()) {
      const results = await Promise.allSettled(tabIndexes.map((i) => TABS[i].load(currentRepo)));
      if (!stale() && state.repo === currentRepo) {
        const resultFor = (i) => results[tabIndexes.indexOf(i)];
        state = {
          ...state,
          rows: state.rows.map((rows, i) => (resultFor(i)?.status === 'fulfilled' ? resultFor(i).value : rows)),
          errors: state.errors.map((error, i) => {
            const result = resultFor(i);
            if (!result) return error;
            return result.status === 'rejected' ? gh.errorMessage(result.reason) : null;
          }),
          updatedAt: new Date(now()),
        };
      }
    }
    const again = stale() || state.refreshQueued;
    setState({ loading: false, refreshQueued: false });
    if (again) await refresh();
  }

  // Herdr names a Space after its root pane's folder, so a `cd` into another
  // repo shows up here as a new Space name.
  async function watchSpace() {
    try {
      const { label } = await currentSpace();
      if (label === state.space) {
        if (state.notice?.source === 'herdr') setState({ notice: null });
        return;
      }
      setState({
        space: label,
        repo: null,
        otherMatches: 0,
        notice: null,
        rows: emptyTabs([]),
        errors: emptyTabs(null),
        selected: emptyTabs(null),
        scroll: emptyTabs(0),
        updatedAt: null,
        message: null,
        confirm: null,
      });
      await refresh();
    } catch (err) {
      setState({
        notice: { source: 'herdr', text: `Could not read the current Space from Herdr: ${gh.errorMessage(err)}`, paint: red },
      });
    }
  }

  async function runAction(label, action) {
    setState({ busy: true, message: { text: `${label}…`, paint: yellow } });
    try {
      await action();
      setState({ message: { text: `${label} ✓`, paint: green } });
    } catch (err) {
      setState({ message: { text: `${label} failed: ${gh.errorMessage(err)}`, paint: red } });
    }
    setState({ busy: false });
    await refresh();
  }

  // `onNo` turns the prompt into a question: n answers it, any other key still cancels.
  function confirm(prompt, action, onNo) {
    if (state.busy) return setState({ message: { text: 'Still working on the last action…', paint: yellow } });
    return setState({ confirm: { prompt, action, onNo } });
  }

  // ------------------------------------------------------------ input

  function moveCursor(delta) {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const index = Math.max(0, Math.min(rows.length - 1, cursorIndex(rows) + delta));
    setState({ selected: replaceAt(state.selected, state.tab, TABS[state.tab].key(rows[index])) });
  }

  function switchTab(tab) {
    setState({ tab: (tab + TABS.length) % TABS.length, message: null });
  }

  function openUrl(url) {
    terminal.openUrl(url, (err) => setState({ message: { text: `Could not open browser: ${err.message}`, paint: red } }));
  }

  function page(ghArgs) {
    terminal.page(ghArgs);
    render();
  }

  function handlePrKey(key, pr, r) {
    const ref = `#${pr.number} ${pr.title}`;
    if (key === KEY.enter) return page(['pr', 'view', String(pr.number), '-R', r, '--comments']);
    if (key === 'c') return page(['pr', 'checks', String(pr.number), '-R', r]);
    if (key === 'o') return openUrl(pr.url);
    if (key === 'a') return confirm(`approve ${ref}`, () => runAction(`Approve #${pr.number}`, () => gh.approvePr(r, pr.number, pr.headSha)));
    if (key === 'm') {
      return confirm(`merge ${ref} (${config.merge_method})`, () =>
        runAction(`Merge #${pr.number}`, () => gh.mergePr(r, pr.number, config.merge_method, pr.headSha)),
      );
    }
    if (key === 'b') {
      if (!pr.isDependabot) return setState({ message: { text: `#${pr.number} is not a Dependabot PR`, paint: red } });
      return confirm(`comment "@dependabot rebase" on ${ref}`, () =>
        runAction(`Rebase #${pr.number}`, () => gh.commentPr(r, pr.number, '@dependabot rebase')),
      );
    }
    return undefined;
  }

  function handleRunKey(key, run, r) {
    if (key === KEY.enter) {
      const args = ['run', 'view', String(run.id), '-R', r];
      return page(isFailedRun(run) ? [...args, '--log-failed'] : args);
    }
    if (key === 'o') return openUrl(run.url);
    if (key === 'R') {
      if (!isFailedRun(run)) return setState({ message: { text: 'Only finished, unsuccessful runs can be rerun', paint: red } });
      return confirm(`rerun failed jobs of ${run.workflow} on ${run.branch} (run ${run.id})`, () =>
        runAction(`Rerun ${run.workflow}`, () => gh.rerunFailedJobs(r, run.id)),
      );
    }
    return undefined;
  }

  function handleAlertKey(key, alert) {
    if (key === KEY.enter || key === 'o') return openUrl(alert.url);
    return undefined;
  }

  // Asks which Dependabot features to turn on, then confirms the exact change before making it.
  function promptEnableAlerts(r) {
    const confirmEnable = (securityUpdates) =>
      confirm(`turn on Dependabot alerts${securityUpdates ? ' + fix PRs' : ''} for ${r}`, () =>
        runAction('Turn on Dependabot alerts', () => gh.enableDependabot(r, securityUpdates)),
      );
    return confirm(
      'also open PRs that fix alerts?',
      () => confirmEnable(true),
      () => confirmEnable(false),
    );
  }

  const ROW_HANDLERS = [handlePrKey, handleRunKey, handleAlertKey];

  function handleKey(key) {
    if (state.confirm) {
      const { action, onNo } = state.confirm;
      setState({ confirm: null, message: null });
      if (key === 'y' || key === 'Y') return action();
      if (onNo && (key === 'n' || key === 'N')) return onNo();
      return undefined;
    }
    if (state.help) return setState({ help: false });
    if (key === 'q' || key === KEY.escape || key === KEY.ctrlC) return terminal.quit();
    if (key === '?') return setState({ help: true });
    if (KEY.down.includes(key)) return moveCursor(1);
    if (KEY.up.includes(key)) return moveCursor(-1);
    if (key === KEY.pageDown) return moveCursor(PAGE_STEP);
    if (key === KEY.pageUp) return moveCursor(-PAGE_STEP);
    if (key === 'g') return moveCursor(-Infinity);
    if (key === 'G') return moveCursor(Infinity);
    if (key === KEY.tab) return switchTab(state.tab + 1);
    if (key === KEY.shiftTab) return switchTab(state.tab - 1);
    if (['1', '2', '3'].includes(key)) return switchTab(Number(key) - 1);
    if (key === 'r') return refresh();
    if (key === 'd' && state.tab === 0) return setState({ dependabotOnly: !state.dependabotOnly });
    if (key === 'f' && state.tab === 1) return setState({ failuresOnly: !state.failuresOnly });

    if (key === 'e' && canEnableAlerts()) return promptEnableAlerts(state.repo);

    // A notice or error replaces the list; never act on rows the user cannot see.
    if (state.notice || state.errors[state.tab]) return undefined;
    const row = selectedRow();
    return row ? ROW_HANDLERS[state.tab](key, row, state.repo) : undefined;
  }

  // Returns the promise of the last key's work so tests can await it.
  function handleInput(data) {
    return (String(data).match(KEY_TOKEN) || []).reduce((_, key) => handleKey(key), undefined);
  }

  return { render, refresh, watchSpace, handleInput, getState: () => state };
}

// ---------------------------------------------------------------- terminal

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    process.stdout.write(`herdr-gh needs Node.js ${MIN_NODE_MAJOR}+ (found ${process.versions.node}).\n`);
    process.exit(1);
  }

  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), '.config', 'herdr-gh');
  const configPath = path.join(configDir, 'config.json');
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    // A popup closes as soon as its command exits, so hold the error on screen.
    process.stdout.write(`herdr-gh: invalid config ${configPath}\n${err.message}\n\nPress any key to close.`);
    process.stdin.setRawMode(true);
    process.stdin.once('data', () => process.exit(1));
    return;
  }

  const restoreTerminal = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  };
  const enterScreen = () => {
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
  };
  process.on('exit', restoreTerminal);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    restoreTerminal();
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });

  const terminal = {
    columns: () => process.stdout.columns || 80,
    rows: () => process.stdout.rows || 24,
    write: (text) => process.stdout.write(text),
    quit: () => process.exit(0),
    // Hands the terminal to a pager showing `gh ...` output and takes it back when the pager exits.
    page: (ghArgs) => {
      restoreTerminal();
      if (IS_WINDOWS) {
        // No sh or less by default on Windows: collect the output, then page it with `more`.
        const out = spawnSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: PAGER_MAX_BUFFER_BYTES });
        const text = out.error ? `herdr-gh: ${out.error.message}\n` : `${out.stdout}${out.stderr}`;
        spawnSync('more', [], { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
      } else {
        spawnSync('sh', ['-c', 'gh "$@" 2>&1 | less -R', 'sh', ...ghArgs], {
          stdio: 'inherit',
          env: { ...process.env, GH_FORCE_TTY: String(process.stdout.columns), GH_PAGER: 'cat' },
        });
      }
      enterScreen();
    },
    openUrl: (url, onError) => {
      const [opener, ...args] = BROWSER_OPENER[process.platform] || BROWSER_OPENER.linux;
      const child = spawn(opener, [...args, url], { stdio: 'ignore', detached: true });
      child.on('error', onError);
      child.unref();
    },
  };

  const app = createApp({ gh, currentSpace, config, repo: process.argv[2] || null, terminal });
  enterScreen();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => app.handleInput(data));
  process.stdout.on('resize', app.render);
  app.render();
  if (app.getState().repo) {
    app.refresh();
  } else {
    app.watchSpace();
    setInterval(app.watchSpace, SPACE_POLL_MS);
  }
  setInterval(app.refresh, config.refresh_seconds * 1000);
}

if (require.main === module) main();

// main is exported for the manifest, which starts it with `node -e` (see herdr-plugin.toml).
module.exports = { createApp, loadConfig, main };
