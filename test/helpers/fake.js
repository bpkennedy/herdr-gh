'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_CLI = path.join(__dirname, 'fake-cli.js');

// The fakes are sh shims, which Windows can't execute; tests that use them skip there.
const SKIP_FAKE_CLI = process.platform === 'win32' && 'fake gh/herdr shims need sh';

// Creates an executable named `name` in a temp dir that behaves like fake-cli.js.
// `responses`: [{ match: 'regex', stdout?, stderr?, code? }]
function fakeCli(name, responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-gh-test-'));
  const bin = path.join(dir, name);
  const log = path.join(dir, 'calls.jsonl');
  const responsesFile = path.join(dir, 'responses.json');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(log, '');
  fs.writeFileSync(responsesFile, JSON.stringify(responses));
  return {
    dir,
    bin,
    env: { FAKE_CLI_LOG: log, FAKE_CLI_RESPONSES: responsesFile },
    calls: () =>
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    setResponses: (next) => fs.writeFileSync(responsesFile, JSON.stringify(next)),
  };
}

// Puts a fake `gh` first on PATH for this process and loads a fresh lib/gh
// (its owner cache is module state).
function withFakeGh(responses) {
  const fake = fakeCli('gh', responses);
  Object.assign(process.env, fake.env, { PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` });
  const ghPath = require.resolve('../../lib/gh');
  delete require.cache[ghPath];
  return { fake, gh: require(ghPath) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

module.exports = { fakeCli, withFakeGh, deferred, stripAnsi, SKIP_FAKE_CLI };
