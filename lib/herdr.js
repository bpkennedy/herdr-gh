'use strict';

// Calls the Herdr CLI that launched us (HERDR_BIN_PATH) and returns the JSON `result`.

const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const HERDR_BIN = process.env.HERDR_BIN_PATH || 'herdr';

function parseResult(stdout) {
  const output = JSON.parse(stdout);
  if (output.error) throw new Error(output.error.message);
  return output.result;
}

function herdr(args) {
  return parseResult(execFileSync(HERDR_BIN, args, { encoding: 'utf8' }));
}

// The Space (workspace) this process belongs to, falling back to the focused one.
// Async because the dashboard polls it and must not block its UI.
async function currentSpace() {
  const { workspaces } = parseResult((await execFileAsync(HERDR_BIN, ['workspace', 'list'])).stdout);
  return (
    workspaces.find((ws) => ws.workspace_id === process.env.HERDR_WORKSPACE_ID) ||
    workspaces.find((ws) => ws.focused)
  );
}

module.exports = { herdr, currentSpace };
