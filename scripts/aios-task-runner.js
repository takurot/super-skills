#!/usr/bin/env node
// aios-task-runner.js — Standalone daemon that drains the vcontext task queue.
//
// Mission (AIOS Task Queue, mid-term Claude-crash countermeasure):
//   When Claude Code crashes, long-running work must continue.  This runner
//   is an independent LaunchAgent (com.vcontext.task-runner) that:
//     1. Polls GET /admin/task-queue every 10s for pending tasks
//     2. Marks a claimed task as running via POST /store type=task-status-update
//     3. Dispatches based on task_type
//     4. Writes result back as type=task-result so the next Claude Code
//        session can /recall it, and the dashboard card can show status.
//
// Crash recovery:
//   On boot, any task still marked running for >30min without a matching
//   task-result is flagged as orphaned_on_restart (marked failed).
//
// Safety:
//   - shell-command task_type requires payload.approved_by_user === true
//     (the server already rejects unmarked submissions, this is belt+braces)
//   - SIGTERM graceful shutdown (finish current, stop picking new)
//   - ABI self-test on boot (fail-fast exit 2 — launchd throttle applies)
//   - Log rotation at 512KB (truncate to last 128KB)

import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { exec as _exec, execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import {
  tryMlxLock,
  releaseMlxLock,
  mlxLockStatus as _sharedMlxLockStatus,
  MLX_LOCK_ENV_VAR,
} from './aios-mlx-lock.js';

const exec = promisify(_exec);
const execFile = promisify(_execFile);

const VCONTEXT = process.env.VCONTEXT_URL || 'http://127.0.0.1:3150';
const API_KEY = process.env.VCONTEXT_API_KEY || '';
const POLL_INTERVAL_MS = 10_000;
const LOG_PATH = '/tmp/vcontext-task-runner.log';
const LOG_MAX_BYTES = 512 * 1024;
const LOG_TRUNC_TAIL = 128 * 1024;
const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000; // 30min
const LOCOMO_EVAL_TIMEOUT_MS = 20 * 60 * 1000; // 20min
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000; // 5min
const SKILL_DISCOVERY_TIMEOUT_MS = 10 * 60 * 1000; // 10min
const ARTICLE_SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10min
const SELF_EVOLVE_TIMEOUT_MS = 15 * 60 * 1000; // 15min
const REPO_ROOT = '/Users/mitsuru_nakajima/skills';
// Prefer nvm-installed node for child processes so the script runs with the
// same interpreter launchd uses for article-scanner / self-evolve LaunchAgents.
const NODE_BIN = process.env.NODE_BIN ||
  '/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node';
const STDOUT_TAIL_BYTES = 4 * 1024;  // per-task: last 4KB stdout captured
const STDERR_TAIL_BYTES = 4 * 1024;  // per-task: last 4KB stderr captured

let shuttingDown = false;
let currentTaskId = null;

function ts() { return new Date().toISOString(); }
function log(...msgs) { console.log(ts(), '[task-runner]', ...msgs); }
function errlog(...msgs) { console.error(ts(), '[task-runner]', ...msgs); }

// ── Log rotation ──
// launchd routes stdout/stderr to LOG_PATH via the plist; size-based trim
// keeps the tail so a runaway runner can't fill /tmp.
function maybeRotateLog() {
  try {
    if (!existsSync(LOG_PATH)) return;
    const s = statSync(LOG_PATH);
    if (s.size < LOG_MAX_BYTES) return;
    const fd = readFileSync(LOG_PATH);
    const tail = fd.slice(Math.max(0, fd.length - LOG_TRUNC_TAIL));
    // Truncate the file in-place and write a marker + retained tail.
    // Note: launchd keeps an append-mode fd on this file, so new stdout
    // writes continue to append after the tail we've kept.
    writeFileSync(LOG_PATH, `# log truncated ${ts()} (kept last ${tail.length} bytes)\n` + tail.toString('utf-8'));
  } catch (e) {
    // Rotation is best-effort; log write failure must not take down the loop.
    errlog('log-rotate failed:', (e && e.message) || String(e));
  }
}

// ── HTTP helpers ──

function httpRequestJson(method, path, body, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(VCONTEXT + path); } catch (e) { return reject(e); }
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = payload.length;
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
    const req = httpRequest(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data;
          try { data = raw ? JSON.parse(raw) : {}; }
          catch (e) { return reject(new Error(`non-JSON response (status ${res.statusCode}): ${raw.slice(0, 200)}`)); }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.error || raw.slice(0, 200)}`));
          }
          resolve(data);
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function abiSelfTest() {
  // ABI self-test: verify the runner can reach vcontext, read the queue, and
  // POST a heartbeat-style entry.  Fail-fast if any leg is broken so launchd
  // surfaces the issue via throttle rather than silently looping.
  try {
    await httpRequestJson('GET', '/health', null, 5_000);
  } catch (e) {
    errlog('[fatal] /health unreachable:', e.message);
    process.exit(2);
  }
  try {
    await httpRequestJson('GET', '/admin/task-queue', null, 5_000);
  } catch (e) {
    errlog('[fatal] /admin/task-queue unreachable:', e.message);
    process.exit(2);
  }
  // Post a boot heartbeat so we can see restart churn in vcontext /recall.
  try {
    await httpRequestJson('POST', '/store', {
      type: 'task-runner-heartbeat',
      content: JSON.stringify({ event: 'boot', pid: process.pid, node: process.version, at: ts() }),
      tags: ['task-queue', 'heartbeat'],
      session: 'task-queue',
    }, 5_000);
  } catch (e) {
    errlog('boot heartbeat failed (non-fatal):', e.message);
  }
  log('ABI self-test passed — vcontext reachable, queue readable');
}

// ── Task dispatch ──

async function storeStatusUpdate(request_id, status, extra = {}) {
  const entry = { request_id, status, ...extra, at: ts() };
  return httpRequestJson('POST', '/store', {
    type: 'task-status-update',
    content: JSON.stringify(entry),
    tags: ['task-queue', `task-status:${status}`, `request:${request_id}`],
    session: 'task-queue',
  });
}

async function storeResult(request_id, task_type, status, resultFields) {
  const entry = {
    request_id,
    task_type,
    status,
    completed_at: ts(),
    ...resultFields,
  };
  return httpRequestJson('POST', '/store', {
    type: 'task-result',
    content: JSON.stringify(entry),
    tags: ['task-queue', `task-status:${status}`, `task-type:${task_type}`, `request:${request_id}`],
    session: 'task-queue',
  });
}

async function runLocomoEval(payload, mlxHolderId) {
  // payload: { args?: string[] }  — cli args to pass to locomo-eval.py
  // D2 2026-04-18: inject AIOS_MLX_LOCK_HOLDER so the child's MlxLock
  // context manager becomes a re-entrant no-op instead of blocking on
  // the parent-held lock file.
  const args = Array.isArray(payload.args) ? payload.args.slice(0, 20).map(String) : [];
  const cmd = 'python3';
  const full = ['scripts/locomo-eval.py', ...args];
  const spawnEnv = mlxHolderId
    ? { ...process.env, [MLX_LOCK_ENV_VAR]: mlxHolderId }
    : process.env;
  const { stdout, stderr } = await execFile(cmd, full, {
    cwd: '/Users/mitsuru_nakajima/skills',
    timeout: LOCOMO_EVAL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: spawnEnv,
  });
  return { stdout: (stdout || '').slice(-16000), stderr: (stderr || '').slice(-4000) };
}

// ── Helpers for adhoc-script dispatch paths ──
//
// isScriptAlreadyRunning — pgrep for a marker substring so we don't double-run
//   when a LaunchAgent (or a previous task) is mid-cycle.  pgrep uses -f to
//   match the full command line, which is where the script path appears.
//   Returns true if at least one process other than this runner matches.
async function isScriptAlreadyRunning(markerSubstring) {
  try {
    // pgrep -f returns exit 0 if a match, 1 if none; use execFile and inspect.
    const { stdout } = await execFile('pgrep', ['-fl', markerSubstring], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const lines = (stdout || '').split('\n').filter(Boolean);
    // Exclude lines owned by this runner itself (in case argv surfaces the
    // substring via the log-rotate path or similar).  Match by PID.
    const myPid = String(process.pid);
    const others = lines.filter((ln) => {
      const pid = ln.trim().split(/\s+/)[0];
      return pid && pid !== myPid;
    });
    return others.length > 0;
  } catch (e) {
    // pgrep exit 1 = no match; any exec error → treat as "not running" but
    // log so we can notice pgrep absence (it's /usr/bin/pgrep on macOS).
    if (e && typeof e.code === 'number' && e.code === 1) return false;
    errlog(`pgrep(${markerSubstring}) failed, assuming not running:`, (e && e.message) || String(e));
    return false;
  }
}

function tailOutput(stdout, stderr) {
  return {
    stdout: (stdout || '').slice(-STDOUT_TAIL_BYTES),
    stderr: (stderr || '').slice(-STDERR_TAIL_BYTES),
  };
}

async function runSkillDiscoveryAdhoc(payload, mlxHolderId) {
  // payload: {}  — no arguments required; skill-discovery.sh is self-contained.
  // Idempotence: if a scheduled LaunchAgent run or prior adhoc task is still
  // running, skip and return a "skipped_already_running" status instead of
  // stacking concurrent invocations that would race on OUT_DIR + vcontext POSTs.
  // D2 2026-04-18: inject AIOS_MLX_LOCK_HOLDER so any MLX-using child call
  // (skill-summarizer, etc.) re-enters rather than deadlocks.
  if (await isScriptAlreadyRunning('scripts/skill-discovery.sh')) {
    return { skipped: 'already_running', stdout: '', stderr: '' };
  }
  const env = { ...process.env, TASK_RUNNER: '1' };
  if (mlxHolderId) env[MLX_LOCK_ENV_VAR] = mlxHolderId;
  const { stdout, stderr } = await execFile(
    '/bin/bash',
    ['scripts/skill-discovery.sh'],
    {
      cwd: REPO_ROOT,
      timeout: SKILL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env,
    }
  );
  return tailOutput(stdout, stderr);
}

async function runArticleScanAdhoc(payload, mlxHolderId) {
  // payload: { max?: number, dry_run?: boolean, verbose?: boolean, all?: boolean }
  // Whitelist flags we pass through so a malicious payload cannot inject
  // arbitrary argv.  --max is the only flag that takes a value.
  // D2 2026-04-18: inject AIOS_MLX_LOCK_HOLDER for re-entrancy.
  if (await isScriptAlreadyRunning('scripts/article-scanner.js')) {
    return { skipped: 'already_running', stdout: '', stderr: '' };
  }
  const cliArgs = ['scripts/article-scanner.js'];
  if (payload && payload.dry_run === true) cliArgs.push('--dry-run');
  if (payload && payload.verbose === true) cliArgs.push('--verbose');
  if (payload && payload.all === true) cliArgs.push('--all');
  if (payload && Number.isFinite(+payload.max)) {
    const maxN = Math.max(1, Math.min(100, Math.floor(+payload.max)));
    cliArgs.push('--max', String(maxN));
  }
  const env = {
    ...process.env,
    TASK_RUNNER: '1',
    VCONTEXT_URL: process.env.VCONTEXT_URL || 'http://127.0.0.1:3150',
  };
  if (mlxHolderId) env[MLX_LOCK_ENV_VAR] = mlxHolderId;
  const { stdout, stderr } = await execFile(NODE_BIN, cliArgs, {
    cwd: REPO_ROOT,
    timeout: ARTICLE_SCAN_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  return tailOutput(stdout, stderr);
}

async function runSelfEvolveDryrun(payload, mlxHolderId) {
  // payload: { verbose?: boolean, dry_run_only?: boolean }
  // Always pass --observation (this dispatch path is defined as dryrun/observation
  // mode; Phase c-e mutations are skipped by the script in this mode).
  // If payload.dry_run_only is true, also pass --dry-run so even Phase a-b
  // writes are suppressed (pure gather+score+log).
  // D2 2026-04-18: inject AIOS_MLX_LOCK_HOLDER for re-entrancy.
  if (await isScriptAlreadyRunning('self-evolve/scripts/self-evolve.js')) {
    return { skipped: 'already_running', stdout: '', stderr: '' };
  }
  const cliArgs = [
    'skills/self-evolve/scripts/self-evolve.js',
    '--observation',
  ];
  if (payload && payload.dry_run_only === true) cliArgs.push('--dry-run');
  if (payload && payload.verbose === true) cliArgs.push('--verbose');
  const env = {
    ...process.env,
    TASK_RUNNER: '1',
    VCONTEXT_URL: process.env.VCONTEXT_URL || 'http://127.0.0.1:3150',
    MLX_GENERATE_URL: process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162',
  };
  if (mlxHolderId) env[MLX_LOCK_ENV_VAR] = mlxHolderId;
  const { stdout, stderr } = await execFile(NODE_BIN, cliArgs, {
    cwd: REPO_ROOT,
    timeout: SELF_EVOLVE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  return tailOutput(stdout, stderr);
}

async function runShellCommand(payload) {
  // payload: { cmd: string, timeout_ms?: number, approved_by_user: true }
  if (payload.approved_by_user !== true) throw new Error('shell-command requires approved_by_user === true');
  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (!cmd) throw new Error('payload.cmd required');
  const timeout = Math.min(Math.max(parseInt(payload.timeout_ms, 10) || DEFAULT_SHELL_TIMEOUT_MS, 1000), 20 * 60 * 1000);
  const { stdout, stderr } = await exec(cmd, {
    cwd: payload.cwd && typeof payload.cwd === 'string' ? payload.cwd : '/Users/mitsuru_nakajima/skills',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, TASK_RUNNER: '1' },
  });
  return { stdout: (stdout || '').slice(-16000), stderr: (stderr || '').slice(-4000) };
}

async function dispatch(task, mlxHolderId = null) {
  const { request_id, task_type } = task;
  const payload = task.payload || {};
  const started = Date.now();
  log(`dispatching ${task_type} (${request_id})`);
  currentTaskId = request_id;
  try {
    await storeStatusUpdate(request_id, 'running', { started_at: ts(), task_type, pid: process.pid });
  } catch (e) {
    errlog('status-update(running) failed:', e.message);
    currentTaskId = null;
    return;
  }
  let result;
  let errorMsg = null;
  try {
    if (task_type === 'locomo-eval') {
      result = await runLocomoEval(payload, mlxHolderId);
    } else if (task_type === 'shell-command') {
      // W6 P1: defense-in-depth — only CLI-originated tasks can run shell (Security CRITICAL #2)
      // The HTTP /admin/task-request handler refuses shell-command at the boundary,
      // but a stale queue row or future code path could still surface here. Refuse
      // unless the task is explicitly marked CLI-origin (or env override is set).
      const allowShell = process.env.AIOS_TASK_RUNNER_ALLOW_SHELL === '1' || task.source === 'cli';
      if (!allowShell) {
        throw new Error(`shell-command refused: not CLI-originated (source=${task.source || 'unset'}, AIOS_TASK_RUNNER_ALLOW_SHELL=${process.env.AIOS_TASK_RUNNER_ALLOW_SHELL || 'unset'})`);
      }
      result = await runShellCommand(payload);
    } else if (task_type === 'skill-discovery-adhoc') {
      result = await runSkillDiscoveryAdhoc(payload, mlxHolderId);
    } else if (task_type === 'article-scan-adhoc') {
      result = await runArticleScanAdhoc(payload, mlxHolderId);
    } else if (task_type === 'self-evolve-dryrun') {
      result = await runSelfEvolveDryrun(payload, mlxHolderId);
    } else {
      errorMsg = `unknown task_type '${task_type}'`;
    }
  } catch (e) {
    errorMsg = (e && e.message) || String(e);
    // child_process exec adds stdout/stderr on the error object for partial output
    if (e && (e.stdout || e.stderr)) {
      result = { stdout: (e.stdout || '').slice(-16000), stderr: (e.stderr || '').slice(-4000) };
    }
  }
  const duration_ms = Date.now() - started;
  const status = errorMsg ? 'failed' : 'completed';
  try {
    await storeResult(request_id, task_type, status, {
      result: result || null,
      error: errorMsg,
      duration_ms,
    });
    log(`${status} ${task_type} (${request_id}) in ${duration_ms}ms${errorMsg ? `: ${errorMsg.slice(0, 120)}` : ''}`);
  } catch (e) {
    errlog('storeResult failed:', e.message);
  }
  currentTaskId = null;
}

// ── Crash recovery ──

async function recoverOrphans() {
  // Any task-status-update with status='running' older than ORPHAN_THRESHOLD_MS
  // and no matching task-result → mark as failed (orphaned_on_restart).
  let queue;
  try { queue = await httpRequestJson('GET', '/admin/task-queue', null, 10_000); }
  catch (e) { errlog('recoverOrphans: cannot read queue:', e.message); return; }
  const running = queue.running || [];
  const now = Date.now();
  let recovered = 0;
  for (const r of running) {
    const started = Date.parse(r.started_at || r.created_at || 0);
    if (!started || (now - started) < ORPHAN_THRESHOLD_MS) continue;
    try {
      await storeResult(r.request_id, r.task_type, 'failed', {
        error: 'orphaned_on_restart',
        duration_ms: now - started,
      });
      recovered++;
    } catch (e) {
      errlog('failed to recover orphan', r.request_id, e.message);
    }
  }
  if (recovered) log(`recovered ${recovered} orphan task(s) as failed`);
}

// ── Main loop ──

// ── MLX concurrency guard ─────────────────────────────────────────
// Tasks that heavily exercise the MLX generate server (:3162, ~8GB
// unified memory for Qwen3-8B-4bit). Never run more than one at once,
// and never run concurrently with agent-initiated MLX work elsewhere
// (detected via a shared lock file).
//
// Context (2026-04-18 incident): when 5 MLX-heavy tasks were queued
// alongside 5 Claude-launched agents doing their own MLX work, unified
// memory blew past 30GB (on a 36GB box), putting MLX generate into an
// uninterruptible-sleep (U state) wedge. Server OOM-cascade followed.
// Serial queue dispatch alone was insufficient because agents bypass
// the queue entirely.
//
// 2026-04-18 D2 refactor (M1): inline {mlxLockStatus, mlxLockAcquire,
// mlxLockRelease} helpers replaced with imports from aios-mlx-lock.js.
// The shared helper uses O_CREAT|O_EXCL (atomic, race-safe) instead of
// the old non-atomic writeFileSync, adds PID-liveness stale detection
// (D1), and — critically — AIOS_MLX_LOCK_HOLDER is now injected into
// spawned children's env so their MlxLock re-enters as a no-op rather
// than deadlocking on the parent-held file.
const MLX_HEAVY_TYPES = new Set([
  'locomo-eval',
  'self-evolve-dryrun',
  'article-scan-adhoc',
  'skill-discovery-adhoc',
]);

function isMlxHeavy(task_type) { return MLX_HEAVY_TYPES.has(task_type); }

async function pollOnce() {
  maybeRotateLog();
  if (shuttingDown) return;
  // Explicit re-entry guard: if the previous dispatch is still running
  // (shouldn't normally happen — loop is setTimeout-chained — but belt
  // and suspenders), skip this tick. Prevents accidental concurrent
  // dispatch if someone later wraps the loop in setInterval.
  if (currentTaskId) return;
  let queue;
  try {
    queue = await httpRequestJson('GET', '/admin/task-queue', null, 10_000);
  } catch (e) {
    errlog('poll failed:', e.message);
    return;
  }
  const pending = queue.pending || [];
  if (pending.length === 0) return;
  // Take the first (server already sorts by priority asc then FIFO).
  // The queue snapshot includes the payload, so we can dispatch directly.
  const next = pending[0];
  if (!next.request_id || !next.task_type) {
    errlog('skipping malformed queue entry:', JSON.stringify(next).slice(0, 200));
    return;
  }
  // MLX concurrency guard: if the next task is MLX-heavy, try to acquire
  // the shared lock with a tiny waitMs (0) so we don't block the poll
  // loop; if someone else holds it we'll retry on the next poll tick.
  // Non-MLX tasks (shell-command) always proceed.
  let mlxHolderId = null;
  if (isMlxHeavy(next.task_type)) {
    mlxHolderId = `task-runner:${next.request_id}`;
    // Non-blocking try: waitMs=0 means "acquire-or-fail immediately".
    const got = await tryMlxLock(mlxHolderId, { waitMs: 0 });
    if (!got) {
      const peek = _sharedMlxLockStatus();
      const ageMin = Math.round((peek.ageMs || 0) / 60000);
      if (!pollOnce._lastLockLogAt || Date.now() - pollOnce._lastLockLogAt > 5 * 60 * 1000) {
        log(`MLX busy — ${next.task_type} (${next.request_id.slice(0,8)}) waiting (holder=${peek.holder}, age=${ageMin}min)`);
        pollOnce._lastLockLogAt = Date.now();
      }
      return;
    }
  }
  try {
    await dispatch(next, mlxHolderId);
  } finally {
    if (mlxHolderId) {
      releaseMlxLock(mlxHolderId);
    }
  }
}

function onSigterm() {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`SIGTERM received — stopping after current task${currentTaskId ? ` (${currentTaskId})` : ''}`);
  const wait = setInterval(() => {
    if (!currentTaskId) {
      clearInterval(wait);
      log('graceful shutdown complete');
      process.exit(0);
    }
  }, 500);
  // Hard exit after 25min (longer than any single task's timeout).
  setTimeout(() => {
    errlog('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 25 * 60 * 1000).unref();
}

process.on('SIGTERM', onSigterm);
process.on('SIGINT', onSigterm);
process.on('uncaughtException', (e) => { errlog('uncaughtException:', e.stack || e.message); process.exit(3); });
process.on('unhandledRejection', (e) => { errlog('unhandledRejection:', (e && e.stack) || String(e)); });

(async function main() {
  log(`starting (pid=${process.pid}, vcontext=${VCONTEXT})`);
  await abiSelfTest();
  await recoverOrphans();
  // Kick off the poll loop.  setInterval is fine because pollOnce is
  // re-entrant-safe (one iteration returns before the next fires in
  // practice since dispatch is awaited inside pollOnce).
  const loop = async () => {
    if (shuttingDown) return;
    try { await pollOnce(); } catch (e) { errlog('poll iteration error:', e.message); }
    if (!shuttingDown) setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
})().catch((e) => { errlog('main crashed:', e.stack || e.message); process.exit(4); });
