#!/usr/bin/env node
'use strict';

// Stand-in for `gh` / `herdr` in tests. Logs each argv as a JSON line to
// FAKE_CLI_LOG and answers with the first entry in FAKE_CLI_RESPONSES whose
// `match` regex matches the space-joined arguments.

const fs = require('node:fs');

const args = process.argv.slice(2);
const joined = args.join(' ');
fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(args)}\n`);

const responses = JSON.parse(fs.readFileSync(process.env.FAKE_CLI_RESPONSES, 'utf8'));
const hit = responses.find((response) => new RegExp(response.match).test(joined));
if (!hit) {
  process.stderr.write(`fake-cli: no response for: ${joined}\n`);
  process.exit(97);
}
if (hit.stdout !== undefined) process.stdout.write(typeof hit.stdout === 'string' ? hit.stdout : JSON.stringify(hit.stdout));
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code ?? 0);
