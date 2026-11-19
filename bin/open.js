#!/usr/bin/env node
'use strict';

// Opens the GitHub Ops panel. Default: toggles a right-hand sidebar next to the focused
// pane. With --popup: opens it as a floating popup (handy in narrow windows).

const { herdr } = require('../lib/herdr');

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID;
const ENTRYPOINT = 'dashboard';
// The pane `title` in herdr-plugin.toml. Herdr exposes no plugin-ownership field
// on panes, so the label is how the toggle recognises its own sidebar.
const PANE_LABEL = 'GitHub Ops';
// A new split divides the focused pane 50/50; moving the divider right by this
// fraction leaves the sidebar at roughly 35% of that pane.
const SIDEBAR_SHRINK = 0.15;

function openPopup() {
  herdr(['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', ENTRYPOINT]);
}

function toggleSidebar() {
  const { panes } = herdr(['pane', 'list']);
  const focused = panes.find((pane) => pane.pane_id === process.env.HERDR_PANE_ID) || panes.find((pane) => pane.focused);
  if (!focused) throw new Error('No focused pane to open the sidebar next to. Run this from a Herdr keybinding or pane.');

  const existing = panes.find((pane) => pane.tab_id === focused.tab_id && pane.label === PANE_LABEL);
  if (existing) {
    herdr(['plugin', 'pane', 'close', existing.pane_id]);
    return;
  }
  const opened = herdr([
    'plugin', 'pane', 'open',
    '--plugin', PLUGIN_ID,
    '--entrypoint', ENTRYPOINT,
    '--placement', 'split',
    '--direction', 'right',
    '--target-pane', focused.pane_id,
    // Same folder as the pane it sits beside, so the Space name never comes from the plugin directory.
    ...(focused.cwd ? ['--cwd', focused.cwd] : []),
  ]);
  const sidebarId = opened.plugin_pane.pane.pane_id;
  herdr(['pane', 'resize', '--pane', sidebarId, '--direction', 'right', '--amount', String(SIDEBAR_SHRINK)]);
}

try {
  if (process.argv.includes('--popup')) {
    openPopup();
  } else {
    toggleSidebar();
  }
} catch (err) {
  process.stderr.write(`herdr-gh: ${err.message}\n`);
  process.exit(1);
}
