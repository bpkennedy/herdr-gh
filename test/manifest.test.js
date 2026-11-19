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

const commands = [...manifest.matchAll(/^command = (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));

test('every command the manifest runs points at a script that exists', () => {
  // Matches both "bin/open.js" and the pane's join(..., 'bin','dashboard.js').
  const scripts = commands.flatMap((argv) => [...argv.join(' ').matchAll(/bin\W{1,3}([\w-]+\.js)/g)].map((m) => m[1]));
  assert.equal(scripts.length, commands.length);
  for (const script of scripts) assert.ok(fs.existsSync(path.join(root, 'bin', script)), script);
});

test('commands run node directly, with no shell, so they work on Windows', () => {
  assert.match(manifest.match(/^platforms = (.*)$/m)[1], /"windows"/);
  for (const argv of commands) assert.equal(argv[0], 'node');
});

test('the pane command starts the panel', () => {
  const [, flag, code] = commands[0];
  assert.equal(flag, '-e');
  const dashboard = path.join(root, 'bin', 'dashboard.js');
  assert.equal(typeof require(dashboard).main, 'function');
  assert.match(code, /\.main\(\)$/);
});
