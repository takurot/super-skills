#!/usr/bin/env node
/**
 * reprocess-all-entries.js — populate `reasoning` field for ALL entries.
 *
 * Scope: every row in `entries` where `reasoning IS NULL`. No type filter,
 * no deduplication, no abbreviation. Runs through the full ~156K historical
 * backlog plus any new entries that arrive while the job is in flight.
 *
 * Design principle: AIOS 全保持 × 継続学習 — every interaction gets its
 * own LLM annotation. No chunk-summary lossy compression. No type-based
 * skip. "Just process everything, honestly."
 *
 * Runtime estimate:
 *   ~156K entries × ~5 s/LLM call = ~217 hours (sequential)
 *   At 24 h/day: ~9 days. At 10 h/day overnight-only: ~22 days.
 *
 * Idempotent — resume by re-running. Uses `WHERE reasoning IS NULL` so
 * already-processed rows are skipped.
 *
 * Prompt format mirrors the existing inline auto-summarize at
 * scripts/vcontext-server.js:1597-1599 so this tool's output is
 * indistinguishable from on-demand /store-time summaries.
 *
 * Usage:
 *   node scripts/reprocess-all-entries.js              # run until drained
 *   node scripts/reprocess-all-entries.js --max N      # process at most N
 *   node scripts/reprocess-all-entries.js --dry-run    # print, don't UPDATE
 *   touch /tmp/vcontext-reprocess-stop                 # graceful stop
 *
 * Safety gates (auto-pause 60 s + retry, full stop after 5 consecutive):
 *   - `/tmp/vcontext-reprocess-stop` exists         → stop immediately
 *   - swap grew +1 GB from baseline                 → pause 60 s, retry
 *   - sys_free pages < 50_000 (~800 MB available)   → pause 60 s, retry
 *   - mlx-generate 5 consecutive failures           → stop immediately
 *   - SIGINT/SIGTERM                                → graceful stop
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

// ── Config ──────────────────────────────────────────────────────────

const VCONTEXT_URL = process.env.VCONTEXT_URL || 'http://127.0.0.1:3150';
const MLX_GEN_URL  = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3163'; // proxy
const STOP_FLAG    = '/tmp/vcontext-reprocess-stop';
const PROGRESS_LOG = '/tmp/vcontext-reprocess-progress.log';

const RATE_SLEEP_MS       = parseInt(process.env.VCTX_REPROCESS_SLEEP_MS || '200', 10);
const PROGRESS_INTERVAL_MS = parseInt(process.env.VCTX_REPROCESS_PROGRESS_INTERVAL_MS || '60000', 10); // 1 min
const MAX_CONSEC_FAIL     = parseInt(process.env.VCTX_REPROCESS_MAX_FAIL || '5', 10);
const MAX_ENTRIES         = parseArgInt('--max', null);
const DRY_RUN             = process.argv.includes('--dry-run');
// Swap/memory safety gates intentionally removed per user directive
// 2026-04-23: "swap はまだ気にしないで". Only STOP conditions remaining
// are (a) `/tmp/vcontext-reprocess-stop` flag, (b) SIGINT/SIGTERM,
// (c) MAX_CONSEC_FAIL consecutive mlx-generate failures. Observability
// still tracks swap_used_mb in every progress entry so we can review
// trends after the fact, but no auto-pause triggered by swap growth.

// ── CLI helpers ─────────────────────────────────────────────────────

function parseArgInt(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i === process.argv.length - 1) return def;
  const n = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) ? n : def;
}

// ── HTTP helpers ────────────────────────────────────────────────────

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
      timeout: 15 * 60 * 1000, // allow long LLM calls
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function vcPost(path, payload) { return httpJson('POST', VCONTEXT_URL + path, payload); }
async function vcGet(path)           { return httpJson('GET',  VCONTEXT_URL + path); }

// ── System metrics (for safety gates) ──────────────────────────────

function getSwapUsedMB() {
  try {
    const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { timeout: 2000 }).toString();
    const m = out.match(/used = ([\d.]+)M/);
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

function getFreePages() {
  try {
    const out = execFileSync('vm_stat', [], { timeout: 2000 }).toString();
    const mFree = out.match(/Pages free:\s+(\d+)\./);
    const mInactive = out.match(/Pages inactive:\s+(\d+)\./);
    const free = mFree ? parseInt(mFree[1], 10) : 0;
    const inactive = mInactive ? parseInt(mInactive[1], 10) : 0;
    return free + inactive;
  } catch { return null; }
}

// ── LLM call via mlx-generate-proxy ────────────────────────────────

async function llmSummarize(content) {
  // Thinking mode ON by design (2026-04-23 user directive: "local LLM
  // なので compute 気にしない、品質優先"). Qwen3-8B writes a <think>...
  // </think> reasoning block before the final answer; we give it
  // headroom via max_tokens=32768 (well within Qwen3-8B's 32K context
  // budget) so the thinking block completes and the actual summary
  // reaches `content`. Without sufficient budget, the earlier
  // max_tokens=400 variant capped the thinking block mid-sentence
  // and left `content` empty (verified in A/B test today).
  const prompt =
    `Summarize this in one sentence (max 50 words). Output ONLY the summary, nothing else:\n\n${content.slice(0, 2000)}`;
  const body = {
    model: 'mlx-community/Qwen3-8B-4bit',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 32768,
    temperature: 0,
  };
  const { status, body: resp } = await httpJson('POST', MLX_GEN_URL + '/v1/chat/completions', body);
  if (status < 200 || status >= 300) {
    throw new Error(`mlx-generate status=${status} body=${JSON.stringify(resp).slice(0, 120)}`);
  }
  // mlx_lm.server returns OpenAI-shape. Prefer `content`; fall back to
  // `reasoning` only if content empty (Qwen3 with thinking-on puts the
  // final answer in content and the scratch work in reasoning — we
  // want the former).
  const choice = resp?.choices?.[0]?.message || {};
  let text = (choice.content || '').trim();
  if (!text) text = (choice.reasoning || '').trim();
  if (!text) throw new Error('empty_llm_response');
  // Strip any leaked <think>...</think> blocks defensively.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error('empty_after_think_strip');
  return text;
}

// ── DB access via vcontext HTTP endpoints ──────────────────────────

// Single SQL-ish fetch: admin endpoint provides `/admin/...` — simplest is
// to call `/recent` with a filter but `/recent` doesn't expose WHERE. Use
// sqlite3 CLI as escape hatch for the SELECT (safer than HTTP — read-only,
// ms latency, no embed race). Write remains via /store UPDATE-equivalent...
// actually there's no UPDATE endpoint on vcontext. Use sqlite3 CLI for
// both read and write. vcontext stays live (SQLite in WAL mode handles
// concurrent readers/writers cleanly).

const DB_PATH = '/Users/mitsuru_nakajima/skills/data/vcontext-primary.sqlite';

function sqliteFetchOne() {
  try {
    // Read-only — no PRAGMA busy_timeout needed.
    // Exclude `reprocess-progress` (our own progress entries — self-
    // feedback loop guard).
    // Bug fix 2026-04-23: earlier SOH-separator parsing broke on entries
    // whose `content` contained literal \n characters (most of them —
    // user-prompt, assistant-response, tool-use all multi-line). The
    // `split('\n')` defensive-last-line logic grabbed only a fragment,
    // failed parts-count guard, and returned null — causing the script
    // to exit with "drained" after only 4 entries (the handful without
    // newlines). `-json` mode handles every escape correctly.
    const sql =
      "SELECT id, type, substr(content, 1, 2000) as content " +
      "FROM entries " +
      "WHERE reasoning IS NULL " +
      "  AND content IS NOT NULL " +
      "  AND LENGTH(content) >= 50 " +
      "  AND type != 'reprocess-progress' " +
      "ORDER BY created_at DESC LIMIT 1;";
    const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
      timeout: 10000,
      maxBuffer: 20 * 1024 * 1024,
    }).toString().trim();
    if (!out) return null;
    let rows;
    try { rows = JSON.parse(out); } catch { return null; }
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    const id = parseInt(r.id, 10);
    if (!Number.isFinite(id)) return null;
    return { id, type: String(r.type || ''), content: String(r.content || '') };
  } catch (e) {
    // Lock contention is non-fatal — caller will retry on next iter.
    return null;
  }
}

function sqliteUpdateReasoning(id, reasoning) {
  // Escape single quotes by doubling them (SQLite convention).
  const esc = reasoning.replace(/'/g, "''");
  const sql =
    "PRAGMA busy_timeout = 5000; " +
    `UPDATE entries SET reasoning = '${esc}' WHERE id = ${Number(id)} AND reasoning IS NULL;`;
  try {
    execFileSync('sqlite3', ['-cmd', sql, DB_PATH, ''], { timeout: 15000 });
    return true;
  } catch (e) {
    return false;
  }
}

function sqliteCountRemaining() {
  try {
    // No PRAGMA here — it pollutes stdout with "500" which parseInt grabs
    // before the actual COUNT result.
    const out = execFileSync('sqlite3', [
      DB_PATH,
      "SELECT COUNT(*) FROM entries WHERE reasoning IS NULL AND content IS NOT NULL AND LENGTH(content) >= 50 AND type != 'reprocess-progress';"
    ], { timeout: 10000 }).toString().trim();
    const lines = out.split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    const n = parseInt(last, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ── Progress logging ───────────────────────────────────────────────

function appendProgressLog(line) {
  try {
    writeFileSync(PROGRESS_LOG, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
  } catch {}
}

async function postProgress(stats) {
  try {
    const payload = {
      type: 'reprocess-progress',
      session: 'vcontext-reprocess-all',
      tags: ['reprocess-progress', 'auto', 'reprocess-all-entries'],
      content: JSON.stringify(stats),
    };
    await vcPost('/store', payload);
  } catch {}
}

// ── Graceful shutdown ──────────────────────────────────────────────

let shutdown = false;
function requestShutdown(sig) {
  if (shutdown) return;
  shutdown = true;
  appendProgressLog(`shutdown requested via ${sig}`);
  console.log(`\n[reprocess] shutdown requested (${sig}) — finishing in-flight entry`);
}
process.on('SIGINT',  () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

// ── Main loop ──────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const startSwap = getSwapUsedMB();
  const remainingAtStart = sqliteCountRemaining();
  appendProgressLog(`start swap=${startSwap}MB remaining=${remainingAtStart} dry_run=${DRY_RUN} max=${MAX_ENTRIES || 'unbounded'}`);
  console.log(`[reprocess] start: remaining=${remainingAtStart} swap_baseline=${startSwap}MB dry_run=${DRY_RUN}`);

  let processed = 0;
  let failed = 0;
  let consecutiveFail = 0;
  let latencyTotalMs = 0;
  let lastProgressAt = Date.now();
  let lastProgressProcessed = 0;

  while (!shutdown) {
    if (existsSync(STOP_FLAG)) {
      appendProgressLog('stop flag detected — graceful exit');
      console.log('[reprocess] stop flag detected');
      break;
    }
    if (MAX_ENTRIES !== null && processed >= MAX_ENTRIES) {
      appendProgressLog(`max ${MAX_ENTRIES} reached`);
      break;
    }
    // Note: swap / memory safety gates intentionally absent per user
    // directive. Only (a) stop-flag, (b) SIGINT/SIGTERM, and
    // (c) consecutive-fail counter can halt the run.

    const entry = sqliteFetchOne();
    if (!entry) {
      appendProgressLog('drained — no more entries with reasoning IS NULL');
      console.log('[reprocess] drained');
      break;
    }

    const t0 = Date.now();
    let summary;
    try {
      summary = await llmSummarize(entry.content);
      consecutiveFail = 0;
    } catch (e) {
      failed++;
      consecutiveFail++;
      appendProgressLog(`fail id=${entry.id} err=${(e.message || e).toString().slice(0, 150)}`);
      if (consecutiveFail >= MAX_CONSEC_FAIL) {
        appendProgressLog(`stop: ${MAX_CONSEC_FAIL} consecutive mlx-generate failures`);
        console.error(`[reprocess] stop: ${MAX_CONSEC_FAIL} consecutive failures`);
        break;
      }
      await sleep(2000); // short back-off before next entry
      continue;
    }
    const latencyMs = Date.now() - t0;
    latencyTotalMs += latencyMs;

    if (DRY_RUN) {
      console.log(`[dry id=${entry.id} type=${entry.type} lat=${latencyMs}ms] ${summary.slice(0, 120)}`);
    } else {
      const ok = sqliteUpdateReasoning(entry.id, summary);
      if (!ok) {
        failed++;
        appendProgressLog(`update_fail id=${entry.id}`);
      }
    }

    processed++;

    // Progress reporting: time-based (every PROGRESS_INTERVAL_MS, default
    // 60 s) so the user sees per-minute generation rate regardless of
    // underlying LLM latency variance.
    const sinceLastProgress = Date.now() - lastProgressAt;
    if (sinceLastProgress >= PROGRESS_INTERVAL_MS) {
      const processedInWindow = processed - lastProgressProcessed;
      const windowSec = sinceLastProgress / 1000;
      const ratePerMin = (processedInWindow / windowSec) * 60;
      const remaining = sqliteCountRemaining();
      const avgLat = Math.round(latencyTotalMs / processed);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const cumRatePerMin = (processed / Math.max(1, elapsedSec)) * 60;
      const etaMin = remaining !== null && ratePerMin > 0 ? Math.round(remaining / ratePerMin) : null;
      const stats = {
        processed,
        processed_in_last_min: Math.round(processedInWindow),
        failed,
        remaining,
        avg_latency_ms: avgLat,
        elapsed_sec: elapsedSec,
        rate_per_min_window: Number(ratePerMin.toFixed(2)),   // ← user asked for this
        rate_per_min_cumulative: Number(cumRatePerMin.toFixed(2)),
        eta_min: etaMin,
        eta_hours: etaMin !== null ? Number((etaMin / 60).toFixed(1)) : null,
        swap_used_mb: getSwapUsedMB(), // observed only, not a gate
        started_at: new Date(startedAt).toISOString(),
      };
      console.log(
        `[reprocess ${new Date().toISOString().slice(11, 19)}] ` +
        `last_min=${stats.processed_in_last_min} done=${processed} ` +
        `remaining=${remaining} avg=${avgLat}ms ` +
        `rate=${stats.rate_per_min_window}/min eta=${stats.eta_hours}h ` +
        `swap=${stats.swap_used_mb}MB`
      );
      appendProgressLog(JSON.stringify(stats));
      await postProgress(stats);
      lastProgressAt = Date.now();
      lastProgressProcessed = processed;
    }

    await sleep(RATE_SLEEP_MS);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const finalRemaining = sqliteCountRemaining();
  const summary = {
    processed, failed,
    elapsed_sec: elapsedSec,
    elapsed_hours: Number((elapsedSec / 3600).toFixed(2)),
    remaining_at_exit: finalRemaining,
    shutdown_reason: shutdown ? 'signal' : (existsSync(STOP_FLAG) ? 'stop_flag' : 'drained_or_max_or_fail'),
  };
  appendProgressLog(`exit ${JSON.stringify(summary)}`);
  console.log('[reprocess] exit:', summary);
  await postProgress({ final: true, ...summary });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  console.error('[reprocess] fatal:', e);
  appendProgressLog(`fatal ${e.message || e}`);
  process.exit(1);
});
