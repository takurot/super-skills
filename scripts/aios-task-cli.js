#!/usr/bin/env node
// W6 P1: CLI-only shell-command dispatcher (Security CRITICAL #2)
// Usage: node scripts/aios-task-cli.js shell-command --cmd "ls /tmp"
//        node scripts/aios-task-cli.js shell-command --cmd "..." --force   # skip TTY+confirm
//        node scripts/aios-task-cli.js --help

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function usage(code = 1) {
  console.error('Usage: node scripts/aios-task-cli.js shell-command --cmd "<cmd>" [--force] [--cwd <dir>] [--timeout <ms>]');
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(0);

const taskType = args[0];
if (taskType !== 'shell-command') {
  console.error(`Unknown task type: ${taskType}. Only 'shell-command' supported by this CLI.`);
  usage(1);
}

function getArg(name, def = null) {
  const idx = args.indexOf(name);
  if (idx < 0) return def;
  return args[idx + 1];
}
const cmd = getArg('--cmd');
const force = args.includes('--force');
const cwd = getArg('--cwd', process.cwd());
const timeoutMs = parseInt(getArg('--timeout', '300000'), 10);

if (!cmd) {
  console.error('error: --cmd required');
  usage(1);
}

if (!force) {
  if (!process.stdin.isTTY) {
    console.error('error: refusing to run shell-command from non-TTY stdin without --force');
    process.exit(2);
  }
  process.stderr.write(`About to run: ${cmd}\nin cwd: ${cwd}\nContinue? [y/N] `);
  const buf = Buffer.alloc(8);
  const n = fs.readSync(0, buf, 0, 8, null);
  const ans = buf.toString('utf-8', 0, n).trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') {
    console.error('aborted');
    process.exit(3);
  }
}

// Direct exec — bypass HTTP queue entirely. This is the explicit CLI path.
// process.env.AIOS_TASK_RUNNER_ALLOW_SHELL is irrelevant here; we just exec directly.
const r = spawnSync('/bin/sh', ['-c', cmd], {
  cwd,
  timeout: timeoutMs,
  env: process.env,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
