#!/usr/bin/env node
// mlx-generate-proxy.js — lazy-load proxy in front of MLX Generate (:3162).
//
// Why this exists (2026-04-20):
//   The Qwen3-8B-4bit model holds ~6 GB RSS continuously when resident.
//   On the 36 GB M3 Pro co-tenant with MLX embed (4.5 GB), Chrome (2+ GB),
//   Codex, and Docker, keeping it loaded pushed the system into jetsam
//   territory — root cause of the 09:21 cascade that killed vcontext.
//   Design: lazy-load. Model only occupies memory when actively in use.
//
// Spec: docs/specs/2026-04-20-mlx-lazy-load-proxy.md
// Listens on: VCTX_MLX_PROXY_PORT (default 3163)
// Proxies to: http://127.0.0.1:3162  (MLX Generate)
// Unloads after: VCTX_MLX_IDLE_MS (default 600000 = 10 min) of no requests
//
// Endpoints (proxy-internal):
//   GET /proxy/health   — proxy's own health (distinct from MLX's /health)
//   GET /proxy/state    — { state, last_request_at, warm_up_ms_last, ... }
//   GET /proxy/metrics  — counters
//   *                   — forwarded to MLX Generate with lazy-load
//
// AIOS Constitution alignment: P1 (loose coupling), P3 (fail-open infra),
// P4 (machine-readable state), P5 (reversible), P6 (observe before act).

// Note: this file runs as ESM because package.json has "type": "module".

import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileP = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.VCTX_MLX_PROXY_PORT || '3163', 10);
const MLX_HOST      = '127.0.0.1';
const MLX_PORT      = parseInt(process.env.VCTX_MLX_BACKEND_PORT || '3162', 10);
const MLX_PLIST     = `${homedir()}/Library/LaunchAgents/com.vcontext.mlx-generate.plist`;
const MLX_SVC       = `gui/${process.getuid()}/com.vcontext.mlx-generate`;
const IDLE_MS       = parseInt(process.env.VCTX_MLX_IDLE_MS || String(10 * 60 * 1000), 10);
const WARMUP_MS_MAX = parseInt(process.env.VCTX_MLX_WARMUP_MS_MAX || '90000', 10);
const POLL_INTERVAL = parseInt(process.env.VCTX_MLX_POLL_MS || '3000', 10);
const MIN_FREE_PAGES = parseInt(process.env.VCTX_MLX_MIN_FREE_PAGES || '50000', 10);

// ── State machine ────────────────────────────────────────────────

/** @typedef {'STOPPED'|'STARTING'|'RUNNING'} State */

const state = {
  value: /** @type {State} */ ('STOPPED'),
  last_request_at: 0,
  active_requests: 0,
  warm_up_ms_last: null,
  starting_promise: /** @type {Promise<void>|null} */ (null),
  metrics: {
    bootstraps: 0,
    bootouts: 0,
    requests_forwarded: 0,
    requests_503_memory: 0,
    requests_503_warmup_timeout: 0,
    warmup_latencies_ms: /** @type {number[]} */ ([]),
  },
};

