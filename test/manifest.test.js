'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = read('herdr-plugin.toml');
const tomlString = (key) => manifest.match(new RegExp(`^${key} = "([^"]*)"`, 'm'))?.[1];

test('manifest has the fields Herdr requires', () => {
  assert.equal(tomlString('id'), 'bpkennedy.herdr-gh');
  assert.ok(tomlString('name'));
  assert.match(tomlString('version'), /^\d+\.\d+\.\d+$/);
  assert.match(tomlString('min_herdr_version'), /^\d+\.\d+\.\d+$/);
});

test('manifest and package.json versions match', () => {
  assert.equal(tomlString('version'), JSON.parse(read('package.json')).version);
});

test('the sidebar toggle looks for the pane title the manifest declares', () => {
  const paneTitle = manifest.match(/\[\[panes\]\][\s\S]*?^title = "([^"]*)"/m)[1];
  assert.match(read('bin/open.js'), new RegExp(`PANE_LABEL = '${paneTitle}'`));
});

test('every command the manifest runs points at a file that exists', () => {
  const scripts = [...manifest.matchAll(/\$HERDR_PLUGIN_ROOT\/([\w/.-]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok(fs.existsSync(path.join(root, script)), script);
});