function logLine(...parts) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [proxy] ${parts.join(' ')}`);
}

// ── Memory-pressure gate (AIOS P3: fail-open for infra) ──────────

async function getFreePages() {
  try {
    const { stdout } = await execFileP('vm_stat', [], { timeout: 2000 });
    // 2026-04-20 fix: on macOS, "Pages free" alone is misleading.
    // The kernel aggressively keeps pages in the "inactive" state as
    // file-system cache — reclaimable on demand without causing memory
    // pressure. On a busy workstation "Pages free" is routinely
    // 3000-10000 (50-160 MB) while "Pages inactive" holds 600000+
    // pages (10 GB) of reclaimable cache. Gating on `free` alone
    // refuses MLX warm-up even when 10 GB is genuinely available.
    //
    // Correct metric: free + inactive = available-without-swapping.
    // True memory pressure (when we should refuse) shows as BOTH
    // dropping simultaneously, because the kernel reclaims inactive
    // → free when allocations stress it.
    //
    // Observed 2026-04-20: vm_stat free=9990 inactive=660000 was
    // rejected by the pre-fix gate (9990 < 50000) even though
    // 10+ GB was actually available. Direct :3162 call succeeded
    // with no SIGKILL-137, proving the rejection was a false
    // positive.
    const mFree = stdout.match(/Pages free:\s+(\d+)\./);
    const mInactive = stdout.match(/Pages inactive:\s+(\d+)\./);
    const free = mFree ? parseInt(mFree[1], 10) : 0;
    const inactive = mInactive ? parseInt(mInactive[1], 10) : 0;
    if (!mFree && !mInactive) return null; // parse failed entirely
    return free + inactive;
  } catch {
    return null;
  }
}

/**
 * If the system has less than MIN_FREE_PAGES of AVAILABLE memory
 * (free + inactive), loading the 8B model (~6 GB) would trigger
 * jetsam and kill innocent bystanders (vcontext, mlx-embed).
 * Return 503 in that case, mirroring the watchdog's
 * MLX_RESTART_MIN_FREE_PAGES policy. Same constant on purpose.
 *
 * Semantics note: getFreePages() returns free+inactive as of
 * 2026-04-20. MIN_FREE_PAGES=50000 = 800 MB of available memory
 * for MLX warm-up headroom.
 */
async function memoryGate() {
  const free = await getFreePages();
  if (free === null) return { ok: true, free: null }; // can't measure — allow
  if (free < MIN_FREE_PAGES) return { ok: false, free };
  return { ok: true, free };
}

// ── MLX lifecycle ─────────────────────────────────────────────────

async function mlxIsHealthy() {
  return new Promise((resolve) => {
    const req = http.request({
      host: MLX_HOST, port: MLX_PORT, path: '/health',
      method: 'GET', timeout: 2000,
    }, (res) => {
      // Any 2xx from /health — MLX is up
      resolve(res.statusCode >= 200 && res.statusCode < 300);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function launchctlEnable() {
  try {
    await execFileP('launchctl', ['enable', MLX_SVC], { timeout: 5000 });
  } catch (e) {
    logLine('launchctl enable failed (non-fatal):', e.message);
  }
}

async function launchctlBootstrap() {
  try {
    await execFileP('launchctl', ['bootstrap', `gui/${process.getuid()}`, MLX_PLIST], { timeout: 10000 });
    return true;
  } catch (e) {
    logLine('launchctl bootstrap failed:', e.message);
    return false;
  }
}

async function launchctlBootout() {
  try {
    await execFileP('launchctl', ['bootout', MLX_SVC], { timeout: 10000 });
  } catch (e) {
    // Bootout often returns non-zero even on success (e.g. "service not loaded");
    // trust our own state checks rather than the exit code.
    logLine('launchctl bootout returned error (often harmless):', e.message);
  }
  // ALSO disable — otherwise launchd + vcontext-watchdog will re-bootstrap
  // MLX in the background, fighting the idle-unload. The proxy is the
  // single authority on MLX lifecycle; the service stays disabled until
  // a future request triggers startMlx() again.
  try {
    await execFileP('launchctl', ['disable', MLX_SVC], { timeout: 5000 });
  } catch (e) {
    logLine('launchctl disable failed (non-fatal):', e.message);
  }
  return true;
}

async function waitForMlxHealth(deadlineMs) {
  const start = Date.now();
  while (Date.now() < deadlineMs) {
    if (await mlxIsHealthy()) return Date.now() - start;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return null; // timed out
}

async function startMlx() {
  // Fast path: already running.
  if (state.value === 'RUNNING') return;

  // Coalesce concurrent callers onto the SAME starting_promise.
  // 2026-04-20 review fix: previously we checked state+promise then did
  // `await memoryGate()` BEFORE setting `state.value='STARTING'`. Two
  // concurrent requests arriving during STOPPED both passed the first
  // guard, both awaited the gate, both then set STARTING and both
  // kicked off launchctl bootstrap. Result: fighting bootstrap calls +
  // duplicate MLX spawns under load. Fix: claim the slot (set state +
  // starting_promise) SYNCHRONOUSLY before any await, so any second
  // caller sees the slot already taken and awaits our promise instead.
  if (state.starting_promise) {
    return state.starting_promise;
  }

  // Atomic claim — no await between the two assignments.
  state.value = 'STARTING';
  const warmupStart = Date.now();

  const p = (async () => {
    // Memory gate inside the promise — safe to await now that we hold
    // the slot. Other callers waiting on starting_promise will fail-open
    // as a group on memory-tight (they all throw from the awaited p).
    const memCheck = await memoryGate();
    if (!memCheck.ok) {
      state.value = 'STOPPED'; // release slot for future retry
      const err = new Error(`memory_tight: free=${memCheck.free} < min=${MIN_FREE_PAGES}`);
      err.status = 503;
      throw err;
    }

    // 2026-04-20 fix: skip bootstrap when service is ALREADY running.
    // Proxy's normal flow assumes MLX is STOPPED (it tracks the state
    // itself via bootouts), so `launchctl bootstrap` is called blindly.
    // But if MLX was started by an out-of-band actor (manual
    // `launchctl enable+kickstart`, watchdog, operator tests), bootstrap
    // returns "service already loaded" → proxy throws bootstrap_failed
    // and refuses traffic even though the model IS responding on :3162.
    //
    // Fix: probe /v1/models first. If MLX is healthy, fast-path to
    // RUNNING without touching launchctl. Only bootstrap when we
    // genuinely need to start it.
    if (await mlxIsHealthy()) {
      logLine('MLX already healthy on :3162 — skipping bootstrap');
      state.value = 'RUNNING';
      state.warm_up_ms_last = 0;
      return;
    }

    logLine('MLX starting: launchctl enable + bootstrap');
    await launchctlEnable();
    const bootstrapped = await launchctlBootstrap();
    if (!bootstrapped) {
      state.value = 'STOPPED';
      const err = new Error('bootstrap_failed');
      err.status = 503;
      throw err;
    }
    state.metrics.bootstraps++;

    const deadline = warmupStart + WARMUP_MS_MAX;
    const warmupMs = await waitForMlxHealth(deadline);
    if (warmupMs === null) {
      logLine('MLX /health never came healthy within', WARMUP_MS_MAX, 'ms');
      state.value = 'STOPPED';
      state.metrics.requests_503_warmup_timeout++;
      // Don't bootout — let launchd + watchdog sort it
      const err = new Error('warmup_timeout');
      err.status = 503;
      throw err;
    }

    state.value = 'RUNNING';
    state.warm_up_ms_last = warmupMs;
    state.metrics.warmup_latencies_ms.push(warmupMs);
    // Keep the latencies array bounded
    if (state.metrics.warmup_latencies_ms.length > 100) {
      state.metrics.warmup_latencies_ms.shift();
    }
    logLine(`MLX RUNNING after ${warmupMs}ms warm-up`);
  })();

  state.starting_promise = p;
  try {
    await p;
  } finally {
    state.starting_promise = null;
  }
}

async function stopMlx(reason) {
  if (state.value === 'STOPPED') return;
  if (state.active_requests > 0) {
    logLine(`stop skipped: ${state.active_requests} active requests`);
    return;
  }
  logLine(`MLX stopping: ${reason}`);
  const ok = await launchctlBootout();
  state.value = 'STOPPED';
  state.metrics.bootouts++;
  if (ok) logLine('MLX stopped (launchctl bootout)');
}

// ── Idle watchdog ────────────────────────────────────────────────

setInterval(() => {
  if (state.value !== 'RUNNING') return;
  if (state.active_requests > 0) return; // I3: never unload during flight
  const idle = Date.now() - state.last_request_at;
  if (idle > IDLE_MS) {
    stopMlx(`idle ${(idle/1000).toFixed(1)}s > ${IDLE_MS/1000}s`).catch(e => {
      logLine('stopMlx error:', e.message);
    });
  }
}, 60 * 1000);

// ── HTTP request forwarding ──────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function forwardToMlx(req, res, bodyBuf) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length']; // recompute
    headers['content-length'] = String(bodyBuf.length);

    const upstream = http.request({
      host: MLX_HOST,
      port: MLX_PORT,
      method: req.method,
      path: req.url,
      headers,
      timeout: 10 * 60 * 1000, // 10 min for long generation
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    upstream.on('error', (err) => {
      logLine('forward error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_upstream_error', detail: err.message }));
      }
      resolve();
    });
    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_timeout' }));
      }
      resolve();
    });
    upstream.end(bodyBuf);
  });
}

function replyJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Proxy-internal endpoints ─────────────────────────────────────

function handleProxyHealth(req, res) {
  replyJson(res, 200, {
    status: 'healthy',
    proxy_version: '1.0.0',
    mlx_state: state.value,
    active_requests: state.active_requests,
    uptime_seconds: process.uptime(),
  });
}

function handleProxyState(req, res) {
  replyJson(res, 200, {
    state: state.value,
    last_request_at: state.last_request_at ? new Date(state.last_request_at).toISOString() : null,
    active_requests: state.active_requests,
    warm_up_ms_last: state.warm_up_ms_last,
    idle_ms_remaining: state.value === 'RUNNING' && state.last_request_at
      ? Math.max(0, IDLE_MS - (Date.now() - state.last_request_at))
      : null,
  });
}

function handleProxyMetrics(req, res) {
  const warmups = state.metrics.warmup_latencies_ms;
  const avg = warmups.length ? warmups.reduce((a, b) => a + b, 0) / warmups.length : null;
  const max = warmups.length ? Math.max(...warmups) : null;
  replyJson(res, 200, {
    bootstraps: state.metrics.bootstraps,
    bootouts: state.metrics.bootouts,
    requests_forwarded: state.metrics.requests_forwarded,
    requests_503_memory: state.metrics.requests_503_memory,
    requests_503_warmup_timeout: state.metrics.requests_503_warmup_timeout,
    warmup_latency_ms: { count: warmups.length, avg, max },
  });
}

// ── Main request handler ─────────────────────────────────────────

async function handleRequest(req, res) {
  const url = req.url || '/';

  // Proxy-internal endpoints never trigger MLX
  if (url === '/proxy/health')  return handleProxyHealth(req, res);
  if (url === '/proxy/state')   return handleProxyState(req, res);
  if (url === '/proxy/metrics') return handleProxyMetrics(req, res);

  // Everything else: lazy-load + forward
  state.last_request_at = Date.now();
  state.active_requests++;

  try {
    const bodyBuf = await readBody(req);

    if (state.value !== 'RUNNING') {
      // Will throw if memory tight or warmup times out
      try {
        await startMlx();
      } catch (e) {
        const st = e.status || 503;
        if (e.message && e.message.startsWith('memory_tight')) {
          state.metrics.requests_503_memory++;
        }
        return replyJson(res, st, {
          error: 'mlx_unavailable',
          detail: e.message,
          retry_after_seconds: 60,
        });
      }
    }

    state.metrics.requests_forwarded++;
    await forwardToMlx(req, res, bodyBuf);
  } catch (e) {
    logLine('handler error:', e.message);
    if (!res.headersSent) replyJson(res, 500, { error: String(e.message) });
  } finally {
    state.active_requests = Math.max(0, state.active_requests - 1);
  }
}

// ── Boot ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(e => {
    logLine('unhandled error:', e.message);
    if (!res.headersSent) replyJson(res, 500, { error: String(e.message) });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  logLine(`listening on :${PORT} → backend :${MLX_PORT} (idle=${IDLE_MS}ms, warmup_max=${WARMUP_MS_MAX}ms)`);
  logLine(`MLX plist: ${MLX_PLIST} exists=${existsSync(MLX_PLIST)}`);
});

server.on('error', (e) => {
  logLine('server error:', e.message);
  process.exit(1);
});

// Graceful shutdown — don't leave MLX running if we exit
function shutdown(sig) {
  logLine(`shutdown (${sig})`);
  if (state.value === 'RUNNING') {
    stopMlx('proxy shutdown').finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000); // force exit after 5s
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
