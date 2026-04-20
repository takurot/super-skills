#!/usr/bin/env node
/**
 * vcontext-server.js — Virtual Context REST API
 *
 * A local HTTP server (port 3150) that provides Claude Code with a
 * persistent "virtual memory" backed by SQLite + FTS5 on a RAM disk.
 *
 * Tiered storage: RAM (hot) → SSD (warm) → Cloud (cold, stub)
 *
 * Zero npm dependencies — uses Node.js built-in modules + sqlite3 CLI.
 *
 * Endpoints:
 *   POST   /store           — store a context entry
 *   GET    /recall          — full-text search (?q=keyword&type=&limit=10)
 *   GET    /recent          — recent entries (?n=20&type=)
 *   GET    /session/:id     — entries for a session
 *   POST   /summarize       — compact old entries into summaries
 *   GET    /stats           — database statistics
 *   DELETE /prune           — remove old entries (?older_than=7d)
 *   GET    /health          — health check
 *   POST   /tier/migrate    — manually trigger tier migration
 *   GET    /tier/stats      — per-tier statistics
 *   POST   /tier/config     — configure cloud provider
 *   POST   /resolve         — resolve conflicting decisions
 *   POST   /consult         — create multi-model consultation
 *   POST   /consult/:id/response — submit model response
 *   GET    /consult/:id     — check consultation status
 *   GET    /search/semantic — semantic similarity search (?q=text&limit=10&threshold=0.5)
 *   POST   /analytics/track — track usage event
 *   GET    /analytics/report — usage analytics report (?days=30)
 *   WS     /ws              — WebSocket real-time push notifications
 */

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// Cross-process MLX coordination — shared /tmp/aios-mlx-lock also honored
// by aios-task-runner.js, scripts/locomo-eval.py, skills/self-evolve/
// scripts/self-evolve.js, and any agent-invoked adhoc script.
import { tryMlxLock as _fileTryMlxLock,
         releaseMlxLock as _fileReleaseMlxLock,
         mlxLockStatus as _fileMlxLockStatus } from './aios-mlx-lock.js';
// Pure utilities extracted 2026-04-17 as a refactor proof — same impl,
// just in a module so it's easier to test and reuse. See lib/vcontext-utils.js.
import { esc, ftsQuery, estimateTokens, parseTags } from './lib/vcontext-utils.js';
// Pillar 3 observability. No-op when LANGFUSE_HOST is unset — safe to import
// unconditionally. See docs/analysis/2026-04-18-pillar3-observability-design.md
import { initOtel, getTracer, otelStatus } from './lib/otel.js';
const require = createRequire(import.meta.url);

// ── Configuration ──────────────────────────────────────────────
const PORT = parseInt(process.env.VCONTEXT_PORT || '3150', 10);
// 2026-04-18: primary DB migrated from 18 GB RAM disk to internal NVMe SSD.
// Per owner: "RAM diskは、SSDにしましょう、ただしSSD用のバッファーでとして
// 1GBならOKですよ、必要ならの話です" — ship SSD-only first, add 1 GB
// write buffer later only if p95 write latency regresses.
// MOUNT_POINT is retained for /Volumes/VContext compat paths (dashboard
// ramdisk-stats endpoint, hooks.js path allowlist) but is no longer
// required to exist. DB_PATH / VEC_DB_PATH honor env overrides so we
// can revert to RAM-disk mode by setting VCONTEXT_USE_RAMDISK=1 +
// VCONTEXT_DB_PATH=/Volumes/VContext/vcontext.db if needed.
const USE_RAMDISK = process.env.VCONTEXT_USE_RAMDISK === '1';
const MOUNT_POINT = '/Volumes/VContext';
const BACKUP_DIR = join(process.env.HOME, 'skills', 'data');
const DEFAULT_DB_PATH = USE_RAMDISK
  ? join(MOUNT_POINT, 'vcontext.db')
  : join(BACKUP_DIR, 'vcontext-primary.sqlite');
const DB_PATH = process.env.VCONTEXT_DB_PATH || DEFAULT_DB_PATH;
const DEFAULT_VEC_DB_PATH = USE_RAMDISK
  ? join(MOUNT_POINT, 'vcontext-vec.db')
  : join(BACKUP_DIR, 'vcontext-vec.db');
const VEC_DB_PATH = process.env.VCONTEXT_VEC_DB_PATH || DEFAULT_VEC_DB_PATH;
const BACKUP_PATH = join(BACKUP_DIR, 'vcontext-backup.sqlite');
const SSD_DB_PATH = join(BACKUP_DIR, 'vcontext-ssd.db');
const ENTRIES_WAL_PATH = join(BACKUP_DIR, 'entries-wal.jsonl'); // SQLite-independent append-only log
const ENTRIES_WAL_MAX_BYTES = 500 * 1024 * 1024; // 500MB, then rotate

// Serialized writer for entries-wal.jsonl. Node's fs.appendFile opens+
// writes+closes on every call — concurrent callers can interleave.  This
// queue guarantees lines land whole so /admin/replay-wal never encounters
// a half-written record.
const _walQueue = [];
const _WAL_QUEUE_MAX = 2000; // bound to prevent heap OOM under burst
let _walFlushing = false;
let _walDropped = 0;
function appendToWalQueue(line) {
  // Producer can outpace fs.appendFile drain; unbounded queue growth
  // was one trigger for "FATAL ERROR: Reached heap limit" crashes
  // observed today.  SSD DB and snapshots already carry the same data,
  // so a short stretch of dropped WAL lines is survivable.
  if (_walQueue.length >= _WAL_QUEUE_MAX) {
    _walDropped++;
    if (_walDropped === 1 || _walDropped % 100 === 0) {
      console.warn(`[wal-queue] dropping lines (drain too slow) — total dropped: ${_walDropped}`);
    }
    return;
  }
  _walQueue.push(line);
  if (_walFlushing) return;
  _walFlushing = true;
  setImmediate(async () => {
    const fs = require('node:fs/promises');
    while (_walQueue.length > 0) {
      const batch = _walQueue.splice(0, _walQueue.length).join('');
      try { await fs.appendFile(ENTRIES_WAL_PATH, batch); }
      catch { /* best-effort; SSD DB + snapshot cover the same data */ }
    }
    _walFlushing = false;
  });
}
const CLOUD_CONFIG_PATH = join(BACKUP_DIR, 'vcontext-cloud.json');
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Size caps for the primary DB. The 3/3.5 GB numbers were sized for the
// 18 GB RAM disk era, where DB_PATH lived on /Volumes/VContext and had
// to leave headroom for other RAM uses. After the 2026-04-18 RAM→SSD
// migration (commit d621456), DB_PATH points at ~/skills/data on APFS
// where hundreds of GB are free, so the old cap became a production
// bug — any DB > 3.5 GB caused POST /store to reject every write with
// HTTP 507 "Writes refused" (surfaced by Codex 2026-04-20 morning).
// Cap is now USE_RAMDISK-gated: conservative in RAM mode, generous on SSD.
const WARN_SIZE_BYTES = USE_RAMDISK
  ? 3 * 1024 * 1024 * 1024     // 3 GB — RAM-disk conservative
  : 40 * 1024 * 1024 * 1024;   // 40 GB — SSD soft warn
const MAX_SIZE_BYTES = USE_RAMDISK
  ? 3.5 * 1024 * 1024 * 1024   // 3.5 GB — RAM-disk safety budget
  : 50 * 1024 * 1024 * 1024;   // 50 GB — SSD hard cap (≈10× current)
// All hook event types + legacy types. Accept any non-empty string.
const LEGACY_TYPES = ['conversation', 'decision', 'observation', 'code', 'error'];
const isValidType = (t) => typeof t === 'string' && t.length > 0 && t.length < 100;
const NAMESPACE_TAG_PREFIX = 'project:';
// RAM→SSD migration: overflow-only.
// RAM is faster — keep everything in RAM until it's actually full.
// Only spill to SSD when RAM disk exceeds 85%. Below that, no migration.
// Promote from SSD back to RAM is always free (already implemented).
//
// SSD-mode: the concept of "RAM→SSD migration" doesn't apply — there's
// only one physical tier. Return 999 (never migrate) to avoid the latent
// bug where a 5.97 GB SSD DB computed pct = 170% against the old 3.5 GB
// RAM denominator and triggered migration code with nothing to migrate.
function getRamMigrateDays() {
  if (!USE_RAMDISK) return 999;
  try {
    const s = require('node:fs').statSync(DB_PATH);
    // 18 GB RAM disk budget — 85% of 18 GB ≈ 15.3 GB. Using 3.5 as
    // denominator (legacy) effectively meant "migrate once DB > ~3 GB",
    // which matches historical behavior.
    const pct = s.size / (3.5 * 1024 * 1024 * 1024) * 100;
    if (pct < 85) return 999; // keep in RAM — plenty of room
    return 0; // overflow: migrate oldest entries to free space
  } catch { return 999; }
}
const RAM_TO_SSD_DAYS = getRamMigrateDays();
const SSD_TO_CLOUD_DAYS = 30;

// ── User identity ─────────────────────────────────────────────
import { userInfo, hostname } from 'node:os';
const LOCAL_USER = userInfo().username;
const LOCAL_HOST = hostname();
const LOCAL_USER_ID = `${LOCAL_USER}@${LOCAL_HOST}`;

// ── API Key auth (for cloud/remote access) ────────────────────
const API_KEYS_PATH = join(BACKUP_DIR, 'vcontext-api-keys.json');
function loadApiKeys() {
  try {
    const data = JSON.parse(readFileSync(API_KEYS_PATH, 'utf-8'));
    // Ensure groups object exists (backward compat)
    if (!data.groups) data.groups = {};
    if (!data.keys) data.keys = {};
    return data;
  } catch { return { keys: {}, groups: {} }; }
}
function saveApiKeys(data) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(API_KEYS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function validateApiKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!key) {
    // No key = local access, owner role with wildcard groups
    return { valid: true, userId: LOCAL_USER_ID, local: true, role: 'owner', groups: ['*'] };
  }
  const keys = loadApiKeys();
  const entry = keys.keys[key];
  if (!entry) return { valid: false, userId: null, local: false, role: null, groups: [] };
  return {
    valid: true,
    userId: entry.userId,
    local: false,
    role: entry.role || 'member',
    groups: entry.groups || [],
  };
}

// ── RBAC helpers ──────────────────────────────────────────────
const ROLES = ['viewer', 'member', 'admin', 'owner'];
const ROLE_LEVEL = { viewer: 0, member: 1, admin: 2, owner: 3 };

function hasRole(auth, minRole) {
  return (ROLE_LEVEL[auth.role] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

function canAccessGroup(auth, group) {
  if (auth.groups.includes('*')) return true; // owner sees all
  return auth.groups.includes(group);
}

function getAccessibleGroups(auth) {
  if (auth.groups.includes('*')) return null; // null = no filter (sees all)
  return auth.groups;
}

// ── SQLite helpers ─────────────────────────────────────────────

// In-process SQLite via better-sqlite3 (replaces execFileSync child processes)
const Database = require('better-sqlite3');

// ABI self-test — verifies the native .node binary was built for the
// currently-running Node version. Without this, a stale binary (e.g. from
// `npm rebuild` run under a different nvm-selected Node) causes every
// DB call to throw `NODE_MODULE_VERSION mismatch`, which our recovery
// path then misreads as "DB is corrupt" and enters a recover loop that
// never binds the port.  Fail fast instead: exit 2 lets launchd apply
// throttling and surfaces the issue immediately in logs.
(function selfTestBetterSqlite3() {
  try {
    const probe = new Database(':memory:');
    const row = probe.prepare('SELECT 1 AS v').get();
    probe.close();
    if (!row || row.v !== 1) throw new Error('unexpected result: ' + JSON.stringify(row));
  } catch (e) {
    const nodeModules = process.versions.modules;
    console.error('[vcontext:fatal] better-sqlite3 ABI self-test failed.');
    console.error('[vcontext:fatal]   Node version: ' + process.version + ' (module ' + nodeModules + ')');
    console.error('[vcontext:fatal]   Error: ' + (e.message || e).toString().slice(0, 200));
    console.error('[vcontext:fatal] Fix: run `PATH="' + process.execPath.replace(/\/node$/, '') + ':$PATH" npm rebuild better-sqlite3` from ~/skills');
    process.exit(2);
  }
})();

let ramDb, ssdDb;

// In-memory caches for expensive aggregations served to the dashboard.
// Keyed by a semantic string; each entry is {at: timestamp, data: object}.
// TTL is endpoint-specific and enforced where the cache is read.
let _analyticsCache = {};

// ── Event-loop watchdog (runtime hang detector) ──────────────────
// Background: Fix B in wrapper.sh catches STARTUP hangs (process alive
// but port 3150 never bound). It does NOT catch RUNTIME hangs where
// the server was healthy, then wedged — e.g. MLX generate crashed and
// mlxGenerate() blocked the event loop, so inbound HTTP still accept()s
// but no handler ever fires. That's the state we hit today.
//
// A Worker thread runs in the same process but a separate event loop.
// Even when the main thread is fully blocked, the worker's timers
// still fire. We ping main every 5s; if main doesn't pong within 90s,
// the worker sends SIGKILL to its own PID — this is the ONLY reliable
// way to interrupt a busy-waiting main thread. Testing showed
// `process.exit(137)` from a worker does NOT interrupt a synchronous
// main-thread busy loop (exit signal is queued on main's event loop
// which is itself blocked). SIGKILL goes through the kernel and
// terminates the process regardless of user-space state. Exit code
// is then 137 (128+9); wrapper treats anything ≠0,2 as a normal
// restart.
//
// Threshold history:
//   30s (2026-04-17): original; too aggressive after RAM DB grew past
//                      ~47k entries. Fired during legitimate startup
//                      (SSD restore + sqlite-vec load + backfillIndex)
//                      causing a restart loop.
//   90s (2026-04-18): current. Gives startup ample breathing room
//                      while still catching truly-wedged MLX calls
//                      (those hang for minutes, not just tens of sec).
(function startEventLoopWatchdog() {
  if (process.env.VCONTEXT_DISABLE_WATCHDOG === '1') return;
  try {
    const { Worker } = require('node:worker_threads');
    const w = new Worker(`
      const { parentPort } = require('node:worker_threads');
      let lastPong = Date.now();
      parentPort.on('message', (m) => { if (m === 'pong') lastPong = Date.now(); });
      setInterval(() => {
        const gap = Date.now() - lastPong;
        if (gap > 90000) {
          console.error('[watchdog] main event loop unresponsive for ' + gap + 'ms — SIGKILL pid=' + process.pid);
          // SIGKILL to own pid: kernel terminates the whole process,
          // bypassing any user-space block. process.exit() would queue
          // on main's event loop which is what we're trying to escape.
          try { process.kill(process.pid, 'SIGKILL'); } catch (e) {
            console.error('[watchdog] SIGKILL failed, falling back to process.exit:', e.message);
            process.exit(137);
          }
        }
        try { parentPort.postMessage('ping'); } catch {}
      }, 5000).unref?.();
    `, { eval: true });
    w.on('message', (m) => { if (m === 'ping') w.postMessage('pong'); });
    w.on('error', (e) => console.error('[watchdog] worker error:', e.message));
    w.unref(); // don't keep main process alive on watchdog's behalf
  } catch (e) {
    // Worker unavailable — log and continue without watchdog (rare).
    console.error('[watchdog] failed to start:', e.message);
  }
})();

function checkAndRecoverDb(dbPath, isRam) {
  // Integrity check; if corrupt:
  //   1. SALVAGE raw entries from corrupt DB via `sqlite3 .recover`
  //      (generated data like embeddings can be regenerated, but raw
  //      user prompts / tool calls / messages cannot — preserve at all cost)
  //   2. Restore base from latest snapshot
  //   3. MERGE salvaged entries back (INSERT OR IGNORE by id)
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      // quick_check is 10-100x faster than integrity_check and catches
      // the same corruption classes we care about (malformed pages, bad
      // indexes). integrity_check also cross-verifies foreign keys which
      // is overkill at every startup on a GB-scale DB.
      const r = db.prepare('PRAGMA quick_check').get();
      const result = r.quick_check || r.integrity_check;
      if (result !== 'ok') throw new Error(`integrity: ${result}`);
      return true; // OK
    } finally { db.close(); }
  } catch (e) {
    console.error(`[db-recovery] ${dbPath} corrupt: ${e.message}`);
    if (!isRam) return false; // Only auto-restore RAM DB (SSD is source of truth)

    const fs = require('node:fs');
    const path = require('node:path');
    const { execSync } = require('child_process');

    try {
      // ── STEP 1: Salvage raw entries from corrupt DB ──────────────
      // Use sqlite3 CLI .recover (designed for partial corruption recovery).
      // Write salvage file to /tmp (SSD) so it survives RAM disk cleanup.
      const salvageFile = `/tmp/vcontext-salvage-${Date.now()}.db`;
      let salvagedCount = 0;
      try {
        console.log(`[db-recovery] Attempting .recover from corrupt DB...`);
        execSync(`sqlite3 "${dbPath}" ".recover" | sqlite3 "${salvageFile}"`, {
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: '/bin/bash'
        });
        if (fs.existsSync(salvageFile)) {
          try {
            const sdb = new Database(salvageFile, { readonly: true });
            try {
              const row = sdb.prepare('SELECT COUNT(*) as c FROM entries').get();
              salvagedCount = row.c;
              console.log(`[db-recovery] Salvaged ${salvagedCount} raw entries from corrupt DB`);
            } finally { sdb.close(); }
          } catch (eCount) {
            console.log(`[db-recovery] Salvage unreadable: ${eCount.message?.slice(0, 80)}`);
          }
        }
      } catch (eRec) {
        console.log(`[db-recovery] .recover failed (continuing w/o salvage): ${eRec.message?.slice(0, 80)}`);
      }

      // ── STEP 2: Locate latest snapshot ──────────────────────────
      const SNAP_DIR = path.join(process.env.HOME, 'skills', 'data', 'snapshots');
      if (!fs.existsSync(SNAP_DIR)) return false;
      const files = fs.readdirSync(SNAP_DIR)
        .filter(f => f.endsWith('.db'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) return false;
      const latest = path.join(SNAP_DIR, files[0].name);

      // ── STEP 3: Move corrupt DB aside (for forensics if space allows) ─
      try {
        const stat = fs.statSync(dbPath);
        const avail = execSync(`df -k "${path.dirname(dbPath)}" | tail -1 | awk '{print $4}'`).toString().trim();
        if (parseInt(avail) * 1024 > stat.size * 1.5) {
          fs.renameSync(dbPath, dbPath + '.corrupt.' + Date.now());
        } else {
          fs.unlinkSync(dbPath);
        }
      } catch { try { fs.unlinkSync(dbPath); } catch {} }

      // ── STEP 4: Restore from snapshot ───────────────────────────
      fs.copyFileSync(latest, dbPath);
      console.log(`[db-recovery] Restored snapshot: ${files[0].name}`);

      // ── STEP 5: Merge salvaged raw entries (preserve post-snapshot data) ─
      if (salvagedCount > 0 && fs.existsSync(salvageFile)) {
        try {
          const tgtDb = new Database(dbPath);
          try {
            tgtDb.pragma('journal_mode = WAL');
            tgtDb.pragma('busy_timeout = 5000');
            // Intersect columns (schema may have drifted between snapshot and salvage)
            const tgtCols = tgtDb.prepare("PRAGMA table_info(entries)").all().map(c => c.name);
            tgtDb.prepare(`ATTACH DATABASE ? AS salvage`).run(salvageFile);
            const srcCols = tgtDb.prepare("PRAGMA salvage.table_info(entries)").all().map(c => c.name);
            const common = tgtCols.filter(c => srcCols.includes(c));
            if (common.length > 0 && common.includes('id')) {
              const colList = common.map(c => `"${c}"`).join(',');
              const before = tgtDb.prepare('SELECT COUNT(*) as c FROM entries').get().c;
              tgtDb.exec(`INSERT OR IGNORE INTO main.entries (${colList}) SELECT ${colList} FROM salvage.entries`);
              const after = tgtDb.prepare('SELECT COUNT(*) as c FROM entries').get().c;
              const merged = after - before;
              console.log(`[db-recovery] Merged ${merged} unique raw entries (salvaged=${salvagedCount}, snapshot=${before}, final=${after})`);
            }
            try { tgtDb.exec('DETACH DATABASE salvage'); } catch {}
          } finally { tgtDb.close(); }
        } catch (eMerge) {
          console.error(`[db-recovery] Merge failed (snapshot still restored): ${eMerge.message?.slice(0, 100)}`);
        }
        try { fs.unlinkSync(salvageFile); } catch {}
      }

      return true;
    } catch (e2) {
      console.error(`[db-recovery] Restore FAILED: ${e2.message}`);
      return false;
    }
  }
}

function openDatabases() {
  // Integrity check + auto-recovery before opening
  checkAndRecoverDb(DB_PATH, true);

  ramDb = new Database(DB_PATH);
  ramDb.pragma('journal_mode = WAL');
  ramDb.pragma('busy_timeout = 5000');
  ramDb.pragma('cache_size = -64000');     // 64MB (default 2000 pages = 8MB)
  ramDb.pragma('mmap_size = 268435456');   // 256MB mmap — RAM disk so basically free
  ramDb.pragma('temp_store = MEMORY');     // temp tables in memory, not file
  ramDb.pragma('wal_autocheckpoint = 500'); // checkpoint every 500 pages (2MB) — minimize loss

  if (existsSync(SSD_DB_PATH)) {
    ssdDb = new Database(SSD_DB_PATH);
    ssdDb.pragma('journal_mode = WAL');
    ssdDb.pragma('busy_timeout = 5000');
    ssdDb.pragma('cache_size = -32000');    // 32MB for SSD
    ssdDb.pragma('mmap_size = 134217728');  // 128MB mmap
    ssdDb.pragma('temp_store = MEMORY');
    ssdDb.pragma('wal_autocheckpoint = 500');
  }
}

/**
 * Run a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE).
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbExec(sql, dbPath = DB_PATH) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = dbPath === DB_PATH ? ramDb : (dbPath === SSD_DB_PATH ? ssdDb : null);
      if (!db) {
        const tmpDb = new Database(dbPath);
        try {
          tmpDb.exec(sql);
        } finally {
          tmpDb.close();
        }
        return;
      }
      db.exec(sql);
      return;
    } catch (e) {
      if (e.message && e.message.includes('database is locked') && attempt < 2) {
        // busy_timeout should handle this, but retry as safety net
        continue;
      }
      console.error(`[db exec error @ ${dbPath}]`, e.message?.slice(0, 100));
      throw new Error(`SQLite exec error: ${e.message}`);
    }
  }
}

/**
 * Run a SQL query and return rows as a JS array.
 * @param {string} sql
 * @param {string} [dbPath=DB_PATH] - path to the database file
 */
function dbQuery(sql, dbPath = DB_PATH) {
  try {
    const db = dbPath === DB_PATH ? ramDb : (dbPath === SSD_DB_PATH ? ssdDb : null);
    if (!db) {
      // Fallback for unknown paths - open temporarily
      const tmpDb = new Database(dbPath, { readonly: true });
      try {
        return tmpDb.prepare(sql).all();
      } finally {
        tmpDb.close();
      }
    }
    return db.prepare(sql).all();
  } catch (e) {
    if (e.message && e.message.includes('database is locked')) {
      // Retry once after short delay
      try {
        const db2 = dbPath === DB_PATH ? ramDb : ssdDb;
        if (db2) return db2.prepare(sql).all();
      } catch { return []; }
    }
    if (e.message && (e.message.includes('no such table') || e.message.includes('no such column'))) {
      return [];
    }
    // Legacy ENOBUFS/spawnSync errors no longer apply with in-process SQLite,
    // but keep this pattern for defensive error handling
    // Log SQL snippet so root-cause is visible — malformed JSON etc.
    const sqlSnippet = String(sql).replace(/\s+/g, ' ').slice(0, 200);
    console.error(`[db query error @ ${dbPath}]`, e.message?.slice(0, 100), '| SQL:', sqlSnippet);
    return [];
  }
}

// esc() and ftsQuery() moved to ./lib/vcontext-utils.js (2026-04-17 refactor)

// ── Storage readiness check (was: RAM disk check) ─────────────
// 2026-04-18: primary DB is now on SSD by default; the RAM disk mount
// is only required when VCONTEXT_USE_RAMDISK=1.  In SSD mode we only
// need the DB file to exist (or be creatable via setup.sh's init_db).
function ensureRamDisk() {
  if (USE_RAMDISK && !existsSync(MOUNT_POINT)) {
    console.log('[vcontext] RAM disk not mounted, attempting to create...');
    try {
      execSync(`bash "${join(process.env.HOME, 'skills', 'scripts', 'vcontext-setup.sh')}" start`, {
        timeout: 30000,
        stdio: 'inherit',
        env: { ...process.env, VCONTEXT_USE_RAMDISK: '1' },
      });
    } catch (e) {
      console.error('[vcontext] Failed to create RAM disk:', e.message);
      process.exit(1);
    }
  }
  if (!existsSync(DB_PATH)) {
    console.log('[vcontext] Database not found at', DB_PATH, '— initializing...');
    try {
      // setup.sh reads VCONTEXT_DB_PATH / VCONTEXT_USE_RAMDISK env.
      execSync(`bash "${join(process.env.HOME, 'skills', 'scripts', 'vcontext-setup.sh')}" start`, {
        timeout: 30000,
        stdio: 'inherit',
        env: { ...process.env, VCONTEXT_DB_PATH: DB_PATH, VCONTEXT_USE_RAMDISK: USE_RAMDISK ? '1' : '' },
      });
    } catch (e) {
      console.error('[vcontext] Failed to init database:', e.message);
      process.exit(1);
    }
  }
}

// ── Schema migration for tiered storage columns ───────────────
function migrateRamSchema() {
  // Enable WAL mode for better concurrent read/write (reduces "database is locked")
  try {
    dbExec("PRAGMA journal_mode=WAL;");
    dbExec("PRAGMA busy_timeout=5000;");
  } catch {}

  // Performance indexes on entries (idempotent, zero downtime)
  try {
    dbExec(`CREATE INDEX IF NOT EXISTS idx_entries_embedding_null ON entries(id) WHERE embedding IS NULL;`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_entries_type_created ON entries(type, created_at DESC);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session, id DESC);`);
    dbExec("ANALYZE;");
  } catch {}

  // Add tiered-storage columns if they do not already exist.
  // SQLite does not support ADD COLUMN IF NOT EXISTS, so we check
  // the table_info pragma first.
  try {
    const cols = dbQuery("PRAGMA table_info(entries);");
    const colNames = cols.map(c => c.name);

    if (!colNames.includes('last_accessed')) {
      dbExec("ALTER TABLE entries ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'));");
      console.log('[vcontext] Added last_accessed column to RAM DB');
    }
    if (!colNames.includes('access_count')) {
      dbExec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;");
      console.log('[vcontext] Added access_count column to RAM DB');
    }
    if (!colNames.includes('tier')) {
      dbExec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'ram';");
      console.log('[vcontext] Added tier column to RAM DB');
    }

    // Decision resolution metadata columns
    if (!colNames.includes('reasoning')) {
      dbExec("ALTER TABLE entries ADD COLUMN reasoning TEXT;");
      console.log('[vcontext] Added reasoning column to RAM DB');
    }
    if (!colNames.includes('conditions')) {
      dbExec("ALTER TABLE entries ADD COLUMN conditions TEXT;");
      console.log('[vcontext] Added conditions column to RAM DB');
    }
    if (!colNames.includes('supersedes')) {
      dbExec("ALTER TABLE entries ADD COLUMN supersedes INTEGER;");
      console.log('[vcontext] Added supersedes column to RAM DB');
    }
    if (!colNames.includes('confidence')) {
      dbExec("ALTER TABLE entries ADD COLUMN confidence TEXT DEFAULT 'medium';");
      console.log('[vcontext] Added confidence column to RAM DB');
    }
    if (!colNames.includes('status')) {
      dbExec("ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'active';");
      console.log('[vcontext] Added status column to RAM DB');
    }
    if (!colNames.includes('embedding')) {
      dbExec("ALTER TABLE entries ADD COLUMN embedding TEXT;");
      console.log('[vcontext] Added embedding column to RAM DB');
    }
    // Pillar 3 — Causal Observability: parent_id links an entry to the
    // event that caused it (e.g. a tool-call's output points back to the
    // prompt that triggered it; a skill-version points to the skill-gap
    // that prompted its creation). Null means root / uncaused.
    // Indexed for fast ancestry walks in /trace/:id.
    if (!colNames.includes('parent_id')) {
      dbExec("ALTER TABLE entries ADD COLUMN parent_id INTEGER;");
      console.log('[vcontext] Added parent_id column to RAM DB');
    }
    try { dbExec("CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);"); } catch {}

    // Back-fill last_accessed (small batch to avoid ENOBUFS)
    try { dbExec("UPDATE entries SET last_accessed = created_at WHERE last_accessed IS NULL LIMIT 100;"); } catch {}
  } catch (e) {
    console.error('[vcontext] Schema migration for RAM DB failed:', e.message?.slice(0, 80));
  }

  // Analytics table for usage tracking
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      skill_name TEXT,
      session TEXT,
      user_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_analytics_skill ON analytics(skill_name);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event_type);`);
  } catch {}

  // Lightweight metadata index — avoids parsing raw JSON on every search
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS entry_index (
      entry_id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      session TEXT,
      tool_name TEXT,
      file_path TEXT,
      command TEXT,
      token_estimate INTEGER DEFAULT 0,
      has_embedding INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_type ON entry_index(type);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_session ON entry_index(session);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_ei_tool ON entry_index(tool_name);`);
  } catch {}

  // Per-request API metrics
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS api_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      request_chars INTEGER DEFAULT 0,
      response_chars INTEGER DEFAULT 0,
      estimated_tokens_in INTEGER DEFAULT 0,
      estimated_tokens_out INTEGER DEFAULT 0,
      result_count INTEGER DEFAULT 0,
      used_ids TEXT,
      task_kind TEXT,
      session TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_am_op ON api_metrics(operation);`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_am_created ON api_metrics(created_at);`);
  } catch {}

  // Backfill entry_index (small batch to avoid ENOBUFS at startup)
  try { backfillIndex(50); } catch {}
}

// ── SSD database initialisation ───────────────────────────────
function ensureSsdDb() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  if (!existsSync(SSD_DB_PATH)) {
    console.log('[vcontext] Creating SSD database at', SSD_DB_PATH);
    const schema = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  session TEXT,
  token_estimate INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT DEFAULT (datetime('now')),
  access_count INTEGER DEFAULT 0,
  tier TEXT DEFAULT 'ssd',
  reasoning TEXT,
  conditions TEXT,
  supersedes INTEGER,
  confidence TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'active',
  embedding TEXT,
  parent_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  content,
  tags,
  content=entries,
  content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
  INSERT INTO entries_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
`;
    dbExec(schema, SSD_DB_PATH);
    dbExec("PRAGMA journal_mode=WAL;", SSD_DB_PATH);
    dbExec("PRAGMA busy_timeout=5000;", SSD_DB_PATH);
    console.log('[vcontext] SSD database initialised');
  } else {
    // Enable WAL on existing SSD DB
    try { dbExec("PRAGMA journal_mode=WAL;", SSD_DB_PATH); } catch {}
    try { dbExec("PRAGMA busy_timeout=5000;", SSD_DB_PATH); } catch {}
    // Ensure tiered columns exist in SSD DB too
    try {
      const cols = dbQuery("PRAGMA table_info(entries);", SSD_DB_PATH);
      const colNames = cols.map(c => c.name);
      if (!colNames.includes('last_accessed')) {
        dbExec("ALTER TABLE entries ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'));", SSD_DB_PATH);
      }
      if (!colNames.includes('access_count')) {
        dbExec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;", SSD_DB_PATH);
      }
      if (!colNames.includes('tier')) {
        dbExec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'ssd';", SSD_DB_PATH);
      }
      // Decision resolution metadata columns
      if (!colNames.includes('reasoning')) {
        dbExec("ALTER TABLE entries ADD COLUMN reasoning TEXT;", SSD_DB_PATH);
      }
      if (!colNames.includes('conditions')) {
        dbExec("ALTER TABLE entries ADD COLUMN conditions TEXT;", SSD_DB_PATH);
      }
      if (!colNames.includes('supersedes')) {
        dbExec("ALTER TABLE entries ADD COLUMN supersedes INTEGER;", SSD_DB_PATH);
      }
      if (!colNames.includes('confidence')) {
        dbExec("ALTER TABLE entries ADD COLUMN confidence TEXT DEFAULT 'medium';", SSD_DB_PATH);
      }
      if (!colNames.includes('status')) {
        dbExec("ALTER TABLE entries ADD COLUMN status TEXT DEFAULT 'active';", SSD_DB_PATH);
      }
      if (!colNames.includes('embedding')) {
        dbExec("ALTER TABLE entries ADD COLUMN embedding TEXT;", SSD_DB_PATH);
      }
      // Pillar 3 — causal parent link (mirrors RAM DB)
      if (!colNames.includes('parent_id')) {
        dbExec("ALTER TABLE entries ADD COLUMN parent_id INTEGER;", SSD_DB_PATH);
      }
      try { dbExec("CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);", SSD_DB_PATH); } catch {}
    } catch (e) {
      console.error('[vcontext] SSD schema migration failed:', e.message);
    }
  }

  // Ensure index + metrics tables exist on SSD too
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS entry_index (
      entry_id INTEGER PRIMARY KEY, type TEXT NOT NULL, session TEXT,
      tool_name TEXT, file_path TEXT, command TEXT,
      token_estimate INTEGER DEFAULT 0, has_embedding INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`, SSD_DB_PATH);
    dbExec(`CREATE TABLE IF NOT EXISTS api_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL,
      latency_ms REAL NOT NULL, request_chars INTEGER DEFAULT 0,
      response_chars INTEGER DEFAULT 0, estimated_tokens_in INTEGER DEFAULT 0,
      estimated_tokens_out INTEGER DEFAULT 0, result_count INTEGER DEFAULT 0,
      used_ids TEXT, task_kind TEXT, session TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`, SSD_DB_PATH);
  } catch {}
}

// ── Cloud store (stub) ────────────────────────────────────────
function loadCloudConfig() {
  try {
    if (existsSync(CLOUD_CONFIG_PATH)) {
      return JSON.parse(readFileSync(CLOUD_CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

const cloudStore = {
  /** Upload entries to cloud storage (stub). */
  upload(entries) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) {
      console.log('[vcontext:cloud] Cloud not configured — skipping upload of', entries.length, 'entries');
      return { uploaded: 0, error: 'Cloud not configured' };
    }
    // Future: actual S3/GCS/R2 upload
    console.log(`[vcontext:cloud] Would upload ${entries.length} entries to ${cfg.provider}://${cfg.bucket}/${cfg.prefix || ''}`);
    return { uploaded: 0, error: 'Cloud upload not yet implemented' };
  },

  /** Search cloud storage (stub). */
  search(query, limit) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) return [];
    // Future: actual search against cloud index
    console.log(`[vcontext:cloud] Would search cloud for "${query}" limit=${limit}`);
    return [];
  },

  /** Download entries from cloud by IDs (stub). */
  download(ids) {
    const cfg = loadCloudConfig();
    if (!cfg || !cfg.provider) return [];
    console.log(`[vcontext:cloud] Would download ${ids.length} entries from cloud`);
    return [];
  },

  /** Check whether cloud is configured. */
  isConfigured() {
    const cfg = loadCloudConfig();
    return !!(cfg && cfg.provider);
  },
};

// ── DB size check ──────────────────────────────────────────────
// Cap messages include the live cap value so operators can tell which
// mode (RAM-disk vs SSD) the server is running in without code-diving.
const _GB = 1024 * 1024 * 1024;
const _fmtGB = (b) => (b / _GB).toFixed(1) + 'GB';
function checkDbSize() {
  try {
    const stats = statSync(DB_PATH);
    if (stats.size >= MAX_SIZE_BYTES) {
      return { ok: false, size: stats.size,
        msg: `Database at maximum size (${_fmtGB(MAX_SIZE_BYTES)}). Writes refused.` };
    }
    if (stats.size >= WARN_SIZE_BYTES) {
      return { ok: true, size: stats.size,
        msg: `Warning: Database exceeding ${_fmtGB(WARN_SIZE_BYTES)}.` };
    }
    return { ok: true, size: stats.size, msg: null };
  } catch {
    return { ok: true, size: 0, msg: null };
  }
}

// ── Backup ─────────────────────────────────────────────────────
// Verify a freshly-written SQLite file before promoting it through the
// rename chain. Guards against the bug observed 2026-04-18 where a
// truncated .sqlite was silently rotated into the .bak safety slot,
// destroying the last known-good copy. See docs/spec/2026-04-18-
// dobackup-integrity-check.md.
function verifyBackupFile(path) {
  try {
    if (!existsSync(path)) return false;
    const rows = dbQuery('PRAGMA integrity_check;', path);
    return !!(rows && rows[0] && rows[0].integrity_check === 'ok');
  } catch {
    return false;
  }
}

function emitBackupIntegrityAlert(file, reason) {
  try {
    const content = JSON.stringify({
      alerts: [{
        kind: 'backup-integrity-fail',
        file,
        reason,
        detected_at: new Date().toISOString(),
      }],
    });
    dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('anomaly-alert', ${esc(content)}, '["anomaly-alert","backup-integrity","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
  } catch {}
}

// Delete a SQLite file and ALL its sidecar files (-wal, -shm, -journal).
// Called at the start of each backup cycle and on every failure path so
// interrupted backups never leave behind a -wal that the next cycle
// appends to.
//
// 2026-04-20 bug discovery: a SIGKILL'd ramDb.backup(tmpPath) left a
// .tmp-wal sidecar on disk. The NEXT backup cycle's ramDb.backup() call
// saw the pre-existing .tmp + .tmp-wal and — instead of starting fresh
// — reused them, appending pages to the old WAL. After ~60 cycles
// (one morning of cascades), .tmp-wal had grown to **28.77 GB** with
// the .tmp only 2.8 GB, which saturated APFS I/O and blocked the
// event loop (/health 5s timeouts, /stats >5s, dashboard unloadable).
// Removing the orphan family fixed latency immediately.
function cleanupBackupTmp(baseTmpPath) {
  const fsMod = require('node:fs');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fsMod.unlinkSync(baseTmpPath + suffix); } catch {}
  }
}

function doBackup() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (existsSync(DB_PATH) && ramDb) {
      // Atomic write pattern: backup() writes to a .tmp path, rename on
      // success.  Prior logic wrote directly to BACKUP_PATH — if the
      // process died mid-write (today's power outage), the file was
      // truncated to 0 bytes and setup.sh's restore_backup silently
      // accepted it, leaving the RAM DB without an entries table.
      // rename(2) on macOS APFS is atomic on same filesystem.
      const tmpPath = BACKUP_PATH + '.tmp';
      // 2026-04-20 fix: defensive cleanup of the entire tmp fileset
      // before starting. Any orphan -wal/-shm from an interrupted
      // previous cycle would otherwise be grafted onto this cycle's
      // write path and balloon unboundedly.
      cleanupBackupTmp(tmpPath);
      ramDb.backup(tmpPath)
        .then(() => {
          try {
            const fsMod = require('node:fs');
            // AC1: verify the tmp before letting it anywhere near .sqlite
            if (!verifyBackupFile(tmpPath)) {
              console.warn('[vcontext] integrity_check failed on', tmpPath, '- aborting rotation, keeping .sqlite/.bak intact');
              emitBackupIntegrityAlert(tmpPath, 'integrity_check failed on freshly-written tmp');
              cleanupBackupTmp(tmpPath);
              return;
            }
            // AC3 (2026-04-20): truncate any WAL on the verified tmp so
            // the rename moves a single self-contained file. Without this
            // a sidecar -wal spawned by verifyBackupFile's PRAGMA query
            // is left behind, reproducing the very bug this block exists
            // to fix.
            try {
              const tmpDb = new Database(tmpPath);
              tmpDb.pragma('wal_checkpoint(TRUNCATE)');
              tmpDb.close();
            } catch (e) {
              // Non-fatal — the cleanupBackupTmp after rename handles
              // leftover sidecars too.
            }
            // AC2: verify the current .sqlite before promoting it to .bak.
            // If it's corrupt we keep the existing .bak untouched (it's
            // the last known-good safety copy) and just overwrite .sqlite
            // with the fresh verified tmp.
            if (existsSync(BACKUP_PATH)) {
              if (verifyBackupFile(BACKUP_PATH)) {
                try { fsMod.renameSync(BACKUP_PATH, BACKUP_PATH + '.bak'); } catch {}
                // Rotate any sidecars of the .sqlite too so a later
                // verifyBackupFile(.bak) sees a consistent fileset.
                for (const s of ['-wal', '-shm']) {
                  try { fsMod.renameSync(BACKUP_PATH + s, BACKUP_PATH + '.bak' + s); } catch {}
                }
              } else {
                console.warn('[vcontext] current .sqlite is corrupt - skipping .bak rotation to preserve last-good copy');
                emitBackupIntegrityAlert(BACKUP_PATH, 'integrity_check failed on current .sqlite; .bak rotation skipped');
                // Drop the corrupt .sqlite AND its sidecars; the fresh
                // tmp is about to replace it. .bak stays put.
                try { fsMod.unlinkSync(BACKUP_PATH); } catch {}
                for (const s of ['-wal', '-shm']) {
                  try { fsMod.unlinkSync(BACKUP_PATH + s); } catch {}
                }
              }
            }
            fsMod.renameSync(tmpPath, BACKUP_PATH);
            // rename(2) only moves the named file. Any residual -wal/-shm
            // of the tmp still exist — purge them so the next cycle
            // starts clean.
            cleanupBackupTmp(tmpPath);
            console.log(`[vcontext] Backup complete: ${BACKUP_PATH}`);
          } catch (e) {
            console.error('[vcontext] Backup rename failed:', e.message);
            cleanupBackupTmp(tmpPath);
          }
        })
        .catch((err) => {
          console.error('[vcontext] Async backup failed:', err.message);
          cleanupBackupTmp(tmpPath);
          // Direct file copy fallback — still use the tmp+rename pattern.
          // Same integrity gate applies: file copy can also produce a
          // truncated image if the source DB was being written mid-copy.
          try {
            copyFileSync(DB_PATH, tmpPath);
            if (!verifyBackupFile(tmpPath)) {
              console.warn('[vcontext] integrity_check failed on fallback copy', tmpPath, '- aborting rotation');
              emitBackupIntegrityAlert(tmpPath, 'integrity_check failed on fallback file-copy tmp');
              cleanupBackupTmp(tmpPath);
              return;
            }
            require('node:fs').renameSync(tmpPath, BACKUP_PATH);
            cleanupBackupTmp(tmpPath);
            console.log('[vcontext] Backup (file copy fallback) complete');
          } catch (e2) {
            console.error('[vcontext] Fallback backup also failed:', e2.message);
            cleanupBackupTmp(tmpPath);
          }
        });
    }
  } catch (e) {
    console.error('[vcontext] Backup failed:', e.message);
    // Fallback: file copy
    try {
      copyFileSync(DB_PATH, BACKUP_PATH);
      console.log('[vcontext] Backup (file copy) complete');
    } catch (e2) {
      console.error('[vcontext] Fallback backup also failed:', e2.message);
    }
  }
}

// ── Token estimation ───────────────────────────────────────────
// estimateTokens() moved to ./lib/vcontext-utils.js (2026-04-17 refactor)

// ── Index + Metrics helpers ─────────────────────────────────────

function extractIndexFields(content) {
  try {
    const d = JSON.parse(content);
    return {
      tool_name: d.tool_name || null,
      file_path: (d.tool_input && d.tool_input.file_path) || d.file_path || null,
      command: (d.tool_input && d.tool_input.command) || d.command || null,
    };
  } catch { return { tool_name: null, file_path: null, command: null }; }
}

function insertIndex(entryId, type, session, content, tokenEst, hasEmbedding) {
  try {
    const f = extractIndexFields(content);
    dbExec(`INSERT OR REPLACE INTO entry_index (entry_id, type, session, tool_name, file_path, command, token_estimate, has_embedding, created_at) VALUES (${Number(entryId)}, ${esc(type)}, ${esc(session)}, ${esc(f.tool_name)}, ${esc(f.file_path)}, ${esc(f.command)}, ${tokenEst || 0}, ${hasEmbedding ? 1 : 0}, datetime('now'));`);
  } catch {}
}

// Whitelist for caller-supplied task_kind tags. Keeps api_metrics clean
// (short, known values) and prevents log pollution / storage blow-up
// from adversarial query params.
const _TASK_KIND_WHITELIST = new Set([
  'search', 'recent', 'session-recall', 'handoff', 'working-state',
  'rules', 'skill-lookup', 'resolve', 'consult', 'summary',
  'chunk-summary', // L1 10-min hierarchical summary (PHOTON-inspired)
]);
function sanitizeTaskKind(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.slice(0, 32);
  return _TASK_KIND_WHITELIST.has(v) ? v : null;
}

function recordMetric({ operation, startTime, requestChars, responseChars, resultCount, usedIds, taskKind, session }) {
  setImmediate(() => {
    try {
      const latency = Date.now() - startTime;
      const tokIn = estimateTokens(String(requestChars || ''));
      const tokOut = estimateTokens(String(responseChars || ''));
      dbExec(`INSERT INTO api_metrics (operation, latency_ms, request_chars, response_chars, estimated_tokens_in, estimated_tokens_out, result_count, used_ids, task_kind, session) VALUES (${esc(operation)}, ${latency}, ${requestChars || 0}, ${responseChars || 0}, ${tokIn}, ${tokOut}, ${resultCount || 0}, ${esc(usedIds || null)}, ${esc(taskKind || null)}, ${esc(session || null)});`);
    } catch {}
  });
}

function backfillIndex(batchSize) {
  try {
    const missing = dbQuery(`SELECT e.id, e.type, e.session, e.content, e.token_estimate, e.embedding FROM entries e LEFT JOIN entry_index ei ON e.id = ei.entry_id WHERE ei.entry_id IS NULL ORDER BY e.id ASC LIMIT ${batchSize};`);
    for (const row of missing) {
      const f = extractIndexFields(row.content || '');
      dbExec(`INSERT OR IGNORE INTO entry_index (entry_id, type, session, tool_name, file_path, command, token_estimate, has_embedding, created_at) VALUES (${row.id}, ${esc(row.type)}, ${esc(row.session)}, ${esc(f.tool_name)}, ${esc(f.file_path)}, ${esc(f.command)}, ${row.token_estimate || 0}, ${row.embedding ? 1 : 0}, datetime('now'));`);
    }
    if (missing.length > 0) console.log(`[vcontext:index] Backfilled ${missing.length} entries`);
  } catch {}
}

// ── Access tracking ────────────────────────────────────────────
/**
 * Update last_accessed and increment access_count for given entry IDs.
 * @param {number[]} ids
 * @param {string} [dbPath=DB_PATH]
 */
function touchEntries(ids, dbPath = DB_PATH) {
  if (!ids || ids.length === 0) return;
  try {
    dbExec(
      `UPDATE entries SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id IN (${ids.join(',')});`,
      dbPath,
    );
  } catch (e) {
    console.error('[vcontext] touchEntries failed:', e.message);
  }
}

// ── Tier migration logic ──────────────────────────────────────

/**
 * Move cold entries from RAM → SSD.
 * Returns the count of moved entries.
 */
function migrateRamToSsd() {
  // Prepared-statement version — eliminates string-concat SQL injection
  // class of bugs (previously "near '01'" / "SQL logic error" when
  // supersedes had weird values). Batches in a transaction for speed.
  try {
    if (!ramDb || !ssdDb) return 0;
    // Post 2-DB merge this function becomes a pure no-op: primary and
    // archive point at the same file so moving rows between them is
    // both unnecessary and dangerous (self-delete). Guard added
    // 2026-04-18 as a forward-compat safety net — the merge spec
    // (docs/analysis/2026-04-18-db-merge-spec.md) depends on this
    // behaviour being in place BEFORE paths are unified.
    if (DB_PATH === SSD_DB_PATH) return 0;
    const staleRows = ramDb.prepare(
      `SELECT id, type, content, tags, session, token_estimate, created_at, last_accessed, access_count, reasoning, conditions, supersedes, confidence, status, content_hash FROM entries WHERE last_accessed < datetime('now', ?) ORDER BY last_accessed ASC LIMIT 500;`
    ).all(`-${RAM_TO_SSD_DAYS} days`);
    if (staleRows.length === 0) return 0;

    const insert = ssdDb.prepare(
      `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ssd', ?, ?, ?, ?, ?, ?)`
    );
    const del = ramDb.prepare(`DELETE FROM entries WHERE id = ?`);

    const migrate = ssdDb.transaction((rows) => {
      let ok = 0;
      for (const r of rows) {
        try {
          // Normalise numeric/nullable fields so the bound parameters match
          // the column types. Integer columns get null (not '').
          const tok = Number.isFinite(+r.token_estimate) ? +r.token_estimate : 0;
          const acc = Number.isFinite(+r.access_count) ? +r.access_count : 0;
          const sup = (r.supersedes != null && r.supersedes !== '' && Number.isFinite(+r.supersedes))
            ? +r.supersedes : null;
          insert.run(
            r.type, r.content, r.tags || '[]', r.session || null,
            tok, r.created_at, r.last_accessed, acc,
            r.reasoning || null, r.conditions || null, sup,
            r.confidence || 'medium', r.status || 'active',
            r.content_hash || null
          );
          ok++;
        } catch (rowErr) {
          console.error(`[vcontext:tier] skip id=${r.id} type=${r.type}: ${rowErr.message}`);
        }
      }
      return ok;
    });

    const migratedCount = migrate(staleRows);
    if (migratedCount > 0) {
      // Delete migrated rows from RAM. FTS triggers can fail on corrupt
      // indexes ("SQL logic error"); in that case, fall back to soft-delete
      // by marking status='migrated' so subsequent queries skip them and
      // the next maintenance rebuilds FTS. Bound by per-id try/catch so
      // one broken FTS entry doesn't abort the whole batch.
      const softMark = ramDb.prepare(`UPDATE entries SET status='migrated' WHERE id = ?`);
      let hardDel = 0, softDel = 0;
      for (const r of staleRows.slice(0, migratedCount)) {
        try {
          del.run(r.id);
          hardDel++;
        } catch {
          try { softMark.run(r.id); softDel++; } catch {}
        }
      }
      console.log(`[vcontext:tier] RAM cleanup: ${hardDel} deleted, ${softDel} soft-marked (FTS issue)`);
    }
    console.log(`[vcontext:tier] Migrated ${migratedCount}/${staleRows.length} entries RAM → SSD`);
    return migratedCount;
  } catch (e) {
    console.error('[vcontext:tier] RAM→SSD migration error:', e.message, e.stack?.split('\n')[1]);
    return 0;
  }
}

/**
 * Move cold entries from SSD → Cloud (if configured).
 * Returns the count of moved entries.
 */
function migrateSsdToCloud() {
  if (!cloudStore.isConfigured()) return 0;
  try {
    const staleRows = dbQuery(
      `SELECT * FROM entries WHERE last_accessed < datetime('now', '-${SSD_TO_CLOUD_DAYS} days') ORDER BY last_accessed ASC;`,
      SSD_DB_PATH,
    );
    if (staleRows.length === 0) return 0;

    const result = cloudStore.upload(staleRows);
    if (result.error) {
      console.log('[vcontext:tier] Cloud upload not ready:', result.error);
      return 0;
    }

    // Only delete from SSD if upload succeeded.
    // Number() wrapping is defensive — ids originate from the DB's own
    // auto-increment column so injection is unreachable today, but
    // enforcing numeric type makes the pattern safe-by-construction if a
    // future change sources these ids from anywhere else.
    const ids = staleRows.map(r => Number(r.id)).filter(n => Number.isFinite(n)).join(',');
    if (ids) dbExec(`DELETE FROM entries WHERE id IN (${ids});`, SSD_DB_PATH);

    console.log(`[vcontext:tier] Migrated ${staleRows.length} entries SSD → Cloud`);
    return staleRows.length;
  } catch (e) {
    console.error('[vcontext:tier] SSD→Cloud migration error:', e.message);
    return 0;
  }
}

/**
 * Auto-promote: copy an entry found in SSD/Cloud back to RAM for fast access.
 * @param {object[]} rows - rows from a lower tier to promote
 * @param {string} sourceTier - 'ssd' or 'cloud'
 */
function promoteToRam(rows, sourceTier) {
  if (!rows || rows.length === 0 || !ramDb) return;
  const existsStmt = ramDb.prepare(
    `SELECT id FROM entries WHERE created_at = ? AND type = ? AND content = ? LIMIT 1`
  );
  const insertStmt = ramDb.prepare(
    `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, created_at, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 'ram', ?, ?, ?, ?, ?, ?)`
  );
  const crypto = require('node:crypto');
  let promoted = 0;
  for (const r of rows) {
    try {
      if (existsStmt.get(r.created_at, r.type, r.content)) continue;
      const tok = Number.isFinite(+r.token_estimate) ? +r.token_estimate : 0;
      const acc = Number.isFinite(+r.access_count) ? +r.access_count : 0;
      const sup = (r.supersedes != null && r.supersedes !== '' && Number.isFinite(+r.supersedes))
        ? +r.supersedes : null;
      const hash = r.content_hash || crypto.createHash('sha256').update(String(r.content)).digest('hex');
      insertStmt.run(
        r.type, r.content, r.tags || '[]', r.session || null,
        tok, r.created_at, acc + 1,
        r.reasoning || null, r.conditions || null, sup,
        r.confidence || 'medium', r.status || 'active',
        hash
      );
      promoted++;
    } catch (e) {
      console.error(`[vcontext:tier] promote skip id=${r.id || '?'} type=${r.type || '?'}: ${e.message}`);
    }
  }
  if (promoted > 0) console.log(`[vcontext:tier] Promoted ${promoted}/${rows.length} from ${sourceTier} → RAM`);
}

// ── HTTP helpers ───────────────────────────────────────────────
// Hard cap on POST body size to prevent local OOM from a runaway client
// streaming unbounded data into /store.  Realistic /store entries are
// under 500 KB; 10 MB gives 20× headroom before we hang up the socket.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body > ${MAX_BODY_BYTES} bytes (rejected to prevent OOM)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return; // already rejected
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Mask sensitive info in output (keys, tokens, passwords).
// Stored raw in DB; masked only at display time for safety.
const _SECRET_PATTERNS = [
  { re: /sk-[a-zA-Z0-9]{20,}/g, replace: 'sk-***MASKED***' },                       // OpenAI/Anthropic
  { re: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replace: 'sk-ant-***MASKED***' },              // Anthropic
  { re: /ghp_[a-zA-Z0-9]{36,}/g, replace: 'ghp_***MASKED***' },                      // GitHub PAT
  { re: /gho_[a-zA-Z0-9]{36,}/g, replace: 'gho_***MASKED***' },                      // GitHub OAuth
  { re: /xox[baprs]-[a-zA-Z0-9-]{10,}/g, replace: 'xox-***MASKED***' },              // Slack
  { re: /AKIA[0-9A-Z]{16}/g, replace: 'AKIA***MASKED***' },                          // AWS Access Key
  { re: /AIza[0-9A-Za-z_-]{35}/g, replace: 'AIza***MASKED***' },                     // Google API
  { re: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, replace: 'eyJ***JWT-MASKED***' }, // JWT
  { re: /(password|passwd|pwd|secret|token|api[_-]?key)["':\s=]+["']?([a-zA-Z0-9+/=_-]{8,})["']?/gi, replace: '$1=***MASKED***' },
];
function maskSecrets(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    let s = obj;
    for (const p of _SECRET_PATTERNS) s = s.replace(p.re, p.replace);
    return s;
  }
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = maskSecrets(v);
    return out;
  }
  return obj;
}

function sendJson(res, status, data) {
  // Mask secrets at output time (storage keeps raw for grep-ability)
  if (data && typeof data === 'object') data = maskSecrets(data);
  // If data has results array, stream it to avoid building huge string in memory
  if (data.results && Array.isArray(data.results) && data.results.length > 500) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    // Write opening: everything except results array
    const { results, ...meta } = data;
    const metaStr = JSON.stringify(meta);
    // Insert results array into the JSON stream
    res.write(metaStr.slice(0, -1) + ',"results":[');
    for (let i = 0; i < results.length; i++) {
      if (i > 0) res.write(',');
      res.write(JSON.stringify(results[i]));
    }
    res.write(']}');
    res.end();
    return;
  }
  // Normal path for small responses
  try {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch (e) {
    console.error(`[sendJson] ${e.message?.slice(0, 60)}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Serialization failed' }));
  }
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params = {};
  const qs = url.slice(idx + 1);
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

function parsePath(url) {
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

/**
 * Parse tags JSON safely.
 */
// parseTags() moved to ./lib/vcontext-utils.js (2026-04-17 refactor)

// ── Route handlers ─────────────────────────────────────────────

/**
 * POST /store
 * Body: { type, content, tags?, session?, reasoning?, conditions?, supersedes?, confidence?, status? }
 */
async function handleStore(req, res) {
  const _startTime = Date.now();
  // Auth check
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Write permission: viewer cannot store
  if (!hasRole(auth, 'member')) {
    return sendJson(res, 403, { error: 'Viewers cannot store entries. Requires member role or above.' });
  }

  const sizeCheck = checkDbSize();
  if (!sizeCheck.ok) {
    return sendJson(res, 507, { error: sizeCheck.msg });
  }

  const body = await readBody(req);
  const { type, content, tags, session, namespace } = body;
  // Decision resolution metadata (all optional)
  const reasoning = body.reasoning || null;
  const conditions = body.conditions || null;
  const supersedes = (body.supersedes != null && Number.isFinite(Number(body.supersedes))) ? Number(body.supersedes) : null;
  const confidence = ['high', 'medium', 'low'].includes(body.confidence) ? body.confidence : 'medium';
  const status = ['active', 'deprecated', 'temporary', 'experimental'].includes(body.status) ? body.status : 'active';
  // Pillar 3 — Causal link. Optional. Points to the entry that caused this
  // one (e.g. prompt -> tool-call -> tool-error). Used by GET /trace/:id
  // to walk the causal ancestry. Invalid/non-numeric values become null.
  const parentId = (body.parent_id != null && Number.isFinite(Number(body.parent_id))) ? Number(body.parent_id) : null;

  if (!type || !content) {
    return sendJson(res, 400, { error: 'Missing required fields: type, content' });
  }
  if (!isValidType(type)) {
    return sendJson(res, 400, { error: 'Invalid type. Must be a non-empty string.' });
  }

  // Global dedup via content_hash + UNIQUE index (atomic, race-free).
  // Migration path: after /admin/dedup-migration has added the column
  // and index, any duplicate INSERT collides with the UNIQUE constraint
  // and we return the existing row. Skip types where repetition is
  // legitimate (periodic heartbeats, test entries).
  const DEDUP_SKIP = new Set(['test', 'working-state', 'session-recall', 'anomaly-alert']);
  let contentHash = null;
  if (!DEDUP_SKIP.has(type)) {
    try {
      const crypto = require('node:crypto');
      contentHash = crypto.createHash('sha256').update(String(content)).digest('hex');
      // If the hash already exists for this (session, type), return it.
      const dup = dbQuery(
        `SELECT id FROM entries WHERE session = ${esc(session || '')} AND type = ${esc(type)} AND content_hash = ${esc(contentHash)} LIMIT 1;`
      );
      if (dup.length > 0) {
        return sendJson(res, 200, { ok: true, deduped: true, existing_id: dup[0].id });
      }
    } catch {}
  }

  // Group permission check for non-owner: can only store to own groups
  const targetGroup = body.group || (auth.groups[0] !== '*' ? auth.groups[0] : null);
  if (targetGroup && !hasRole(auth, 'owner') && !canAccessGroup(auth, targetGroup)) {
    return sendJson(res, 403, { error: `Cannot store to group '${targetGroup}'. Not a member of this group.` });
  }

  // Auto-inject namespace and user identity as tags
  const tagList = Array.isArray(tags) ? [...tags] : [];
  if (namespace) {
    const nsTag = NAMESPACE_TAG_PREFIX + namespace;
    if (!tagList.includes(nsTag)) tagList.push(nsTag);
  }
  const userTag = `user:${auth.userId}`;
  if (!tagList.includes(userTag)) tagList.push(userTag);
  // Auto-inject group tag
  if (targetGroup) {
    const groupTag = `group:${targetGroup}`;
    if (!tagList.includes(groupTag)) tagList.push(groupTag);
  }
  const tagsJson = JSON.stringify(tagList);
  const tokenEst = estimateTokens(content);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  // INSERT OR IGNORE so the UNIQUE(session,type,content_hash) index can
  // atomically reject duplicates at the DB level (race-free). Includes
  // content_hash column populated above when dedup is active.
  const hashSql = contentHash ? esc(contentHash) : 'NULL';
  const parentSql = parentId === null ? 'NULL' : parentId;
  const sql = `INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash, parent_id) VALUES (${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${tokenEst}, datetime('now'), 0, 'ram', ${esc(reasoning)}, ${esc(conditions)}, ${supersedes === null ? 'NULL' : supersedes}, ${esc(confidence)}, ${esc(status)}, ${hashSql}, ${parentSql});`;
  dbExec(sql);

  // Get the inserted row
  const rows = dbQuery('SELECT * FROM entries ORDER BY id DESC LIMIT 1;');
  const entry = rows[0] || {};

  // Index this entry
  insertIndex(entry.id, type, session, content, tokenEst, 0);

  // ASYNC write-through — don't block the HTTP response on SSD I/O.
  // Two independent durability layers:
  //   (a) SSD SQLite DB (INSERT OR IGNORE with matching id — keeps RAM/SSD ids aligned)
  //   (b) Append-only JSONL log on SSD (SQLite-independent — survives DB corruption)
  // Both are fire-and-forget; the 1-min rawSyncTimer is the catch-up safety net.
  setImmediate(() => {
    // (a) SSD DB write-through, preserving id for alignment with RAM
    try {
      const ssdSql = `INSERT OR IGNORE INTO entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash, parent_id) VALUES (${entry.id}, ${esc(type)}, ${esc(content)}, ${esc(tagsJson)}, ${esc(session || null)}, ${esc(entry.created_at || now)}, ${tokenEst}, ${esc(entry.created_at || now)}, 0, 'ssd', ${esc(reasoning)}, ${esc(conditions)}, ${supersedes === null ? 'NULL' : supersedes}, ${esc(confidence)}, ${esc(status)}, ${hashSql}, ${parentSql});`;
      dbExec(ssdSql, SSD_DB_PATH);
    } catch (e) {
      console.error('[write-through] SSD sync failed:', e.message?.slice(0, 80));
    }
    // (b) JSONL append — raw, format-agnostic durable log.
    // Serialized via _walQueue because concurrent fs.appendFile calls can
    // interleave partial writes on macOS (each call is a separate open/
    // write/close, not atomic across callers).  JSONL is newline-
    // delimited, so a single interleaved line would break /admin/replay-wal
    // mid-file.  Queue preserves issue order without blocking the store
    // response.
    try {
      const line = JSON.stringify({
        id: entry.id, type, content, tags: tagList, session: session || null,
        created_at: entry.created_at || now, content_hash: contentHash,
        reasoning, conditions, supersedes, confidence, status,
        parent_id: parentId
      }) + '\n';
      appendToWalQueue(line);
    } catch {}
  });

  // Auto-summarize with MLX generate (24/7).
  // noThink: measured 91% faster + 91% fewer tokens with equal quality on
  // extractive summarization (experiment-thinking-skip.sh, 2026-04-17).
  if (mlxGenerateAvailable && content.length > 200) {
    setImmediate(async () => {
      try {
        const summary = await mlxGenerate(
          `Summarize this in one sentence (max 50 words). Output ONLY the summary, nothing else:\n\n${content.slice(0, 2000)}`,
          { maxTokens: 400, noThink: true }
        );
        if (summary && summary.length > 5) {
          dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${entry.id} AND reasoning IS NULL;`);
        }
      } catch {} // Non-fatal
    });
  }

  // Generate embedding with MLX.
  // Skip ephemeral / high-volume types from the start — they flood the
  // embed worker with no semantic-search benefit (they rely on FTS).
  // Old behaviour pruned after 1d, but still queued them first which
  // displaced useful work. Backlog was growing 500+/h.
  // Embed EVERYTHING. Measured throughput: 268ms/embed × 8.8K writes/day
  // = 40 min/day MLX work (~2.7% load). The semantic graph is the AI
  // OS's main value proposition — skipping types cripples cross-type
  // recall, workflow inference, and anomaly detection. Empty set =
  // embed all (handler still skips empty content).
  const NO_EMBED_TYPES = new Set();
  if (mlxAvailable && !NO_EMBED_TYPES.has(type)) {
    setImmediate(async () => {
      try {
        let embedding = null;
        try {
          // Code-point-aware slice + mlxEmbed's internal sanitize = no surrogate half-cut (2026-04-18)
          embedding = await mlxEmbed(safeSliceCodePoints(content, 1000));
        } catch (e) {
          console.log(`[store] MLX embed failed: ${e.message}`);
        }
        if (embedding && embedding.length > 0) {
          const embJson = esc(JSON.stringify(embedding));
          dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${entry.id};`);
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${entry.id};`, SSD_DB_PATH); } catch {}
          vecUpsert(entry.id, embedding);
          try { dbExec(`UPDATE entry_index SET has_embedding = 1 WHERE entry_id = ${entry.id};`); } catch {}
        }
      } catch {} // Non-fatal
    });
  }

  if (sizeCheck.msg) {
    entry._warning = sizeCheck.msg;
  }

  // Auto-conflict detection for decision entries
  if (type === 'decision') {
    try {
      // Search for potentially conflicting decisions
      const keywords = content.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(' ');
      if (keywords.length > 5) {
        const existing = dbQuery(
          `SELECT e.id, e.content, e.conditions, e.status, e.confidence
           FROM entries_fts fts JOIN entries e ON e.id = fts.rowid
           WHERE entries_fts MATCH ${esc(ftsQuery(keywords))}
           AND e.type = 'decision' AND e.status = 'active' AND e.id != ${entry.id}
           LIMIT 5;`
        );
        if (existing.length > 0) {
          entry._conflicts = {
            count: existing.length,
            entries: existing.map(e => ({ id: e.id, content: e.content.slice(0, 100), conditions: e.conditions })),
            resolve_hint: `POST /resolve with candidates [${entry.id}, ${existing.map(e => e.id).join(', ')}] to evaluate which applies`,
          };

          // Auto-create consultation for conflicting decisions
          try {
            const conflictIds = [entry.id, ...existing.map(e => e.id)];
            const consultId = `auto_${Date.now()}`;
            const candidates = conflictIds.map(id => {
              const n = Number(id);
              if (!Number.isFinite(n)) return null;
              const rows = dbQuery(`SELECT * FROM entries WHERE id = ${n};`);
              return rows[0] || null;
            }).filter(Boolean);

            // Build consultation
            const candidateText = candidates.map((c, i) =>
              `[${i+1}] (${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})\nContent: ${c.content}\nReasoning: ${c.reasoning || 'not recorded'}\nConditions: ${c.conditions || 'not recorded'}`
            ).join('\n\n');

            const basePrompt = `Evaluate these conflicting decisions. Context: ${conditions || content}\n\n${candidateText}\n\nRespond ONLY with JSON: {"chosen":<1-N>,"reasoning":"<why>","confidence":"high|medium|low"}`;

            const autoModels = ['claude', 'codex'];
            const autoPackages = {};
            for (const model of autoModels) {
              autoPackages[model] = { prompt: basePrompt };
            }

            const consultation = {
              id: consultId,
              consultationId: consultId,
              query: content,
              context: conditions || '',
              candidates,
              models: autoModels,
              packages: autoPackages,
              responses: {},
              consensus: null,
              status: 'pending_responses',
              created_at: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              auto: true,
            };

            // 2026-04-18: was `consultations.set(...)` — referenced an undeclared
            // Map. The consultation state actually lives in the SQL table
            // (ensureConsultationsTable at L2694); persist via saveConsultation.
            try { saveConsultation(consultation); } catch (e) {
              console.error('[auto-consult] saveConsultation failed:', e.message?.slice(0, 120));
            }
            entry._auto_consultation = consultId;

            // If MLX generate available, auto-resolve immediately
            if (mlxGenerateAvailable) {
              setImmediate(async () => {
                try {
                  const aiResponse = await mlxGenerate(basePrompt, { maxTokens: 40960, temperature: 0.1 });
                  if (aiResponse) {
                    try {
                      const aiParsed = JSON.parse(aiResponse);
                      // Store as 'local' model response
                      consultation.responses['local'] = {
                        chosen: aiParsed.chosen,
                        reasoning: aiParsed.reasoning || aiResponse.slice(0, 200),
                        confidence: aiParsed.confidence || 'medium',
                        responded_at: new Date().toISOString(),
                        model_used: MLX_GENERATE_MODEL,
                      };
                      // Add 'local' to models if not there
                      if (!consultation.models.includes('local')) consultation.models.push('local');
                      console.log(`[mlx-generate] Auto-resolved consultation ${consultId}: chose ${aiParsed.chosen}`);
                      wsBroadcast('consultation_updated', { consultation_id: consultId, local_response: consultation.responses['local'] });
                    } catch {
                      // Response wasn't valid JSON, store raw
                      consultation.responses['local'] = {
                        chosen: null,
                        reasoning: aiResponse.slice(0, 200),
                        confidence: 'low',
                        responded_at: new Date().toISOString(),
                        model_used: aiModel,
                      };
                    }
                  }
                } catch {} // Non-fatal
              });
            }

            // Broadcast to WebSocket clients
            wsBroadcast('consultation_request', {
              consultation_id: consultId,
              query: content,
              candidate_count: candidates.length,
              prompt: basePrompt,
            });
          } catch (e) {
            console.error('[auto-consult] Failed to create:', e.message);
          }
        }
      }
    } catch {} // Non-fatal
  }

  sendJson(res, 201, { stored: entry });
  recordMetric({ operation: 'store', startTime: _startTime, requestChars: content.length, responseChars: JSON.stringify(entry).length, resultCount: 1, taskKind: type, session });

  // Broadcast to WebSocket clients
  wsBroadcast('new_entry', entry);
  if (entry._conflicts) {
    wsBroadcast('conflict_detected', { ...entry, _conflicts: entry._conflicts });
  }
}

/**
 * GET /recall?q=keyword&type=conversation&limit=10
 * Searches all tiers: RAM → SSD → Cloud (if configured)
 */
async function handleRecall(req, res) {
  const _startTime = Date.now();
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const q = params.q;
  if (!q) {
    return sendJson(res, 400, { error: 'Missing query parameter: q' });
  }

  const limit = Math.min(parseInt(params.limit) || 10, 100);
  const type = params.type;
  const namespace = params.namespace; // filter by project:xxx
  const userFilter = params.user || (params.my === 'true' ? auth.userId : null);
  // task_kind — optional caller-supplied tag for /metrics/report breakdowns
  // (e.g. session-recall → enables resume_cost_tokens). Whitelisted to
  // short, known values so log tables stay clean.
  const taskKind = sanitizeTaskKind(params.task_kind) || 'search';
  // Auto-filter by accessible groups (unless owner)
  const accessibleGroups = getAccessibleGroups(auth);
  const allResults = [];
  const seenIds = new Map(); // created_at+content → true (for cross-tier dedup)

  // --- Tier 1: RAM ---
  const ramResults = searchTier(DB_PATH, q, type, limit, namespace, userFilter, accessibleGroups);
  for (const row of ramResults) {
    row._tier = 'ram';
    const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
    seenIds.set(key, true);
    allResults.push(row);
  }
  // Touch accessed entries in RAM
  touchEntries(ramResults.map(r => r.id), DB_PATH);

  // --- Tier 2: SSD (if still need more results) ---
  if (allResults.length < limit) {
    const ssdLimit = limit - allResults.length;
    const ssdResults = searchTier(SSD_DB_PATH, q, type, ssdLimit, namespace, userFilter, accessibleGroups);
    const promoted = [];
    for (const row of ssdResults) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'ssd';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    // Touch accessed entries in SSD
    touchEntries(ssdResults.map(r => r.id), SSD_DB_PATH);
    // Auto-promote SSD hits to RAM
    if (promoted.length > 0) {
      promoteToRam(promoted, 'ssd');
    }
  }

  // --- Tier 3: Cloud (if configured and still need more) ---
  if (allResults.length < limit && cloudStore.isConfigured()) {
    const cloudLimit = limit - allResults.length;
    const cloudResults = cloudStore.search(q, cloudLimit);
    const promoted = [];
    for (const row of cloudResults) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'cloud';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    if (promoted.length > 0) {
      promoteToRam(promoted, 'cloud');
    }
  }

  // --- Semantic boost: if FTS returned few results, supplement with vector search ---
  // Uses mlxEmbedFast (2s timeout, LRU-cached). If the embed worker is busy
  // with a background batch the call returns null rather than blocking the
  // request for 30–60s. Set ?semantic=false to skip entirely.
  const wantSemantic = params.semantic !== 'false';
  if (wantSemantic && allResults.length < limit && mlxAvailable && vecDb) {
    try {
      const queryEmbed = await mlxEmbedFast(q.slice(0, 500), 2000);
      if (queryEmbed && queryEmbed.length > 0) {
        const vecResults = vecSearch(queryEmbed, limit * 2);
        const vecIds = vecResults
          .filter(v => v.distance < 2.0) // reasonable threshold
          .map(v => v.rowid)
          .filter(id => !allResults.some(r => r.id === id));
        if (vecIds.length > 0) {
          const needed = limit - allResults.length;
          const idList = vecIds.slice(0, needed).join(',');
          const typeFilter2 = type && isValidType(type) ? ` AND type = ${esc(type)}` : '';
          const semanticRows = dbQuery(`SELECT *, 'semantic' as _match FROM entries WHERE id IN (${idList})${typeFilter2};`);
          for (const row of semanticRows) {
            row._tier = 'ram';
            row._semantic = true;
            allResults.push(row);
          }
        }
      }
    } catch {} // Non-fatal: semantic is a bonus
  }

  parseTags(allResults);

  // Context budget: caller can pass &budget=N (token estimate cap).
  // We rank by score = freshness*0.3 + tier*0.2 + recency-of-access*0.2 +
  // length-penalty*0.3, then prune from the bottom until under budget.
  const budget = parseInt(params.budget, 10) || 0;
  if (budget > 0 && allResults.length > 0) {
    const now = Date.now();
    const scored = allResults.map(r => {
      const ageDays = Math.max(0.1, (now - Date.parse((r.created_at || '').replace(' ', 'T') + 'Z')) / 86400000);
      const accessAgeDays = r.last_accessed
        ? Math.max(0.1, (now - Date.parse(r.last_accessed.replace(' ', 'T') + 'Z')) / 86400000)
        : ageDays;
      const tierWeight = r._tier === 'ram' ? 1.0 : r._tier === 'ssd' ? 0.7 : 0.4;
      const lenPenalty = 1 / Math.log2(2 + (r.token_estimate || 100));
      const score = (1/ageDays)*0.3 + tierWeight*0.2 + (1/accessAgeDays)*0.2 + lenPenalty*0.3;
      return { ...r, _score: score };
    }).sort((a, b) => b._score - a._score);
    let used = 0;
    const kept = [];
    for (const r of scored) {
      const cost = r.token_estimate || 100;
      if (used + cost > budget) break;
      kept.push(r);
      used += cost;
    }
    sendJson(res, 200, { results: kept, count: kept.length, query: q, budget, used_tokens: used, dropped: allResults.length - kept.length });
    recordMetric({ operation: 'recall', startTime: _startTime, requestChars: (q || '').length, responseChars: JSON.stringify(kept).length, resultCount: kept.length, usedIds: JSON.stringify(kept.map(r => r.id)), taskKind });
    return;
  }

  sendJson(res, 200, { results: allResults, count: allResults.length, query: q });
  recordMetric({ operation: 'recall', startTime: _startTime, requestChars: (q || '').length, responseChars: JSON.stringify(allResults).length, resultCount: allResults.length, usedIds: JSON.stringify(allResults.map(r => r.id)), taskKind });
}

/**
 * Search a single tier's database using FTS5, with LIKE fallback.
 * @param {string} dbPath
 * @param {string} q - search query
 * @param {string} type - entry type filter
 * @param {number} limit
 * @param {string} namespace - project namespace filter
 * @param {string} userFilter - user identity filter
 * @param {string[]|null} accessibleGroups - null = no filter (owner), array = restrict to these groups
 */
function searchTier(dbPath, q, type, limit, namespace, userFilter, accessibleGroups) {
  if (!existsSync(dbPath)) return [];
  const typeFilter = type && isValidType(type) ? ` AND e.type = ${esc(type)}` : '';
  const nsFilter = namespace ? ` AND e.tags LIKE ${esc('%project:' + namespace + '%')}` : '';
  const userFlt = userFilter ? ` AND e.tags LIKE ${esc('%user:' + userFilter + '%')}` : '';
  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      // No groups at all — can only see entries without group tags
      groupFilter = ` AND e.tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `e.tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (e.tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }

  // Skip soft-migrated rows — they've moved to SSD tier but couldn't be
  // hard-deleted due to FTS issues. The SSD tier query will return the
  // real copy.
  const migrateFilter = ` AND (e.status IS NULL OR e.status != 'migrated')`;

  const ftsSql = `SELECT e.*, rank
    FROM entries_fts fts
    JOIN entries e ON e.id = fts.rowid
    WHERE entries_fts MATCH ${esc(ftsQuery(q))}${typeFilter}${nsFilter}${userFlt}${groupFilter}${migrateFilter}
    ORDER BY rank * 0.7 + (julianday(e.created_at) - julianday('2024-01-01')) * 0.3
    LIMIT ${limit};`;

  try {
    return dbQuery(ftsSql, dbPath);
  } catch {
    // FTS query syntax error — fall back to LIKE search
    const likeSql = `SELECT * FROM entries WHERE content LIKE ${esc('%' + q + '%')}${typeFilter}${nsFilter}${userFlt}${groupFilter.replace(/e\./g, '')} AND (status IS NULL OR status != 'migrated') ORDER BY created_at DESC LIMIT ${limit};`;
    try {
      return dbQuery(likeSql, dbPath);
    } catch {
      return [];
    }
  }
}

/**
 * GET /recent?n=20&type=conversation
 * Cascading across tiers.
 */
function handleRecent(req, res) {
  const _startTime = Date.now();
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const n = Math.min(parseInt(params.n) || 20, 200);
  const type = params.type;
  const namespace = params.namespace;
  // Auto-filter by accessible groups (unless owner)
  const accessibleGroups = getAccessibleGroups(auth);
  const allResults = [];
  const seenIds = new Map();

  // --- Tier 1: RAM ---
  const ramRows = recentFromTier(DB_PATH, type, n, namespace, accessibleGroups);
  for (const row of ramRows) {
    row._tier = 'ram';
    const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
    seenIds.set(key, true);
    allResults.push(row);
  }
  touchEntries(ramRows.map(r => r.id), DB_PATH);

  // --- Tier 2: SSD ---
  if (allResults.length < n) {
    const ssdLimit = n - allResults.length;
    const ssdRows = recentFromTier(SSD_DB_PATH, type, ssdLimit, namespace, accessibleGroups);
    const promoted = [];
    for (const row of ssdRows) {
      const key = `${row.created_at}||${row.type}||${String(row.content).slice(0, 100)}`;
      if (seenIds.has(key)) continue;
      row._tier = 'ssd';
      seenIds.set(key, true);
      allResults.push(row);
      promoted.push(row);
    }
    touchEntries(ssdRows.map(r => r.id), SSD_DB_PATH);
    if (promoted.length > 0) {
      promoteToRam(promoted, 'ssd');
    }
  }

  // --- Tier 3: Cloud ---
  if (allResults.length < n && cloudStore.isConfigured()) {
    // Cloud search stub returns [] for now
    // Future: cloudStore.recent(type, n - allResults.length)
  }

  // Sort merged results by created_at descending
  allResults.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  parseTags(allResults);

  // ?short=1 — truncate content to 500 chars server-side.  Dashboard
  // displays ≤200 chars, so sending full content (avg 15–40KB/row) is
  // pure bandwidth waste. 2.9MB payload → ~300KB with short=1.
  // Keep the raw embedding field out of responses (rarely needed,
  // 16KB/row as JSON).
  const short = params.short === '1';
  const trimmed = allResults.slice(0, n).map(r => {
    const out = { ...r };
    if (short && typeof out.content === 'string' && out.content.length > 500) {
      out.content = out.content.slice(0, 500) + '…';
      out._truncated = true;
    }
    if (short) delete out.embedding;
    return out;
  });

  sendJson(res, 200, { results: trimmed, count: trimmed.length });
  // task_kind override — session-recall hooks pass ?task_kind=session-recall
  // so /metrics/report can isolate "resume cost" from ad-hoc /recent calls.
  const taskKind = sanitizeTaskKind(params.task_kind) || 'recent';
  recordMetric({ operation: 'recent', startTime: _startTime, responseChars: JSON.stringify(trimmed).length, resultCount: trimmed.length, taskKind });
}

/**
 * Query recent entries from a specific tier DB.
 * @param {string} dbPath
 * @param {string} type
 * @param {number} limit
 * @param {string} namespace
 * @param {string[]|null} accessibleGroups - null = no filter (owner), array = restrict to these groups
 */
function recentFromTier(dbPath, type, limit, namespace, accessibleGroups) {
  if (!existsSync(dbPath)) return [];
  const typeFilter = type && isValidType(type) ? ` AND type = ${esc(type)}` : '';
  const nsFilter = namespace ? ` AND tags LIKE ${esc('%project:' + namespace + '%')}` : '';
  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      groupFilter = ` AND tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }
  const where = ` WHERE 1=1${typeFilter}${nsFilter}${groupFilter}`;
  const sql = `SELECT * FROM entries${where} ORDER BY created_at DESC LIMIT ${limit};`;
  try {
    return dbQuery(sql, dbPath);
  } catch {
    return [];
  }
}

/**
 * GET /session/:id
 */
function handleSession(req, res) {
  const path = parsePath(req.url);
  const params = parseQuery(req.url);
  const sessionId = path.replace('/session/', '');
  if (!sessionId) {
    return sendJson(res, 400, { error: 'Missing session ID' });
  }
  const limit = parseInt(params.limit) || 100; // no max cap — pagination handles scaling
  const offset = parseInt(params.offset) || 0;
  const type = params.type;
  const typeFilter = type && isValidType(type) ? ` AND type = ${esc(type)}` : '';

  // Count total for this session (fast — uses idx_entries_session_id)
  const totalRows = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE session = ${esc(sessionId)}${typeFilter};`);
  const total = totalRows[0]?.c || 0;

  // Search RAM with pagination
  const ramRows = dbQuery(`SELECT * FROM entries WHERE session = ${esc(sessionId)}${typeFilter} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset};`);
  for (const r of ramRows) r._tier = 'ram';
  if (ramRows.length > 0) touchEntries(ramRows.map(r => r.id), DB_PATH);

  // SSD only if RAM didn't fill the page
  let ssdRows = [];
  if (ramRows.length < limit && existsSync(SSD_DB_PATH)) {
    const ssdOffset = Math.max(0, offset - total); // adjust offset for SSD
    const ssdLimit = limit - ramRows.length;
    try {
      ssdRows = dbQuery(`SELECT * FROM entries WHERE session = ${esc(sessionId)}${typeFilter} ORDER BY id DESC LIMIT ${ssdLimit} OFFSET ${ssdOffset};`, SSD_DB_PATH);
      for (const r of ssdRows) r._tier = 'ssd';
    } catch {}
  }

  const allRows = [...ramRows, ...ssdRows];
  parseTags(allRows);

  sendJson(res, 200, {
    session: sessionId,
    results: allRows,
    count: allRows.length,
    total,
    limit,
    offset,
    has_more: offset + allRows.length < total,
  });
}

/**
 * POST /summarize
 * Compact entries older than 24h into summary entries.
 */
async function handleSummarize(req, res) {
  const cutoff = "datetime('now', '-24 hours')";

  // Get types that have old entries
  const typeCounts = dbQuery(`SELECT type, COUNT(*) as cnt FROM entries WHERE created_at < ${cutoff} GROUP BY type;`);

  if (typeCounts.length === 0) {
    return sendJson(res, 200, { message: 'Nothing to summarize', compacted: 0 });
  }

  let totalCompacted = 0;
  const summaries = [];

  for (const { type, cnt } of typeCounts) {
    if (cnt < 3) continue; // Skip types with very few entries

    // Get old entries for this type
    const oldEntries = dbQuery(
      `SELECT id, content, tags, session FROM entries WHERE type = ${esc(type)} AND created_at < ${cutoff} ORDER BY created_at ASC;`
    );

    // Build a summary
    const contentSnippets = oldEntries.map((e) => {
      const snippet = e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content;
      return `- ${snippet}`;
    });
    const summaryContent = `[Summary of ${oldEntries.length} ${type} entries]\n${contentSnippets.join('\n')}`;

    // Collect all tags
    const allTags = new Set();
    for (const e of oldEntries) {
      try {
        const t = JSON.parse(e.tags);
        if (Array.isArray(t)) t.forEach((tag) => allTags.add(tag));
      } catch { /* skip */ }
    }
    allTags.add('summary');
    allTags.add('compacted');

    const tokenEst = estimateTokens(summaryContent);
    const tagsJson = JSON.stringify([...allTags]);

    // Insert summary
    dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES (${esc(type)}, ${esc(summaryContent)}, ${esc(tagsJson)}, 'system-compaction', ${tokenEst}, datetime('now'), 0, 'ram');`);

    // Delete old entries
    const ids = oldEntries.map((e) => e.id).join(',');
    dbExec(`DELETE FROM entries WHERE id IN (${ids});`);

    totalCompacted += oldEntries.length;
    summaries.push({ type, compacted: oldEntries.length });
  }

  sendJson(res, 200, { message: 'Compaction complete', compacted: totalCompacted, details: summaries });
}

/**
 * GET /stats
 */
function handleStats(req, res) {
  const sizeCheck = checkDbSize();

  const total = dbQuery('SELECT COUNT(*) as count FROM entries;');
  const byType = dbQuery('SELECT type, COUNT(*) as count FROM entries GROUP BY type ORDER BY count DESC;');
  const oldest = dbQuery('SELECT MIN(created_at) as oldest FROM entries;');
  const newest = dbQuery('SELECT MAX(created_at) as newest FROM entries;');
  const totalTokens = dbQuery('SELECT SUM(token_estimate) as tokens FROM entries;');
  const sessions = dbQuery('SELECT COUNT(DISTINCT session) as count FROM entries WHERE session IS NOT NULL;');

  sendJson(res, 200, {
    entries: total[0]?.count || 0,
    by_type: byType,
    oldest: oldest[0]?.oldest || null,
    newest: newest[0]?.newest || null,
    total_tokens: totalTokens[0]?.tokens || 0,
    sessions: sessions[0]?.count || 0,
    db_size_bytes: sizeCheck.size,
    db_size_human: formatBytes(sizeCheck.size),
    warning: sizeCheck.msg,
  });
}

/**
 * DELETE /prune?older_than=7d
 */
function handlePrune(req, res) {
  const params = parseQuery(req.url);
  const olderThan = params.older_than || '7d';

  // Parse duration: 7d, 24h, 30m
  const match = olderThan.match(/^(\d+)([dhm])$/);
  if (!match) {
    return sendJson(res, 400, { error: 'Invalid older_than format. Use: 7d, 24h, 30m' });
  }
  const [, num, unit] = match;
  const unitMap = { d: 'days', h: 'hours', m: 'minutes' };
  const sqlUnit = unitMap[unit];

  // Count before delete
  const before = dbQuery(`SELECT COUNT(*) as count FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`);
  const countToDelete = before[0]?.count || 0;

  if (countToDelete === 0) {
    return sendJson(res, 200, { pruned: 0, message: 'Nothing to prune' });
  }

  // Backup before pruning
  doBackup();

  dbExec(`DELETE FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`);

  // Rebuild FTS
  dbExec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild');");

  // Clean entry_index orphans created by the DELETE above.  Without this
  // the 5-min incremental sweep takes many cycles to catch up after a
  // large prune, leaving ghost rows that bloat /analytics/weekly-summary
  // and skill-effectiveness queries.
  try {
    const r = ramDb.prepare(`DELETE FROM entry_index WHERE entry_id NOT IN (SELECT id FROM entries)`).run();
    if (r.changes > 0) console.log(`[handlePrune] purged ${r.changes} orphan entry_index rows`);
  } catch {}

  // Write-through: also prune matching entries from SSD
  let ssdPruned = 0;
  try {
    if (existsSync(SSD_DB_PATH)) {
      const ssdBefore = dbQuery(`SELECT COUNT(*) as count FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`, SSD_DB_PATH);
      ssdPruned = ssdBefore[0]?.count || 0;
      if (ssdPruned > 0) {
        dbExec(`DELETE FROM entries WHERE created_at < datetime('now', '-${num} ${sqlUnit}');`, SSD_DB_PATH);
        dbExec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild');", SSD_DB_PATH);
      }
    }
  } catch (e) {
    console.error('[write-through] SSD prune failed:', e.message);
  }

  sendJson(res, 200, { pruned: countToDelete, ssd_pruned: ssdPruned, older_than: olderThan });
}

/**
 * GET /health
 */
function handleHealth(req, res) {
  const mounted = existsSync(MOUNT_POINT);
  const dbExists = existsSync(DB_PATH);
  const ssdExists = existsSync(SSD_DB_PATH);
  let dbOk = false;
  if (dbExists) {
    try {
      const result = dbQuery("SELECT 1 as ok;");
      dbOk = result[0]?.ok === 1;
    } catch { /* not ok */ }
  }

  // Post-migration (2026-04-18): primary DB lives on SSD by default.
  // Only require mount when explicitly running in ramdisk mode — otherwise
  // the absence of /Volumes/VContext is the intended state, not a fault.
  const isHealthy = USE_RAMDISK ? (mounted && dbOk) : dbOk;
  sendJson(res, isHealthy ? 200 : 503, {
    status: isHealthy ? 'healthy' : 'degraded',
    ram_disk: mounted,
    use_ramdisk: USE_RAMDISK,  // 2026-04-18: lets dashboards hide RAM-disk
                                // health dot when SSD-only mode is intended
    database: dbOk,
    ssd_database: ssdExists,
    cloud_configured: cloudStore.isConfigured(),
    mlx_generate_available: mlxGenerateAvailable,
    mlx_generate_model: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
    mlx_available: mlxAvailable,
    ws_clients: wsClients.size,
    uptime_seconds: Math.floor(process.uptime()),
    features: {
      semantic_search: mlxAvailable,  // MLX embed only
      mlx_embed: mlxAvailable,
      usage_analytics: true,
    },
  });
}

/**
 * GET /trace/:id — Pillar 3 (Causal Observability).
 *
 * Walk the causal ancestry of an entry by following parent_id pointers.
 * Returns the chain from root -> ... -> target, plus immediate children,
 * so a caller can answer "why did this happen?" in one HTTP hop instead
 * of grepping logs across /tmp/vcontext-*.log.
 *
 * Cycle-safe: bounded to 50 hops and tracks visited ids.
 * Shape:
 *   { id, found, ancestry: [{id,type,session,parent_id,created_at,preview}],
 *     children: [...], depth, truncated }
 */
function handleTrace(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const m = (req.url || '').match(/^\/trace\/(\d+)/);
  if (!m) return sendJson(res, 400, { error: 'Usage: GET /trace/:id (numeric id)' });
  const targetId = Number(m[1]);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return sendJson(res, 400, { error: 'Invalid id' });
  }

  // Fast bail: does the entry exist?
  const root = dbQuery(`SELECT id, type, session, parent_id, created_at, substr(content,1,200) AS preview FROM entries WHERE id = ${targetId} LIMIT 1;`);
  if (root.length === 0) {
    return sendJson(res, 404, { id: targetId, found: false });
  }

  // Walk upward: target -> parent -> grandparent ...
  const MAX_DEPTH = 50;
  const seen = new Set();
  const chain = [];
  let cur = root[0];
  let truncated = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push({
      id: cur.id, type: cur.type, session: cur.session,
      parent_id: cur.parent_id, created_at: cur.created_at,
      preview: cur.preview,
    });
    if (!cur.parent_id) break;
    if (chain.length >= MAX_DEPTH) { truncated = true; break; }
    const next = dbQuery(`SELECT id, type, session, parent_id, created_at, substr(content,1,200) AS preview FROM entries WHERE id = ${Number(cur.parent_id)} LIMIT 1;`);
    cur = next[0];
  }
  // Reverse so the result reads root-first (ancestry[0] is the oldest cause)
  const ancestry = chain.reverse();

  // Immediate children (what did this entry cause?)
  const children = dbQuery(`SELECT id, type, session, created_at, substr(content,1,200) AS preview FROM entries WHERE parent_id = ${targetId} ORDER BY id ASC LIMIT 50;`);

  sendJson(res, 200, {
    id: targetId,
    found: true,
    depth: ancestry.length,
    truncated,
    ancestry,
    children,
  });
}

/**
 * GET /export — Pillar 5 (Open Substrate).
 *
 * Portable NDJSON dump of the entry stream so users can fork / archive /
 * migrate their AIOS to another instance (including postgres/pgvector/
 * DuckDB backends once those drivers exist).
 *
 * Output shape:  one header line + one entry line per row.
 *   Line 1: JSON meta ({aios_export_version, generated_at, schema: [cols],
 *                       source_host, entry_count_estimate, notes})
 *   Lines 2..N: JSON entries (id, type, content, tags, session,
 *                             created_at, parent_id, supersedes, ...)
 *
 * Safety:
 *   - Owner role only (full DB contents exposed).
 *   - Secrets masked at output via existing maskSecrets() (also applied
 *     to /recall, /recent) — covers sk-*, JWTs, AWS keys, etc.
 *   - High-sensitivity types (api_keys, credentials) excluded by default;
 *     override with ?include_sensitive=1 (logged).
 *   - Paginated: ?since=<id>&limit=<n per page>&max_entries=<hard cap>
 *
 * NDJSON chosen over a single JSON blob because real DBs run to hundreds
 * of thousands of entries — building one string OOMs on large dumps and
 * the caller can stream parse.
 */
function handleExport(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  // Owner-only: the full corpus includes decisions, private notes,
  // unredacted reasoning. Admin is not sufficient.
  if (!hasRole(auth, 'owner')) {
    return sendJson(res, 403, { error: 'Export requires owner role.' });
  }

  const url = new URL(req.url, 'http://x');
  const sinceId = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  let pageLimit = parseInt(url.searchParams.get('limit') || '500', 10);
  if (!Number.isFinite(pageLimit) || pageLimit < 1) pageLimit = 500;
  if (pageLimit > 2000) pageLimit = 2000;
  let maxEntries = parseInt(url.searchParams.get('max_entries') || '50000', 10);
  if (!Number.isFinite(maxEntries) || maxEntries < 1) maxEntries = 50000;
  if (maxEntries > 500000) maxEntries = 500000;
  const includeSensitive = url.searchParams.get('include_sensitive') === '1';

  // Exclude high-volume/ephemeral types by default — they bloat the dump
  // and have no value across AIOS instances (session-scoped telemetry).
  const EXCLUDE_TYPES = new Set([
    'test', 'session-recall', 'working-state',
    'anomaly-alert', 'skill-trigger',
  ]);
  // Hard-exclude credentials unless operator explicitly opts in.
  if (!includeSensitive) {
    EXCLUDE_TYPES.add('api-key');
    EXCLUDE_TYPES.add('credential');
  }

  // Stream NDJSON. Set headers first so downstream consumers see the MIME
  // type and the stream begins immediately for large exports.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // Content-Disposition makes browsers offer a save-as with a sane name.
    'Content-Disposition': `attachment; filename="aios-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    'X-AIOS-Export-Version': '1',
  });

  // Header line with schema + provenance
  const schemaCols = ['id','type','content','tags','session','token_estimate','created_at','last_accessed','access_count','tier','reasoning','conditions','supersedes','confidence','status','content_hash','parent_id'];
  const header = {
    aios_export_version: 1,
    generated_at: new Date().toISOString(),
    source_host: hostname(),
    exported_by: auth.userId || 'unknown',
    schema: schemaCols,
    excluded_types: Array.from(EXCLUDE_TYPES),
    since_id: sinceId,
    page_limit: pageLimit,
    max_entries: maxEntries,
    include_sensitive: includeSensitive,
    notes: 'NDJSON. Line 1 is this header, remaining lines are entries. Secrets masked via maskSecrets() (sk-*, JWTs, AWS keys). Import by POSTing entries back via /store.',
  };
  res.write(JSON.stringify(header) + '\n');

  let lastId = sinceId;
  let written = 0;
  let batches = 0;
  // Bound to ~1000 batches as a runaway-guard (pageLimit * 1000 >= maxEntries)
  while (written < maxEntries && batches < 1000) {
    batches++;
    let rows = [];
    try {
      rows = dbQuery(`SELECT ${schemaCols.join(', ')} FROM entries WHERE id > ${lastId} ORDER BY id ASC LIMIT ${pageLimit};`);
    } catch (e) {
      res.write(JSON.stringify({ __error: e.message }) + '\n');
      break;
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      if (EXCLUDE_TYPES.has(row.type)) {
        lastId = row.id;
        continue;
      }
      try {
        // maskSecrets walks arrays/objects recursively and scrubs known
        // secret patterns from string fields (same helper /recall uses).
        const masked = maskSecrets(row);
        res.write(JSON.stringify(masked) + '\n');
        written++;
        lastId = row.id;
        if (written >= maxEntries) break;
      } catch {}
    }
  }

  // Trailer line with totals (still valid NDJSON — each line is independent)
  res.write(JSON.stringify({ __trailer: true, written, last_id: lastId, batches }) + '\n');
  res.end();
}

/**
 * POST /tier/migrate — Manually trigger tier migration.
 */
function handleTierMigrate(req, res) {
  const ramToSsd = migrateRamToSsd();
  const ssdToCloud = migrateSsdToCloud();

  sendJson(res, 200, {
    ram_to_ssd: ramToSsd,
    ssd_to_cloud: ssdToCloud,
  });
}

/**
 * GET /tier/stats — Per-tier statistics.
 */
function handleTierStats(req, res) {
  // RAM stats
  const ramCount = dbQuery('SELECT COUNT(*) as count FROM entries;');
  const ramOldest = dbQuery('SELECT MIN(created_at) as oldest FROM entries;');
  const ramNewest = dbQuery('SELECT MAX(created_at) as newest FROM entries;');
  let ramSize = 0;
  try { ramSize = statSync(DB_PATH).size; } catch { /* ok */ }

  // SSD stats
  let ssdCount = 0, ssdOldest = null, ssdNewest = null, ssdSize = 0;
  if (existsSync(SSD_DB_PATH)) {
    try {
      const sc = dbQuery('SELECT COUNT(*) as count FROM entries;', SSD_DB_PATH);
      ssdCount = sc[0]?.count || 0;
      const so = dbQuery('SELECT MIN(created_at) as oldest FROM entries;', SSD_DB_PATH);
      ssdOldest = so[0]?.oldest || null;
      const sn = dbQuery('SELECT MAX(created_at) as newest FROM entries;', SSD_DB_PATH);
      ssdNewest = sn[0]?.newest || null;
      ssdSize = statSync(SSD_DB_PATH).size;
    } catch { /* ok */ }
  }

  // Cloud stats
  const cloudCfg = loadCloudConfig();

  // AC5 (2026-04-18 RAM-disk cleanup): surface the unified-mode signal so
  // callers (dashboard, smoke tests, /admin dashboards) can collapse the
  // historical RAM / SSD / Cloud 3-tier display into Primary / Archive /
  // Cloud when the "RAM" tier is no longer a RAM disk.
  //
  //   unified === true   when primary and archive DBs point at the same
  //                      file (post-merge; safe to show only one tier).
  //   unified === false  when they are separate files (today's default:
  //                      primary=vcontext-primary.sqlite, archive=ssd.db).
  //   ram_disk_mounted   reflects whether /Volumes/VContext is live so
  //                      dashboards can hide the "RAM Disk" red health
  //                      dot when SSD-only mode is the intended state.
  const unified = DB_PATH === SSD_DB_PATH;
  const ramDiskMounted = existsSync(MOUNT_POINT);

  sendJson(res, 200, {
    ram: {
      entries: ramCount[0]?.count || 0,
      size: formatBytes(ramSize),
      oldest: ramOldest[0]?.oldest || null,
      newest: ramNewest[0]?.newest || null,
    },
    ssd: {
      entries: ssdCount,
      size: formatBytes(ssdSize),
      oldest: ssdOldest,
      newest: ssdNewest,
    },
    cloud: {
      configured: !!(cloudCfg && cloudCfg.provider),
      provider: cloudCfg?.provider || null,
      bucket: cloudCfg?.bucket || null,
      entries: 0, // stub — no cloud entry count available yet
    },
    unified,
    ram_disk_mounted: ramDiskMounted,
    use_ramdisk: USE_RAMDISK,
  });
}

/**
 * GET /feed?since=<ISO-timestamp>&exclude_user=<userId>
 * Returns entries created after the given timestamp, excluding the specified user's entries.
 * Lets a session ask "what happened since I last checked, by other users/sessions?"
 */
function handleFeed(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const since = params.since;
  if (!since) {
    return sendJson(res, 400, { error: 'Missing required query parameter: since (ISO timestamp)' });
  }

  const excludeUser = params.exclude_user || null;
  const accessibleGroups = getAccessibleGroups(auth);

  let groupFilter = '';
  if (accessibleGroups) {
    if (accessibleGroups.length === 0) {
      groupFilter = ` AND tags NOT LIKE '%group:%'`;
    } else {
      const groupConditions = accessibleGroups.map(g => `tags LIKE ${esc('%group:' + g + '%')}`).join(' OR ');
      groupFilter = ` AND (tags NOT LIKE '%group:%' OR ${groupConditions})`;
    }
  }

  const excludeFilter = excludeUser ? ` AND tags NOT LIKE ${esc('%user:' + excludeUser + '%')}` : '';

  // Query RAM tier
  const ramSql = `SELECT * FROM entries WHERE created_at > ${esc(since)}${excludeFilter}${groupFilter} ORDER BY created_at DESC LIMIT 20;`;
  let allEntries = [];
  try {
    const ramRows = dbQuery(ramSql, DB_PATH);
    for (const r of ramRows) r._tier = 'ram';
    allEntries.push(...ramRows);
  } catch { /* ignore */ }

  // Query SSD tier if we need more
  if (allEntries.length < 20 && existsSync(SSD_DB_PATH)) {
    try {
      const ssdSql = `SELECT * FROM entries WHERE created_at > ${esc(since)}${excludeFilter}${groupFilter} ORDER BY created_at DESC LIMIT ${20 - allEntries.length};`;
      const ssdRows = dbQuery(ssdSql, SSD_DB_PATH);
      for (const r of ssdRows) r._tier = 'ssd';
      allEntries.push(...ssdRows);
    } catch { /* ignore */ }
  }

  // Sort merged results by created_at descending
  allEntries.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  allEntries = allEntries.slice(0, 20);
  parseTags(allEntries);

  // Determine latest timestamp
  const latest = allEntries.length > 0 ? allEntries[0].created_at : since;

  sendJson(res, 200, {
    entries: allEntries,
    count: allEntries.length,
    since,
    latest,
  });
}

/**
 * POST /tier/config — Configure cloud provider.
 * Body: { provider, bucket, region?, prefix? }
 */
async function handleTierConfig(req, res) {
  const body = await readBody(req);
  const { provider, bucket, region, prefix } = body;

  if (!provider || !bucket) {
    return sendJson(res, 400, { error: 'Missing required fields: provider, bucket' });
  }

  const validProviders = ['s3', 'gcs', 'r2'];
  if (!validProviders.includes(provider)) {
    return sendJson(res, 400, { error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
  }

  const config = {
    provider,
    bucket,
    region: region || null,
    prefix: prefix || 'vcontext/',
    configured_at: new Date().toISOString(),
  };

  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(CLOUD_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    sendJson(res, 200, { message: 'Cloud config saved', config, _note: 'Cloud storage is not yet implemented. Config saved for future use.' });
  } catch (e) {
    sendJson(res, 500, { error: `Failed to save config: ${e.message}` });
  }
}

// ── Auth handlers ─────────────────────────────────────────────

import { randomBytes, createHash } from 'node:crypto';

/**
 * POST /auth/create-key — Create a new API key for a user.
 * Body: { userId, name, role?, groups? }
 * Returns: { apiKey: "vctx_...", userId, name, role, groups }
 *
 * Permissions:
 *   owner  — can create any role, assign any group
 *   admin  — can create member/viewer in their own groups only
 *   member/viewer — cannot create keys (403)
 */
async function handleCreateKey(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Require at least admin role
  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to create API keys' });
  }

  const body = await readBody(req);
  const { userId, name } = body;
  if (!userId || !name) {
    return sendJson(res, 400, { error: 'Required: userId, name' });
  }

  const role = body.role || 'member';
  const groups = Array.isArray(body.groups) ? body.groups : [];

  // Validate role
  if (!ROLES.includes(role)) {
    return sendJson(res, 400, { error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
  }

  // Admin cannot assign admin/owner role
  if (!hasRole(auth, 'owner') && ROLE_LEVEL[role] >= ROLE_LEVEL['admin']) {
    return sendJson(res, 403, { error: 'Admin cannot assign admin or owner role. Requires owner.' });
  }

  // Admin cannot assign groups they don't belong to
  if (!hasRole(auth, 'owner')) {
    for (const g of groups) {
      if (!canAccessGroup(auth, g)) {
        return sendJson(res, 403, { error: `Cannot assign group '${g}'. You are not a member of this group.` });
      }
    }
  }

  const apiKey = 'vctx_' + randomBytes(32).toString('hex');
  const keys = loadApiKeys();
  keys.keys[apiKey] = {
    userId,
    name,
    role,
    groups,
    createdAt: new Date().toISOString(),
    createdBy: auth.userId,
  };

  saveApiKeys(keys);

  sendJson(res, 201, {
    apiKey,
    userId,
    name,
    role,
    groups,
    _setup: `On the remote PC, set:\n  export VCONTEXT_API_KEY="${apiKey}"\n  export VCONTEXT_URL="http://<this-pc-ip>:${PORT}"\nThen curl with: -H "Authorization: Bearer ${apiKey}"`,
  });
}

/**
 * GET /auth/whoami — Show current user identity, role, and groups.
 */
function handleWhoami(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  sendJson(res, 200, {
    userId: auth.userId,
    local: auth.local,
    role: auth.role,
    groups: auth.groups,
    host: LOCAL_HOST,
  });
}

/**
 * POST /auth/create-group — Create a new group. Owner only.
 * Body: { groupId: "dev-team/chatai", name: "開発チーム / chatai" }
 */
async function handleCreateGroup(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'owner')) {
    return sendJson(res, 403, { error: 'Only owner can create groups' });
  }

  const body = await readBody(req);
  const { groupId, name } = body;
  if (!groupId || !name) {
    return sendJson(res, 400, { error: 'Required: groupId, name' });
  }

  // Validate groupId format (alphanumeric, hyphens, slashes)
  if (!/^[a-zA-Z0-9/_-]+$/.test(groupId)) {
    return sendJson(res, 400, { error: 'groupId must contain only alphanumeric, hyphens, underscores, and slashes' });
  }

  const keys = loadApiKeys();
  if (keys.groups[groupId]) {
    return sendJson(res, 409, { error: `Group '${groupId}' already exists` });
  }

  keys.groups[groupId] = {
    name,
    createdAt: new Date().toISOString(),
    createdBy: auth.userId,
  };

  saveApiKeys(keys);

  sendJson(res, 201, { groupId, name, created: true });
}

/**
 * GET /auth/groups — List groups.
 * Owner sees all, admin/member sees their own groups.
 */
function handleListGroups(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const keys = loadApiKeys();
  const allGroups = keys.groups || {};

  if (hasRole(auth, 'owner') || auth.groups.includes('*')) {
    // Owner sees all groups
    sendJson(res, 200, { groups: allGroups });
  } else {
    // Non-owner sees only their own groups
    const filtered = {};
    for (const gid of (auth.groups || [])) {
      if (allGroups[gid]) filtered[gid] = allGroups[gid];
    }
    sendJson(res, 200, { groups: filtered });
  }
}

/**
 * POST /auth/update-key — Update a key's role or groups.
 * Body: { apiKey: "vctx_...", role?: "admin", groups?: ["dev-team/chatai"] }
 *
 * Permissions:
 *   owner — can update any key
 *   admin — can update keys within their own groups (cannot escalate to admin/owner)
 *   member/viewer — cannot update keys (403)
 */
async function handleUpdateKey(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to update keys' });
  }

  const body = await readBody(req);
  const { apiKey } = body;
  if (!apiKey) {
    return sendJson(res, 400, { error: 'Required: apiKey' });
  }

  const keys = loadApiKeys();
  const entry = keys.keys[apiKey];
  if (!entry) {
    return sendJson(res, 404, { error: 'API key not found' });
  }

  // Admin: check target key is within their groups
  if (!hasRole(auth, 'owner')) {
    const targetGroups = entry.groups || [];
    const hasOverlap = targetGroups.some(g => canAccessGroup(auth, g));
    if (!hasOverlap && targetGroups.length > 0) {
      return sendJson(res, 403, { error: 'Cannot update keys outside your groups' });
    }
  }

  // Update role if provided
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) {
      return sendJson(res, 400, { error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
    }
    // Admin cannot escalate to admin/owner
    if (!hasRole(auth, 'owner') && ROLE_LEVEL[body.role] >= ROLE_LEVEL['admin']) {
      return sendJson(res, 403, { error: 'Admin cannot assign admin or owner role. Requires owner.' });
    }
    entry.role = body.role;
  }

  // Update groups if provided
  if (Array.isArray(body.groups)) {
    // Admin cannot assign groups they don't belong to
    if (!hasRole(auth, 'owner')) {
      for (const g of body.groups) {
        if (!canAccessGroup(auth, g)) {
          return sendJson(res, 403, { error: `Cannot assign group '${g}'. You are not a member of this group.` });
        }
      }
    }
    entry.groups = body.groups;
  }

  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = auth.userId;
  keys.keys[apiKey] = entry;
  saveApiKeys(keys);

  sendJson(res, 200, {
    apiKey: apiKey.slice(0, 10) + '...',
    userId: entry.userId,
    name: entry.name,
    role: entry.role,
    groups: entry.groups,
    updated: true,
  });
}

/**
 * GET /auth/keys — List all API keys.
 * Owner sees all, admin sees keys in their groups.
 * member/viewer cannot list keys (403).
 */
function handleListKeys(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  if (!hasRole(auth, 'admin')) {
    return sendJson(res, 403, { error: 'Requires admin role or above to list keys' });
  }

  const keys = loadApiKeys();
  const result = [];

  for (const [key, entry] of Object.entries(keys.keys)) {
    // Admin: only show keys in their groups
    if (!hasRole(auth, 'owner')) {
      const entryGroups = entry.groups || [];
      const hasOverlap = entryGroups.some(g => canAccessGroup(auth, g));
      if (!hasOverlap && entryGroups.length > 0) continue;
    }
    result.push({
      apiKey: key.slice(0, 10) + '...',
      userId: entry.userId,
      name: entry.name,
      role: entry.role || 'member',
      groups: entry.groups || [],
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
    });
  }

  sendJson(res, 200, { keys: result, count: result.length });
}

// ── Consultations storage (SQLite-backed, persists across restarts) ──

function ensureConsultationsTable() {
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      context TEXT,
      models TEXT DEFAULT '[]',
      candidates TEXT DEFAULT '[]',
      packages TEXT DEFAULT '[]',
      responses TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      consensus TEXT,
      created_by TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      closed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    dbExec(`CREATE INDEX IF NOT EXISTS idx_consult_status ON consultations(status);`);
  } catch {}
}

function getConsultation(id) {
  const rows = dbQuery(`SELECT * FROM consultations WHERE id = ${esc(id)};`);
  if (!rows[0]) return null;
  const r = rows[0];
  try { r.models = JSON.parse(r.models); } catch { r.models = []; }
  try { r.candidates = JSON.parse(r.candidates); } catch { r.candidates = []; }
  try { r.packages = JSON.parse(r.packages); } catch { r.packages = []; }
  try { r.responses = JSON.parse(r.responses); } catch { r.responses = []; }
  try { r.consensus = JSON.parse(r.consensus); } catch {}
  return r;
}

function saveConsultation(c) {
  dbExec(`INSERT OR REPLACE INTO consultations (id, query, context, models, candidates, packages, responses, status, consensus, created_by, claimed_by, claimed_at, closed_at, created_at)
    VALUES (${esc(c.id)}, ${esc(c.query)}, ${esc(c.context || null)}, ${esc(JSON.stringify(c.models || []))}, ${esc(JSON.stringify(c.candidates || []))}, ${esc(JSON.stringify(c.packages || []))}, ${esc(JSON.stringify(c.responses || []))}, ${esc(c.status || 'pending')}, ${esc(c.consensus ? JSON.stringify(c.consensus) : null)}, ${esc(c.created_by || null)}, ${esc(c.claimed_by || null)}, ${esc(c.claimed_at || null)}, ${esc(c.closed_at || null)}, ${esc(c.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19))});`);
}

function listConsultations(filter) {
  const where = filter ? `WHERE status = ${esc(filter)}` : '';
  const rows = dbQuery(`SELECT * FROM consultations ${where} ORDER BY created_at DESC LIMIT 50;`);
  return rows.map(r => {
    try { r.models = JSON.parse(r.models); } catch { r.models = []; }
    try { r.responses = JSON.parse(r.responses); } catch { r.responses = []; }
    try { r.consensus = JSON.parse(r.consensus); } catch {}
    return r;
  });
}

// ── Decision Resolution handlers ─────────────────────────────

/**
 * POST /resolve
 * Body: { query, context, candidates? }
 * Evaluates conflicting decisions and provides resolution prompts + heuristic suggestions.
 */
async function handleResolve(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { query, context } = body;
  if (!query) {
    return sendJson(res, 400, { error: 'Missing required field: query' });
  }

  let candidates = [];

  if (Array.isArray(body.candidates) && body.candidates.length > 0) {
    // Fetch specific entries by ID from RAM, then SSD
    for (const id of body.candidates) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) continue;
      let rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`);
      if (rows.length > 0) {
        rows[0]._tier = 'ram';
        candidates.push(rows[0]);
        continue;
      }
      // Try SSD
      if (existsSync(SSD_DB_PATH)) {
        try {
          rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`, SSD_DB_PATH);
          if (rows.length > 0) {
            rows[0]._tier = 'ssd';
            candidates.push(rows[0]);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    // Search by query (recall-style) to find potential matches
    const accessibleGroups = getAccessibleGroups(auth);
    const ramResults = searchTier(DB_PATH, query, 'decision', 20, null, null, accessibleGroups);
    for (const r of ramResults) r._tier = 'ram';
    candidates.push(...ramResults);

    if (candidates.length < 20 && existsSync(SSD_DB_PATH)) {
      const ssdResults = searchTier(SSD_DB_PATH, query, 'decision', 20 - candidates.length, null, null, accessibleGroups);
      for (const r of ssdResults) r._tier = 'ssd';
      candidates.push(...ssdResults);
    }
  }

  // Filter to only "decision" type entries
  candidates = candidates.filter(c => c.type === 'decision');
  parseTags(candidates);

  // 0-1 results: no conflict
  if (candidates.length <= 1) {
    return sendJson(res, 200, {
      conflict: false,
      candidates,
      resolution_prompt: null,
      suggestion: null,
      note: candidates.length === 0 ? 'No decision entries found' : 'Single decision, no conflict',
    });
  }

  // 2+ results: build resolution prompt
  const prompt = `Given these conflicting decisions and the current context, determine which one applies.

Current context: ${context || 'not provided'}
Question: ${query}

Decisions:
${candidates.map((c, i) => `
[${i + 1}] (${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})
Content: ${c.content}
Reasoning: ${c.reasoning || 'not recorded'}
Conditions: ${c.conditions || 'not recorded'}
Supersedes: ${c.supersedes ? 'entry #' + c.supersedes : 'none'}
`).join('\n')}

Respond in JSON:
{
  "chosen": <number 1-N>,
  "reasoning": "<why this one applies to the current context>",
  "confidence": "high|medium|low",
  "note": "<any caveats or conditions>"
}`;

  // Build heuristic suggestions
  const suggestion = {};

  // By recency
  const byRecency = [...candidates].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  suggestion.by_recency = { id: byRecency[0].id, reason: 'most recent' };

  // By confidence
  const confOrder = { high: 3, medium: 2, low: 1 };
  const byConf = [...candidates].sort((a, b) => (confOrder[b.confidence] || 2) - (confOrder[a.confidence] || 2));
  suggestion.by_confidence = { id: byConf[0].id, reason: byConf[0].confidence === byConf[1]?.confidence ? 'tied confidence' : 'higher confidence' };

  // By status (active > experimental > temporary > deprecated)
  const statusOrder = { active: 4, experimental: 3, temporary: 2, deprecated: 1 };
  const byStatus = [...candidates].sort((a, b) => (statusOrder[b.status] || 4) - (statusOrder[a.status] || 4));
  suggestion.by_status = { id: byStatus[0].id, reason: `${byStatus[0].status || 'active'} vs ${byStatus[byStatus.length - 1].status || 'active'}` };

  // By supersedes chain
  const superseders = candidates.filter(c => c.supersedes != null);
  if (superseders.length > 0) {
    const latest = superseders[superseders.length - 1];
    suggestion.by_supersedes = { id: latest.id, reason: `explicitly supersedes #${latest.supersedes}` };
  } else {
    suggestion.by_supersedes = { id: null, reason: 'no supersedes relationships found' };
  }

  sendJson(res, 200, {
    conflict: true,
    candidates,
    resolution_prompt: prompt,
    suggestion,
  });
}

/**
 * POST /consult
 * Body: { query, context, models, candidates? }
 * Creates a consultation package for multiple AI models to evaluate conflicting decisions.
 */
async function handleConsult(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { query, context, models } = body;
  if (!query) {
    return sendJson(res, 400, { error: 'Missing required field: query' });
  }
  if (!Array.isArray(models) || models.length === 0) {
    return sendJson(res, 400, { error: 'Missing required field: models (array of model names)' });
  }

  // Gather candidates (same logic as /resolve)
  let candidates = [];

  if (Array.isArray(body.candidates) && body.candidates.length > 0) {
    for (const id of body.candidates) {
      const numId = Number(id);
      if (!Number.isFinite(numId)) continue;
      let rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`);
      if (rows.length > 0) {
        rows[0]._tier = 'ram';
        candidates.push(rows[0]);
        continue;
      }
      if (existsSync(SSD_DB_PATH)) {
        try {
          rows = dbQuery(`SELECT * FROM entries WHERE id = ${numId};`, SSD_DB_PATH);
          if (rows.length > 0) {
            rows[0]._tier = 'ssd';
            candidates.push(rows[0]);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    const accessibleGroups = getAccessibleGroups(auth);
    const ramResults = searchTier(DB_PATH, query, 'decision', 20, null, null, accessibleGroups);
    for (const r of ramResults) r._tier = 'ram';
    candidates.push(...ramResults);

    if (candidates.length < 20 && existsSync(SSD_DB_PATH)) {
      const ssdResults = searchTier(SSD_DB_PATH, query, 'decision', 20 - candidates.length, null, null, accessibleGroups);
      for (const r of ssdResults) r._tier = 'ssd';
      candidates.push(...ssdResults);
    }
  }

  candidates = candidates.filter(c => c.type === 'decision');
  parseTags(candidates);

  const consultationId = `consult_${Date.now()}`;

  // Build model-specific prompt packages
  const candidateBlock = candidates.map((c, i) => `
[${i + 1}] (ID: ${c.id}, ${c.created_at}, ${c.status || 'active'}, confidence: ${c.confidence || 'medium'})
Content: ${c.content}
Reasoning: ${c.reasoning || 'not recorded'}
Conditions: ${c.conditions || 'not recorded'}
Supersedes: ${c.supersedes ? 'entry #' + c.supersedes : 'none'}
`).join('\n');

  const packages = {};
  for (const model of models) {
    const modelName = String(model).toLowerCase();
    const prompt = `You are evaluating conflicting decisions stored in a virtual context system.

Context: ${context || 'not provided'}
Question: ${query}

Candidate decisions:
${candidateBlock}

Analyze each candidate and determine which best applies to the current context. Consider recency, confidence level, active/deprecated status, and supersedes chains.

Respond in JSON:
{
  "chosen": <number 1-N corresponding to candidate index>,
  "reasoning": "<your analysis of why this decision best applies>",
  "confidence": "high|medium|low"
}`;

    packages[modelName] = {
      url: `Use via ${modelName === 'claude' ? 'Claude Code session' : modelName === 'codex' ? 'Codex session' : modelName + ' session'}`,
      prompt,
      instructions: `Run this prompt in a ${modelName} session and POST the result back to /consult/${consultationId}/response with body: { "model": "${modelName}", "chosen": <N>, "reasoning": "...", "confidence": "high|medium|low" }`,
    };
  }

  // Store consultation (SQLite-backed)
  saveConsultation({
    id: consultationId,
    query,
    context: context || null,
    models,
    candidates,
    packages: Object.values(packages),
    responses: [],
    status: 'pending',
    consensus: null,
    created_by: auth.userId,
  });

  sendJson(res, 201, {
    consultation_id: consultationId,
    packages,
    candidates,
    status: 'pending_responses',
  });
}

/**
 * POST /consult/:id/response
 * Body: { model, chosen, reasoning, confidence }
 * Collect a model's response to a consultation.
 */
async function handleConsultResponse(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const path = parsePath(req.url);
  // Extract consultation ID: /consult/<id>/response
  const parts = path.split('/');
  // parts: ['', 'consult', '<id>', 'response']
  const consultId = parts[2];

  const consultation = getConsultation(consultId);
  if (!consultation) {
    return sendJson(res, 404, { error: 'Consultation not found' });
  }

  const body = await readBody(req);
  const { model, chosen, reasoning, confidence } = body;
  if (!model || chosen == null) {
    return sendJson(res, 400, { error: 'Missing required fields: model, chosen' });
  }

  // Add response
  const responses = consultation.responses || [];
  responses.push({
    model: String(model).toLowerCase(),
    chosen: Number(chosen),
    reasoning: reasoning || null,
    confidence: confidence || 'medium',
    responded_at: new Date().toISOString(),
    responded_by: auth.userId,
  });
  consultation.responses = responses;

  // Calculate consensus and status
  const responseCount = responses.length;
  const totalModels = (consultation.models || []).length;

  consultation.status = responseCount >= totalModels ? 'complete' : 'partial';

  // Check for consensus (majority agreement on chosen)
  const votes = {};
  for (const resp of responses) {
    const key = String(resp.chosen);
    votes[key] = (votes[key] || 0) + 1;
  }
  const maxVoteEntry = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (maxVoteEntry && maxVoteEntry[1] > responseCount / 2) {
    consultation.consensus = { chosen: Number(maxVoteEntry[0]), agreement: `${maxVoteEntry[1]}/${responseCount}` };
  } else {
    consultation.consensus = null;
  }

  saveConsultation(consultation);

  sendJson(res, 200, {
    consultation_id: consultId,
    model: String(model).toLowerCase(),
    accepted: true,
    status: consultation.status,
    consensus: consultation.consensus,
  });
}

/**
 * GET /consult/:id
 * Check consultation status and aggregated results.
 */
function handleConsultStatus(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const path = parsePath(req.url);
  // /consult/<id>
  const parts = path.split('/');
  const consultId = parts[2];

  const consultation = getConsultation(consultId);
  if (!consultation) {
    return sendJson(res, 404, { error: 'Consultation not found' });
  }

  sendJson(res, 200, {
    consultation_id: consultation.id,
    query: consultation.query,
    context: consultation.context,
    candidates: consultation.candidates,
    responses: consultation.responses,
    consensus: consultation.consensus,
    status: consultation.status,
    claimed_by: consultation.claimed_by,
    closed_at: consultation.closed_at,
    created_at: consultation.created_at,
  });
}

/**
 * GET /consult/pending?model=claude
 * Returns consultations that still need responses from the given model.
 * AI sessions poll this to discover work they need to evaluate.
 */
function handleConsultPending(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const model = params.model || 'claude';

  const all = listConsultations();
  const pending = [];
  for (const c of all) {
    if (c.status === 'pending' || c.status === 'partial') {
      // Check if this model hasn't responded yet
      const responded = (c.responses || []).some(r => r.model === model);
      // Check if this model is in the target list
      const targeted = (c.models || []).includes(model);
      if (targeted && !responded) {
        pending.push({
          consultation_id: c.id,
          query: c.query,
          context: c.context,
          candidate_count: (c.candidates || []).length,
          created_at: c.created_at,
        });
      }
    }
  }

  sendJson(res, 200, { pending, count: pending.length });
}

/**
 * POST /consult/auto-respond
 * Body: { model: "claude", responses: [{ consultation_id, chosen, reasoning, confidence }] }
 * Allows an AI session to evaluate and respond to ALL pending consultations in one call.
 */
async function handleConsultAutoRespond(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { model, responses } = body;
  if (!model || !responses || !Array.isArray(responses)) {
    return sendJson(res, 400, { error: 'Required: model, responses[]' });
  }

  const results = [];
  for (const r of responses) {
    const consultation = getConsultation(r.consultation_id);
    if (!consultation) {
      results.push({ id: r.consultation_id, status: 'not_found' });
      continue;
    }
    const already = (consultation.responses || []).some(resp => resp.model === model);
    if (already) {
      results.push({ id: r.consultation_id, status: 'already_responded' });
      continue;
    }

    consultation.responses.push({
      model, chosen: r.chosen, reasoning: r.reasoning,
      confidence: r.confidence, responded_at: new Date().toISOString(), responded_by: auth.userId,
    });

    const total = (consultation.models || []).length;
    consultation.status = consultation.responses.length >= total ? 'complete' : 'partial';

    const votes = {};
    for (const resp of consultation.responses) { votes[resp.chosen] = (votes[resp.chosen] || 0) + 1; }
    const maxVote = Math.max(...Object.values(votes));
    const winner = Object.keys(votes).find(k => votes[k] === maxVote);
    if (maxVote > total / 2) {
      consultation.consensus = { chosen: parseInt(winner), agreement: `${maxVote}/${consultation.responses.length}` };
    }

    saveConsultation(consultation);
    results.push({ id: r.consultation_id, status: consultation.status, consensus: consultation.consensus || null });

    wsBroadcast('consultation_updated', { consultation_id: r.consultation_id, status: consultation.status, consensus: consultation.consensus });
  }

  sendJson(res, 200, { processed: results.length, results });
}


/**
 * POST /consult/:id/claim - Claim a consultation (lock for this model)
 */
async function handleConsultClaim(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const parts = parsePath(req.url).split('/');
  const consultId = parts[2];
  const consultation = getConsultation(consultId);
  if (!consultation) return sendJson(res, 404, { error: 'Consultation not found' });
  const body = await readBody(req);
  if (consultation.claimed_by && consultation.claimed_by !== body.model) {
    return sendJson(res, 409, { error: 'Already claimed by ' + consultation.claimed_by });
  }
  consultation.claimed_by = body.model || auth.userId;
  consultation.claimed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveConsultation(consultation);
  sendJson(res, 200, { consultation_id: consultId, claimed_by: consultation.claimed_by });
}

/**
 * POST /consult/:id/close - Close a consultation
 */
async function handleConsultClose(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const parts = parsePath(req.url).split('/');
  const consultId = parts[2];
  const consultation = getConsultation(consultId);
  if (!consultation) return sendJson(res, 404, { error: 'Consultation not found' });
  consultation.status = 'closed';
  consultation.closed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  saveConsultation(consultation);
  wsBroadcast('consultation_updated', { consultation_id: consultId, status: 'closed' });
  sendJson(res, 200, { consultation_id: consultId, status: 'closed', closed_at: consultation.closed_at });
}

/**
 * GET /consult/list - List all consultations with optional status filter
 */
function handleConsultList(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const params = parseQuery(req.url);
  const results = listConsultations(params.status || null);
  sendJson(res, 200, { consultations: results, count: results.length });
}

// ── Utilities ──────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ── Streaming embed (MLX: always-on, GPU-accelerated) ──────────
let embedLoopRunning = false;
// Loop heartbeat — each iteration updates the timestamp so a stuck loop
// (stuck on await or caught in retry backoff) is distinguishable from an
// intentionally-idle loop.  Exposed via /pipeline/health.
const _loopHeartbeat = {
  embed: 0,
  embed_iter: 0,
  discovery: 0,
  discovery_iter: 0,
  chunk_summary: 0,
  chunk_summary_iter: 0,
  chunk_summary_l2: 0,
  chunk_summary_l2_iter: 0,
  chunk_summary_l3: 0,
  chunk_summary_l3_iter: 0,
};

async function startEmbedLoop() {
  if (embedLoopRunning) return;
  embedLoopRunning = true;

  // Exponential backoff on consecutive batch failures (2026-04-20).
  // Problem: embed server ECONNRESET / socket hang up with MLX under
  // memory pressure → 100ms-gap loop retries same 16 rows at 10 req/s
  // → burns CPU + makes /health contention worse. Fix: back off when
  // failures stack, reset on success.
  let consecutiveFailures = 0;
  const backoffMs = (n) => {
    if (n <= 0) return 100;      // healthy: 100ms between batches
    if (n === 1) return 1000;    // 1st failure: 1s
    if (n === 2) return 5000;    // 2nd: 5s
    if (n === 3) return 15000;   // 3rd: 15s
    return 30000;                // 4+: 30s (give MLX time to recover)
  };

  while (embedLoopRunning) {
    _loopHeartbeat.embed = Date.now();
    _loopHeartbeat.embed_iter++;
    // Ensure MLX embed backend is available
    if (!mlxAvailable) {
      // await so the flag reflects the latest probe before we decide to skip.
      // Without await we always see the stale false from startup race and
      // sleep 60s unnecessarily, keeping the loop idle for 60s after every
      // MLX restart even though the server came back in 10s.
      await checkMlx();
      if (!mlxAvailable) {
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
    }

    // Pause if flag file exists
    if (existsSync('/tmp/vcontext-embed-pause')) {
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    try {
      // Batch embed from the backlog.
      // Skip low-value types — they rarely get searched semantically
      // and bloat the queue (working-state: 3k+ ephemeral snapshots,
      // anomaly-alert: duplicative alerts, pre-tool: covered by tool-use).
      // Fresh first — user's recent context is most likely searched.
      // BATCH=16: empirical measurement (2026-04-18) showed throughput
      // scales from 0.73 emb/s @ batch=3 → 8.07 emb/s @ batch=16 (11x).
      // Knee of the curve is ~16; batch=32 only marginally better (8.67).
      // MLX max_batch_size=1024; memory impact negligible. Loop was the
      // bottleneck — entry creation ~1.2/s but loop only 0.37/s at batch=3.
      const BATCH = 16;
      const rows = dbQuery(`
        SELECT id, content FROM entries
        WHERE embedding IS NULL
          AND type NOT IN ('working-state', 'anomaly-alert', 'pre-tool', 'session-recall', 'test')
        ORDER BY id DESC LIMIT ${BATCH};
      `);
      if (rows.length === 0) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      let embeddings = null;
      let batchFailed = false;
      if (mlxAvailable) {
        try {
          // Bypass withMlxLock — store-time mlxEmbed calls that fail
          // (ECONNRESET during MLX restarts) leave their 60s timeouts
          // chained on _mlxEmbedLock, which blocks this background
          // loop for minutes at a time. MLX embed HTTP server handles
          // its own queue. Same fix as mlxEmbedFast.
          //
          // Also bypasses the /tmp/aios-mlx-lock file lock: that lock
          // serializes generate (port 3162, ~8GB Qwen3-8B-4bit) callers
          // which was the 2026-04-18 OOM trigger. Embed runs on the
          // independent :3161 server with a smaller 4-5GB model, so
          // generate+embed concurrency is safe. If a future incident
          // shows embed+generate pairing ALSO OOMs, wrap this call in
          // aios-mlx-lock too (docs/analysis/2026-04-18-embed-backlog).
          //
          // Defense-in-depth for the 2026-04-18 embed-backlog incident:
          //   (1) safeSliceCodePoints avoids cutting surrogate pairs —
          //       preserves the trailing emoji character that would
          //       otherwise be half-truncated by plain .slice(0, 1000).
          //   (2) sanitizeEmbedText catches any unpaired surrogate that
          //       slipped in from other sources (not just slice). Without
          //       either, a single poisoned row pinned the loop forever
          //       (MLX Python rejects lone surrogates as 400, loop retries
          //       the SAME DESC rows at 10 req/s; embed pace → 0 emb/s).
          embeddings = await _mlxEmbedBatchRaw(rows.map(r => sanitizeEmbedText(safeSliceCodePoints(String(r.content), 1000))));
        } catch (e) {
          batchFailed = true;
          // Log only on first failure and at backoff escalations —
          // otherwise a 10-minute ECONNRESET storm floods the log
          // (observed 2026-04-20: dozens of identical lines/min).
          if (consecutiveFailures === 0 || consecutiveFailures === 2 || consecutiveFailures === 4) {
            console.log(`[embed-loop] batch failed (${rows.length} rows, streak=${consecutiveFailures + 1}): ${e.message}`);
          }
        }
      }
      if (embeddings && embeddings.length === rows.length) {
        for (let i = 0; i < rows.length; i++) {
          const emb = embeddings[i];
          if (!emb || emb.length === 0) continue;
          const embJson = esc(JSON.stringify(emb));
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${rows[i].id};`); } catch {}
          try { dbExec(`UPDATE entries SET embedding = ${embJson} WHERE id = ${rows[i].id};`, SSD_DB_PATH); } catch {}
          try { vecUpsert(rows[i].id, emb); } catch {}
          try { dbExec(`UPDATE entry_index SET has_embedding = 1 WHERE entry_id = ${rows[i].id};`); } catch {}
        }
        // Success — reset backoff.
        if (consecutiveFailures > 0) {
          console.log(`[embed-loop] recovered after ${consecutiveFailures} consecutive failures`);
          consecutiveFailures = 0;
        }
      } else if (batchFailed) {
        consecutiveFailures++;
      } else if (embeddings && embeddings.length !== rows.length) {
        // 2026-04-20 review cleanup: if MLX returns a mismatched-length
        // array silently (well-formed JSON, wrong count), we'd previously
        // skip BOTH the success-reset AND the failure-increment paths —
        // backoff stayed at 100ms and the loop hot-looped. Count it as
        // a failure so the exponential backoff fires.
        batchFailed = true;
        consecutiveFailures++;
        console.log(`[embed-loop] mismatched response length (got ${embeddings.length}, expected ${rows.length}) — treating as failure`);
      }
      // Adaptive gap: 100ms healthy, up to 30s after 4+ failures.
      await new Promise(r => setTimeout(r, backoffMs(consecutiveFailures)));
    } catch (e) {
      console.log(`[embed-loop] error: ${e?.message?.slice(0, 60) || 'unknown'}`);
      await new Promise(r => setTimeout(r, 5000)); // 5s retry, not 60s
    }
  }
  embedLoopRunning = false;
}

// ── Periodic maintenance (backup moved to separate process 2026-04-20) ─
// Formerly called doBackupAndMigrate; renamed for clarity. File backup
// is now an external script (scripts/vcontext-backup.sh) managed by
// com.vcontext.backup LaunchAgent. The in-process call used to saturate
// APFS I/O and block the event loop — see
// docs/analysis/2026-04-20-aios-morning-3-bugs.md §"Backup WAL runaway".
// doBackup() is retained below for (a) graceful shutdown flush and (b)
// emergency manual invocation, but is no longer on the 5-min timer.
// Yield to the event loop between maintenance operations so pending
// HTTP requests (/health, /stats, /recall) can be served instead of
// waiting for the entire maintenance cycle. Each `await yield()` call
// returns control briefly before resuming. Event-loop-friendly design
// per Constitution P1 (loose coupling) applied at the function level:
// maintenance is NOT coupled to request servicing.
//
// 2026-04-20: added after observing /health 5-8s timeouts during
// maintenance cycles (backfill + content-hash + orphan cleanup all
// running back-to-back). Single biggest latency win observed on the
// read path without any async refactor.
const yieldToEventLoop = () =>
  new Promise((resolve) => setImmediate(resolve));

async function doBackupAndMigrate() {
  // doBackup() intentionally NOT called here anymore — see header comment.
  //
  // 2026-04-20 WAL management: wal_autocheckpoint=500 runs PASSIVE
  // checkpoints automatically, which removes superseded frames but
  // does NOT shrink the WAL file. Under load the WAL grew to 3 GB
  // today because a zombie external reader blocked TRUNCATE for
  // 2 hours. Now we explicitly TRUNCATE at the start of every
  // maintenance cycle. If an external reader is holding a snapshot,
  // TRUNCATE falls back to PASSIVE behavior (safe no-op), so this
  // is always safe to call.
  try {
    const r = ramDb.pragma('wal_checkpoint(TRUNCATE)');
    // Log only when we actually did work to avoid spam.
    // r is array like [{busy: 0, log: N, checkpointed: N}] in older
    // better-sqlite3; newer returns the 3-int form similarly.
    const row = Array.isArray(r) ? r[0] : r;
    if (row && typeof row === 'object' && row.log > 0) {
      console.log(`[vcontext:auto] WAL checkpoint busy=${row.busy} log=${row.log} ckpt=${row.checkpointed}`);
    }
  } catch (e) {
    // Non-fatal — next cycle retries.
  }
  await yieldToEventLoop();

  // Sync any entries that write-through missed (RAM → SSD catch-up)
  try {
    syncRamToSsd();
  } catch (e) {
    console.error('[vcontext:auto] RAM→SSD sync failed:', e.message);
  }
  await yieldToEventLoop();

  // Sync new embeddings to vec index + SSD
  try {
    vecSync();
  } catch {}
  await yieldToEventLoop();

  try {
    syncEmbeddingsToSsd(100);
  } catch {}
  await yieldToEventLoop();

  // Incremental index backfill — batch reduced 200 → 50. The entry_index
  // currently catches up at ~3000 rows/hour (50 × 60 cycles/hour) which
  // is still faster than new-entry write rate (~200/hour). Smaller batch
  // = shorter SQL block on the main thread.
  try { backfillIndex(50); } catch {}
  await yieldToEventLoop();

  // Sweep orphan entry_index rows — entries that were deleted (via dedup
  // or migration) leave stale index rows that bloat queries. Limit the
  // per-cycle delete so we never stall the tick on a huge cleanup.
  // Batch reduced 1000 → 200.
  try {
    const r = ramDb.prepare(`DELETE FROM entry_index WHERE entry_id IN (SELECT entry_id FROM entry_index WHERE entry_id NOT IN (SELECT id FROM entries) LIMIT 200)`).run();
    if (r.changes > 0) console.log(`[vcontext:auto] Purged ${r.changes} orphan entry_index rows`);
  } catch {}
  await yieldToEventLoop();

  // skill-trigger garbage collection — each predictive-search run creates
  // triggers from session-specific prompts (e.g. "APIエラー|401|502").
  // They persist as status='active' forever, so a typical week grows the
  // routing table by ~600 rows, slowing buildRouteTable and polluting
  // matches.  Deprecate triggers older than 30 days that have no recorded
  // skill-usage hits — lightweight: UPDATE, not DELETE, so we can still
  // audit them.
  try {
    const r = ramDb.prepare(`
      UPDATE entries
      SET status = 'deprecated'
      WHERE type = 'skill-trigger'
        AND status = 'active'
        AND created_at < datetime('now', '-30 days')
    `).run();
    if (r.changes > 0) console.log(`[vcontext:auto] Deprecated ${r.changes} stale skill-triggers`);
  } catch {}
  await yieldToEventLoop();

  // Recheck AI availability
  checkMlxGenerate();
  // 2026-04-18: await checkMlx so the self-heal decision below sees
  // the fresh probe result, not stale false. Without await, mlxAvailable
  // could still be false from startup (when MLX was booting concurrently
  // with vcontext) even though MLX is now healthy — leaving embed loop
  // stopped indefinitely.
  await checkMlx(); // MLX embed server (always-on embedding)
  // Ensure embed loop is running (self-healing — restarts if stopped).
  // Also handle: loop flag stuck true but the while() has exited — restart.
  if (mlxAvailable && !embedLoopRunning) {
    console.log('[embed-loop] self-heal: restarting (was stopped)');
    startEmbedLoop().catch(() => {});
  }
  // Content hash backfill — other INSERT paths (anomaly-alert,
  // skill-discovery, skill-registry, predictive-search, etc.) bypass
  // handleStore and leave content_hash NULL. Without a hash those rows
  // skip dedup and will accumulate duplicates again. Backfill in the
  // same scheduler that already migrates tiers.
  //
  // 2026-04-20 changes: (a) batch reduced 500 → 100 to shorten the
  // main-thread block, (b) yield every 25 rows within the inner loop so
  // /health can interleave. SHA256 of ~1KB content × 100 = ~5ms CPU —
  // fine. The real cost was the 100 SQL UPDATEs; yielding between every
  // 25 lets the event loop drain HTTP queues.
  try {
    const crypto = require('node:crypto');
    const rows = ramDb.prepare(`SELECT id, content, session, type FROM entries WHERE content_hash IS NULL AND type NOT IN ('test','working-state','session-recall','anomaly-alert') LIMIT 100;`).all();
    if (rows.length > 0) {
      const upd = ramDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
      let filled = 0, dupes = 0, processed = 0;
      for (const r of rows) {
        try {
          upd.run(crypto.createHash('sha256').update(String(r.content)).digest('hex'), r.id);
          filled++;
        } catch (e) {
          // UNIQUE constraint: another row already has this (session,type,hash).
          // This row IS a duplicate — safe to delete.
          if (/UNIQUE constraint/i.test(e.message)) {
            try { ramDb.prepare(`DELETE FROM entries WHERE id = ?`).run(r.id); dupes++; } catch {}
          }
        }
        // Yield every 25 rows to let pending HTTP requests be served.
        processed++;
        if (processed % 25 === 0) await yieldToEventLoop();
      }
      if (filled + dupes > 0) console.log(`[vcontext:auto] Backfilled ${filled}, deduped ${dupes} rows`);
    }
  } catch (e) { console.error('[vcontext:auto] hash backfill failed:', e.message); }
  await yieldToEventLoop();

  // Quick migration check
  try {
    const moved = migrateRamToSsd();
    if (moved > 0) console.log(`[vcontext:auto] Auto-migrated ${moved} entries RAM → SSD`);
  } catch (e) {
    console.error('[vcontext:auto] Auto-migration RAM→SSD failed:', e.message);
  }
  await yieldToEventLoop();

  try {
    const moved = migrateSsdToCloud();
    if (moved > 0) console.log(`[vcontext:auto] Auto-migrated ${moved} entries SSD → Cloud`);
  } catch (e) {
    console.error('[vcontext:auto] Auto-migration SSD→Cloud failed:', e.message);
  }
  await yieldToEventLoop();

  // Ensure discovery loop is running (self-healing)
  if (mlxGenerateAvailable && !discoveryLoopRunning) {
    startDiscoveryLoop().catch(() => {});
  }
  // Anomaly detection — 4 small queries, don't need mid-yield
  try { detectAnomalies(); } catch {}
}

// ── Anomaly detection ─────────────────────────────────────────
function detectAnomalies() {
  const alerts = [];

  // 1. Error spike: >10 errors in last 30 min
  const errorCount = dbQuery("SELECT COUNT(*) as c FROM entry_index WHERE type = 'tool-error' AND created_at >= datetime('now', '-30 minutes');");
  if ((errorCount[0]?.c || 0) > 10) {
    alerts.push({ level: 'high', msg: `Error spike: ${errorCount[0].c} errors in last 30 min` });
  }

  // 2. Embedding stall: no new embeddings in 30 min while backlog exists
  const embedBacklog = dbQuery("SELECT COUNT(*) as c FROM entries WHERE embedding IS NULL;");
  const recentEmbeds = dbQuery("SELECT COUNT(*) as c FROM entries WHERE embedding IS NOT NULL AND created_at >= datetime('now', '-30 minutes');");
  if ((embedBacklog[0]?.c || 0) > 50 && (recentEmbeds[0]?.c || 0) === 0) {
    alerts.push({ level: 'medium', msg: `Embedding stalled: ${embedBacklog[0].c} pending, 0 in last 30 min` });
  }

  // 3. RAM/SSD sync anomaly.
  // By design SSD ≥ RAM always (RAM→SSD migration keeps SSD as the
  // long-term store; migrated entries leave RAM). Only a POSITIVE gap
  // (RAM > SSD, i.e. SSD is missing data that's in RAM) is a real
  // anomaly — it would mean the server's tier migration has failed.
  // Negative gap is normal and grows linearly with cold storage.
  const ramCount = dbQuery("SELECT COUNT(*) as c FROM entries;");
  const ssdCount = dbQuery("SELECT COUNT(*) as c FROM entries;", SSD_DB_PATH);
  const gap = (ramCount[0]?.c || 0) - (ssdCount[0]?.c || 0);
  if (gap > 100) {
    alerts.push({ level: 'medium', msg: `RAM ahead of SSD by ${gap} entries — tier migration may be failing` });
  }

  // 4. Disk usage >3GB — ONLY meaningful in RAM-disk mode (18GB budget tight).
  // Post-2026-04-18 migration we run on SSD where 3GB is normal DB size, and
  // this alarm was firing every 5-min cycle, triggering migrateRamToSsd() in
  // an infinite loop that starved the HTTP handler. Gate on USE_RAMDISK.
  if (USE_RAMDISK) {
    try {
      const ramSize = statSync(DB_PATH).size;
      if (ramSize > 3 * 1024 * 1024 * 1024) {
        alerts.push({ level: 'high', msg: `RAM disk >3GB (${(ramSize/1024/1024/1024).toFixed(1)}GB)` });
      }
    } catch {}
  }

  // 5. Latency regression: recall or store avg > 3x the 24h baseline.
  // Compares last 30min vs 7d-prior baseline (excluding the last 1h so
  // current degradation doesn't contaminate the baseline).
  try {
    const opsToCheck = ['recall', 'store', 'recent'];
    for (const op of opsToCheck) {
      const recent = dbQuery(`SELECT AVG(latency_ms) as avg, COUNT(*) as n FROM api_metrics WHERE operation=${esc(op)} AND created_at > datetime('now','-30 minutes');`);
      const baseline = dbQuery(`SELECT AVG(latency_ms) as avg FROM api_metrics WHERE operation=${esc(op)} AND created_at BETWEEN datetime('now','-7 days') AND datetime('now','-1 hour');`);
      const recentAvg = recent[0]?.avg || 0;
      const recentN = recent[0]?.n || 0;
      const baselineAvg = baseline[0]?.avg || 0;
      // Require: meaningful sample (>=20 recent calls) + meaningful baseline (>200ms typical) + 3x degradation
      if (recentN >= 20 && baselineAvg > 200 && recentAvg > baselineAvg * 3) {
        alerts.push({
          level: 'medium',
          msg: `Latency regression: ${op} ${Math.round(recentAvg)}ms avg (30min, n=${recentN}) vs ${Math.round(baselineAvg)}ms baseline — ${Math.round(recentAvg/baselineAvg)}x slower`,
        });
      }
    }
  } catch {}

  // 6. DB write failures — count malformed/lock errors in the last 30min.
  // These don't crash the server but silently drop rows. Grep the running
  // log file for `[db exec error` patterns.
  try {
    const fs = require('node:fs');
    const LOG = '/tmp/vcontext-server.log';
    if (fs.existsSync(LOG)) {
      const stat = fs.statSync(LOG);
      // Only scan the last 512KB (enough for ~30min of logs on busy systems)
      const scanBytes = Math.min(512 * 1024, stat.size);
      const fd = fs.openSync(LOG, 'r');
      const buf = Buffer.alloc(scanBytes);
      fs.readSync(fd, buf, 0, scanBytes, stat.size - scanBytes);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const errors = (text.match(/\[db exec error|\[db query error|database disk image is malformed/g) || []).length;
      if (errors > 20) {
        alerts.push({ level: 'high', msg: `DB errors in recent log: ${errors} (last ~30min) — check for corruption or schema drift` });
      }
    }
  } catch {}

  // 7. Embed backlog growth — eligible backlog grew by >200 in the last
  // hour despite the loop being enabled. Indicates producer/consumer
  // imbalance (user writes faster than MLX embeds).
  try {
    const SKIP_TYPES = "'working-state','anomaly-alert','pre-tool','session-recall','test'";
    const currentBacklog = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE embedding IS NULL AND type NOT IN (${SKIP_TYPES});`)[0]?.c || 0;
    // "1h ago" proxy: count of non-embedded entries whose id is < (max_id - approx_hour_of_writes).
    // We approximate by sampling the previous anomaly-response audit: if we've
    // alerted on this in the last hour, it's considered open and we skip
    // re-alerting. Otherwise threshold is a simple absolute backlog watermark.
    if (currentBacklog > 2000 && mlxAvailable) {
      alerts.push({ level: 'medium', msg: `Embed backlog growing: ${currentBacklog} eligible pending (MLX embed up but not keeping pace)` });
    }
  } catch {}

  // Store alerts
  if (alerts.length > 0) {
    const content = JSON.stringify({ alerts, detected_at: new Date().toISOString() });
    try {
      dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('anomaly-alert', ${esc(content)}, '["anomaly-alert","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
      console.log(`[vcontext:alert] ${alerts.length} anomalies detected`);
    } catch {}
    // Auto-response: take concrete actions for anomalies that have safe fixes.
    // Cooldown prevents flapping if a condition persists across cycles.
    try { respondToAnomalies(alerts); } catch (e) { console.error('[anomaly-response]', e.message?.slice(0, 80)); }
  }
}

// Track last-action timestamps per anomaly kind to avoid flapping
const _anomalyLastAction = new Map();
const ANOMALY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

function respondToAnomalies(alerts) {
  const now = Date.now();
  const actions = [];
  for (const alert of alerts) {
    const msg = alert.msg || '';
    // Key = anomaly kind (not the full message, which includes varying counts)
    let kind = null;
    if (msg.startsWith('Error spike')) kind = 'error-spike';
    else if (msg.startsWith('Embedding stalled')) kind = 'embed-stall';
    else if (msg.startsWith('RAM ahead of SSD')) kind = 'ram-ahead';
    else if (msg.startsWith('RAM disk >3GB')) kind = 'ram-disk-full';
    if (!kind) continue;

    const last = _anomalyLastAction.get(kind) || 0;
    if (now - last < ANOMALY_COOLDOWN_MS) continue; // still in cooldown
    _anomalyLastAction.set(kind, now);

    try {
      if (kind === 'embed-stall') {
        // MLX embed worker stopped producing. Kick the launchd agent.
        execSync('launchctl kickstart -k "gui/$(id -u)/com.vcontext.mlx-embed" 2>/dev/null || true', { timeout: 5000 });
        actions.push({ kind, action: 'kickstart mlx-embed launchd agent' });
        console.log('[anomaly-response] Restarted MLX embed (stall detected)');
      } else if (kind === 'ram-ahead') {
        // Tier migration lagged. Force the fast sync now.
        try { syncRamToSsd(); } catch {}
        actions.push({ kind, action: 'forced syncRamToSsd()' });
        console.log('[anomaly-response] Forced RAM→SSD sync');
      } else if (kind === 'ram-disk-full') {
        // RAM disk approaching full. Force aggressive WAL checkpoint + migrate.
        try { if (ramDb) ramDb.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
        try { migrateRamToSsd(); } catch {}
        actions.push({ kind, action: 'wal_checkpoint(TRUNCATE) + migrateRamToSsd()' });
        // Also macOS notification since this is critical
        try { execSync(`osascript -e 'display notification "${msg.replace(/"/g, "")}" with title "🚨 vcontext RAM full"' 2>/dev/null || true`); } catch {}
        console.log('[anomaly-response] RAM disk full — checkpointed + migrated');
      } else if (kind === 'error-spike') {
        // Humans only — spike could be any bug. Notify.
        try { execSync(`osascript -e 'display notification "${msg.replace(/"/g, "")}" with title "⚠️ vcontext errors"' 2>/dev/null || true`); } catch {}
        actions.push({ kind, action: 'macOS notification (no auto-fix — needs diagnosis)' });
      }
    } catch (e) {
      console.error(`[anomaly-response] ${kind} failed:`, e.message?.slice(0, 80));
    }
  }
  // Audit trail — one entry per response batch
  if (actions.length > 0) {
    try {
      const auditContent = JSON.stringify({ actions, responded_at: new Date().toISOString() });
      dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('anomaly-response', ${esc(auditContent)}, '["anomaly-response","auto"]', 'system', ${estimateTokens(auditContent)}, datetime('now'), 0, 'ram');`);
    } catch {}
  }
}

// ── SearXNG dynamic URL detection ─────────────────────────────
let searxngUrl = process.env.SEARXNG_URL || '';
function detectSearxngUrl() {
  if (process.env.SEARXNG_URL) return; // env var takes priority
  try {
    const port = execFileSync('docker', ['port', 'searxng', '8080'], {
      timeout: 5000, encoding: 'utf-8',
    }).trim().split(':').pop();
    if (port && /^\d+$/.test(port)) {
      searxngUrl = `http://127.0.0.1:${port}`;
      return;
    }
  } catch {}
  searxngUrl = 'http://127.0.0.1:8888'; // fallback
}
detectSearxngUrl();

// ── Streaming skill discovery + user need prediction ──────────
let discoveryLoopRunning = false;
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;   // 5 min between searches
const PREDICTION_INTERVAL_MS = 30 * 60 * 1000;  // 30 min between predictions
let lastPredictionRun = 0;

async function startDiscoveryLoop() {
  if (discoveryLoopRunning) return;
  discoveryLoopRunning = true;

  while (discoveryLoopRunning) {
    _loopHeartbeat.discovery = Date.now();
    _loopHeartbeat.discovery_iter++;
    // Ensure MLX generate is available
    if (!mlxGenerateAvailable) { checkMlxGenerate(); }
    if (!mlxGenerateAvailable) {
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      continue;
    }
    if (existsSync('/tmp/vcontext-embed-pause')) {
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    try {
      await runOneDiscovery();
    } catch {}

    // User need prediction every 30 min
    if (Date.now() - lastPredictionRun >= PREDICTION_INTERVAL_MS) {
      lastPredictionRun = Date.now();
      try {
        await runOnePrediction();
      } catch {}
      // Auto-create skill (MLX generate — no model unload needed)
      try {
        await autoCreateSkill();
      } catch {}
    }

    // Wait 5 min before next search
    await new Promise(r => setTimeout(r, DISCOVERY_INTERVAL_MS));
  }
  discoveryLoopRunning = false;
}

// ── L1 chunk summary loop (PHOTON-inspired hierarchical memory) ──
// Every 10 minutes we LLM-summarize the previous completed 10-min window
// into a 1-2 sentence chunk-summary entry. Purpose:
//  - /sessions/summary and future drill-down can start coarse (L1 chunks)
//    instead of scanning 200+ raw entries
//  - Long-term session recall becomes O(log N) instead of O(N)
//  - Models the "multi-rate latent streams" idea from arXiv:2512.20687
//    (PHOTON) as a memory-tier pattern, adapted for a DB-backed AIOS.
// Cost: ~29k MLX-generate tokens/day (free, local) + ~60KB/day storage.
let chunkSummaryLoopRunning = false;
const CHUNK_SUMMARY_WINDOW_MS = 10 * 60 * 1000;  // 10-min chunks
const CHUNK_SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
const CHUNK_SUMMARY_MIN_ENTRIES = 3;             // skip sparse windows
const CHUNK_SUMMARY_MAX_ENTRIES = 100;           // cap prompt size

function chunkIdFor(ts) {
  // Round down to 10-minute boundary, ISO string without seconds.
  // e.g. 2026-04-18T09:37:12Z → "2026-04-18T09:30"
  const d = new Date(ts);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10);
  return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

function dayIdFor(ts) {
  // UTC date: YYYY-MM-DD.  L2 summaries are keyed on this.
  return new Date(ts).toISOString().slice(0, 10);
}

function weekIdFor(ts) {
  // ISO week (Mon-Sun): YYYY-Www, e.g. 2026-W16.  L3 summaries are keyed on this.
  // ISO 8601: week 1 is the week containing the first Thursday of the year.
  const d = new Date(Date.UTC(
    new Date(ts).getUTCFullYear(),
    new Date(ts).getUTCMonth(),
    new Date(ts).getUTCDate()
  ));
  // Shift to nearest Thursday (ISO week anchor)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function startChunkSummaryLoop() {
  if (chunkSummaryLoopRunning) return;
  chunkSummaryLoopRunning = true;
  while (chunkSummaryLoopRunning) {
    _loopHeartbeat.chunk_summary = Date.now();
    _loopHeartbeat.chunk_summary_iter++;
    try {
      if (mlxGenerateAvailable && !existsSync('/tmp/vcontext-embed-pause')) {
        await runOneChunkSummary();
      }
    } catch (e) {
      console.error('[chunk-summary] loop error:', (e.message || e).toString().slice(0, 200));
    }
    await new Promise(r => setTimeout(r, CHUNK_SUMMARY_INTERVAL_MS));
  }
}

async function runOneChunkSummary() {
  // Target = the previous completed window. Current time's window may
  // still be accumulating entries, so we summarize `now - 10min`.
  const now = Date.now();
  const windowStart = now - 2 * CHUNK_SUMMARY_WINDOW_MS;
  const windowEnd = now - CHUNK_SUMMARY_WINDOW_MS;
  const chunkId = chunkIdFor(windowEnd);

  // Already summarized?
  const existing = dbQuery(`SELECT id FROM entries WHERE type='chunk-summary' AND tags LIKE '%chunk:${chunkId}%' LIMIT 1;`);
  if (existing.length > 0) return;

  // Fetch raw entries in this window, skipping our own summary infra
  // and predictive/discovery noise (those are already meta-events).
  const startIso = new Date(windowStart).toISOString().replace('T', ' ').slice(0, 19);
  const endIso = new Date(windowEnd).toISOString().replace('T', ' ').slice(0, 19);
  const rows = dbQuery(`
    SELECT id, type, session, substr(content, 1, 400) as content FROM entries
    WHERE created_at >= ${esc(startIso)} AND created_at < ${esc(endIso)}
      AND type NOT IN ('chunk-summary','skill-discovery','predictive-search',
                        'embed-error','skill-usage','api-metric')
    ORDER BY id ASC LIMIT ${CHUNK_SUMMARY_MAX_ENTRIES};
  `);

  if (rows.length < CHUNK_SUMMARY_MIN_ENTRIES) {
    console.log(`[chunk-summary] ${chunkId}: skipped (only ${rows.length} entries, min ${CHUNK_SUMMARY_MIN_ENTRIES})`);
    return;
  }

  // Build a compressed prompt. Per-entry format: [type] sess:xxxx  body
  const lines = rows.map(r => {
    const sid = (r.session || '?').slice(0, 8);
    const body = String(r.content || '').replace(/\s+/g, ' ').slice(0, 180);
    return `[${r.type}] ${sid} ${body}`;
  });
  const prompt = `Summarize the following AI-OS activity window (10 minutes) into 1-2 short sentences capturing the key topics, tools used, and any decisions or errors. No preamble, no markdown.

Entries (N=${rows.length}):
${lines.join('\n').slice(0, 6000)}

Output (1-2 sentences):`;

  let summary;
  try {
    summary = await mlxGenerate(prompt, { maxTokens: 300, noThink: true });
  } catch (e) {
    console.error(`[chunk-summary] ${chunkId}: generate failed:`, (e.message || e).toString().slice(0, 120));
    return;
  }
  if (!summary || !summary.trim()) return;

  // Store as a first-class entry so FTS/recall/index all work for free.
  const sessionIds = [...new Set(rows.map(r => r.session).filter(Boolean))];
  const typeCounts = rows.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {});
  const payload = {
    level: 1,
    chunk_id: chunkId,
    period_start: startIso + 'Z',
    period_end: endIso + 'Z',
    source_count: rows.length,
    session_count: sessionIds.length,
    type_breakdown: typeCounts,
    summary: summary.trim(),
  };
  const tags = JSON.stringify(['chunk-summary', 'level:1', `chunk:${chunkId}`]);
  dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES (${esc('chunk-summary')}, ${esc(JSON.stringify(payload))}, ${esc(tags)}, 'system', ${estimateTokens(summary)});`);
  console.log(`[chunk-summary] ${chunkId}: ${rows.length} entries → "${summary.trim().slice(0, 80)}..."`);
}

// ── L2: daily summary (bundles L1 chunks for one UTC day) ──────────────
let chunkSummaryL2LoopRunning = false;
const CHUNK_SUMMARY_L2_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min

async function startChunkSummaryL2Loop() {
  if (chunkSummaryL2LoopRunning) return;
  chunkSummaryL2LoopRunning = true;
  while (chunkSummaryL2LoopRunning) {
    _loopHeartbeat.chunk_summary_l2 = Date.now();
    _loopHeartbeat.chunk_summary_l2_iter++;
    try {
      if (mlxGenerateAvailable && !existsSync('/tmp/vcontext-embed-pause')) {
        // Target = yesterday (UTC).  Today's day is still accumulating L1s.
        const yesterday = dayIdFor(Date.now() - 24 * 3600 * 1000);
        await runOneChunkSummaryL2(yesterday);
      }
    } catch (e) {
      console.error('[chunk-summary-l2] loop error:', (e.message || e).toString().slice(0, 200));
    }
    await new Promise(r => setTimeout(r, CHUNK_SUMMARY_L2_INTERVAL_MS));
  }
}

async function runOneChunkSummaryL2(dayId) {
  // dayId: "YYYY-MM-DD"
  // Already summarized?
  const existing = dbQuery(`SELECT id FROM entries WHERE type='chunk-summary' AND tags LIKE '%level:2%' AND tags LIKE ${esc('%chunk:' + dayId + '%')} LIMIT 1;`);
  if (existing.length > 0) return { skipped: 'already-summarized', chunk_id: dayId };

  const dayStart = `${dayId} 00:00:00`;
  const dayEnd = `${dayId} 23:59:59`;

  // Fetch the day's L1 summaries.
  const l1Rows = dbQuery(`
    SELECT id, content FROM entries
    WHERE type='chunk-summary' AND tags LIKE '%level:1%'
      AND created_at >= ${esc(dayStart)} AND created_at <= ${esc(dayEnd)}
    ORDER BY id ASC LIMIT 200;
  `);
  if (l1Rows.length === 0) {
    console.log(`[chunk-summary-l2] ${dayId}: skipped (no L1 summaries)`);
    return { skipped: 'no-l1', chunk_id: dayId };
  }

  const l1Summaries = [];
  let sourceRawCount = 0;
  const allSessions = new Set();
  for (const r of l1Rows) {
    try {
      const d = JSON.parse(r.content);
      if (d.summary) l1Summaries.push(d.summary);
      sourceRawCount += d.source_count || 0;
      if (Array.isArray(d.sessions)) d.sessions.forEach(s => allSessions.add(s));
    } catch {}
  }

  // Pain signals + triggered-change: scan the day's raw entries once.
  const painRows = dbQuery(`
    SELECT type, COUNT(*) as cnt FROM entries
    WHERE created_at >= ${esc(dayStart)} AND created_at <= ${esc(dayEnd)}
      AND type IN ('tool-error','anomaly-alert')
    GROUP BY type;
  `);
  const painSignals = {};
  for (const r of painRows) painSignals[r.type] = r.cnt;

  const approveRows = dbQuery(`
    SELECT id, content FROM entries
    WHERE type='approve-patch' AND created_at >= ${esc(dayStart)} AND created_at <= ${esc(dayEnd)}
    ORDER BY id DESC LIMIT 5;
  `);
  let triggeredChange = null;
  if (approveRows.length > 0) {
    // Heuristic: inspect the first approved patch payload for category hints.
    triggeredChange = 'arch';
    try {
      const d = JSON.parse(approveRows[0].content || '{}');
      const blob = JSON.stringify(d).toLowerCase();
      if (blob.includes('test')) triggeredChange = 'test';
      else if (blob.includes('readme') || blob.includes('.md') || blob.includes('doc')) triggeredChange = 'doc';
    } catch {}
  }

  const prompt = `Summarize this day's activity from the per-window summaries below into 3-5 short sentences. Capture main themes, tools used, and any decisions or recurring issues. No preamble, no markdown.

Day: ${dayId}
Window summaries (N=${l1Summaries.length}):
${l1Summaries.join('\n').slice(0, 12000)}

Output (3-5 sentences):`;

  let summary;
  try {
    summary = await mlxGenerate(prompt, { maxTokens: 600, noThink: true });
  } catch (e) {
    console.error(`[chunk-summary-l2] ${dayId}: generate failed:`, (e.message || e).toString().slice(0, 120));
    return { error: e.message, chunk_id: dayId };
  }
  if (!summary || !summary.trim()) return { error: 'empty-summary', chunk_id: dayId };

  const payload = {
    level: 2,
    chunk_id: dayId,
    period_start: dayStart + 'Z',
    period_end: dayEnd + 'Z',
    source_l1_count: l1Summaries.length,
    source_raw_count: sourceRawCount,
    session_count: allSessions.size,
    pain_signals: painSignals,
    triggered_change: triggeredChange,
    summary: summary.trim(),
  };
  const tags = JSON.stringify(['chunk-summary', 'level:2', `chunk:${dayId}`]);
  dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES (${esc('chunk-summary')}, ${esc(JSON.stringify(payload))}, ${esc(tags)}, 'system', ${estimateTokens(summary)});`);
  console.log(`[chunk-summary-l2] ${dayId}: ${l1Summaries.length} L1 → "${summary.trim().slice(0, 80)}..."`);
  return { ok: true, chunk_id: dayId, source_l1_count: l1Summaries.length };
}

// ── L3: weekly summary (bundles L2 days for one ISO week) ──────────────
let chunkSummaryL3LoopRunning = false;
const CHUNK_SUMMARY_L3_INTERVAL_MS = 60 * 60 * 1000; // check every 60 min

async function startChunkSummaryL3Loop() {
  if (chunkSummaryL3LoopRunning) return;
  chunkSummaryL3LoopRunning = true;
  while (chunkSummaryL3LoopRunning) {
    _loopHeartbeat.chunk_summary_l3 = Date.now();
    _loopHeartbeat.chunk_summary_l3_iter++;
    try {
      if (mlxGenerateAvailable && !existsSync('/tmp/vcontext-embed-pause')) {
        // Target = last week.  Current week is still accumulating days.
        const lastWeek = weekIdFor(Date.now() - 7 * 24 * 3600 * 1000);
        await runOneChunkSummaryL3(lastWeek);
      }
    } catch (e) {
      console.error('[chunk-summary-l3] loop error:', (e.message || e).toString().slice(0, 200));
    }
    await new Promise(r => setTimeout(r, CHUNK_SUMMARY_L3_INTERVAL_MS));
  }
}

async function runOneChunkSummaryL3(weekId) {
  // weekId: "YYYY-Www"
  const existing = dbQuery(`SELECT id FROM entries WHERE type='chunk-summary' AND tags LIKE '%level:3%' AND tags LIKE ${esc('%chunk:' + weekId + '%')} LIMIT 1;`);
  if (existing.length > 0) return { skipped: 'already-summarized', chunk_id: weekId };

  // Resolve ISO week → Mon 00:00 UTC .. Sun 23:59 UTC.
  const [yearStr, wStr] = weekId.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(wStr, 10);
  if (!year || !week) return { error: 'bad-week-id', chunk_id: weekId };
  // Jan 4 is always in week 1 (ISO 8601 rule).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4.getTime() - (jan4Dow - 1) * 86400000);
  const weekStart = new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000 - 1000);
  const startIso = weekStart.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = weekEnd.toISOString().replace('T', ' ').slice(0, 19);

  // Fetch the week's L2 summaries.
  const l2Rows = dbQuery(`
    SELECT id, content FROM entries
    WHERE type='chunk-summary' AND tags LIKE '%level:2%'
      AND created_at >= ${esc(startIso)} AND created_at <= ${esc(endIso)}
    ORDER BY id ASC LIMIT 14;
  `);
  if (l2Rows.length === 0) {
    console.log(`[chunk-summary-l3] ${weekId}: skipped (no L2 summaries)`);
    return { skipped: 'no-l2', chunk_id: weekId };
  }

  const l2Summaries = [];
  for (const r of l2Rows) {
    try {
      const d = JSON.parse(r.content);
      if (d.summary) l2Summaries.push(`[${d.chunk_id}] ${d.summary}`);
    } catch {}
  }

  // Decisions made that week.
  const decisionRows = dbQuery(`
    SELECT COUNT(*) as cnt FROM entries
    WHERE type='decision' AND created_at >= ${esc(startIso)} AND created_at <= ${esc(endIso)};
  `);
  const decisionsMade = decisionRows[0]?.cnt || 0;

  const prompt = `Summarize this week's activity from the daily summaries below into 4-6 short sentences, then list 3-5 major themes as a comma-separated list. Capture overall arcs, recurring topics, and notable shifts. No preamble, no markdown.

Week: ${weekId}
Daily summaries (N=${l2Summaries.length}):
${l2Summaries.join('\n').slice(0, 14000)}

Output format:
SUMMARY: <4-6 sentences>
THEMES: <theme1>, <theme2>, <theme3>`;

  let raw;
  try {
    raw = await mlxGenerate(prompt, { maxTokens: 800, noThink: true });
  } catch (e) {
    console.error(`[chunk-summary-l3] ${weekId}: generate failed:`, (e.message || e).toString().slice(0, 120));
    return { error: e.message, chunk_id: weekId };
  }
  if (!raw || !raw.trim()) return { error: 'empty-summary', chunk_id: weekId };

  // Parse the structured output.  Graceful fallback if model drifts.
  let summary = raw.trim();
  let themes = [];
  const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*THEMES:|$)/i);
  const themesMatch = raw.match(/THEMES:\s*([\s\S]*?)$/i);
  if (summaryMatch) summary = summaryMatch[1].trim();
  if (themesMatch) {
    themes = themesMatch[1].split(/[,\n]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
  }

  const payload = {
    level: 3,
    chunk_id: weekId,
    period_start: startIso + 'Z',
    period_end: endIso + 'Z',
    source_l2_count: l2Summaries.length,
    themes,
    decisions_made: decisionsMade,
    summary,
  };
  const tags = JSON.stringify(['chunk-summary', 'level:3', `chunk:${weekId}`]);
  dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES (${esc('chunk-summary')}, ${esc(JSON.stringify(payload))}, ${esc(tags)}, 'system', ${estimateTokens(summary)});`);
  console.log(`[chunk-summary-l3] ${weekId}: ${l2Summaries.length} L2 → "${summary.slice(0, 80)}..."`);
  return { ok: true, chunk_id: weekId, source_l2_count: l2Summaries.length };
}

async function runOneDiscovery() {
  detectSearxngUrl(); // re-detect port in case Docker restarted

  // ── 1. Skill discovery: multi-direction search ──
  // Rotate through categories + activity-based topic each cycle
  const DISCOVERY_CATEGORIES = [
    // AI developer news & papers (daily check)
    'Anthropic Claude new release announcement',
    'OpenAI GPT new model release',
    'Apple MLX framework update release',
    'Qwen Alibaba new model release',
    'arxiv AI agent paper breakthrough',
    // Technical patterns
    'Claude Code skills best practices',
    'AI coding agent workflow patterns',
    'MCP server new tools',
    'agentic orchestration patterns',
    'AI agent quality assurance',
    'AI pair programming techniques',
    // Ecosystem
    'MLX embedding optimization Apple Silicon',
    'local LLM inference optimization',
  ];
  try {
    // Pick category by rotation (cycle through all directions)
    const cycleIndex = Math.floor(Date.now() / DISCOVERY_INTERVAL_MS) % (DISCOVERY_CATEGORIES.length + 1);
    let topic;

    if (cycleIndex < DISCOVERY_CATEGORIES.length) {
      // Fixed category rotation
      topic = DISCOVERY_CATEGORIES[cycleIndex] + ' 2026';
    } else {
      // Activity-based dynamic topic
      topic = 'AI agent workflow best practices 2026'; // fallback
      if (mlxGenerateAvailable) {
        try {
          const recentActivity = dbQuery(`SELECT tool_name, type FROM entry_index WHERE created_at >= datetime('now', '-6 hours') AND tool_name IS NOT NULL ORDER BY entry_id DESC LIMIT 20;`);
          const recentPrompts = dbQuery(`SELECT substr(content, 1, 200) as c FROM entries WHERE type = 'user-prompt' AND created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 5;`);
          const agentTasks = dbQuery(`SELECT substr(content, 1, 200) as c FROM entries WHERE type = 'subagent-start' AND created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 10;`);

          const activityStr = recentActivity.map(r => r.tool_name).filter(Boolean).join(', ');
          const promptStr = recentPrompts.map(r => {
            try { const d = JSON.parse(r.c); return d.prompt || d.content || ''; } catch { return r.c || ''; }
          }).filter(s => s.length > 5).join('; ');
          const agentStr = agentTasks.map(r => {
            try { const d = JSON.parse(r.c); return d.description || ''; } catch { return ''; }
          }).filter(Boolean).join('; ');

          const topicPrompt = `Based on this developer and their AI agents' recent work, generate ONE search query to find the most useful new tool, library, or best practice. Output ONLY the search query, nothing else.

Recent tools: ${activityStr || 'Bash, Edit, Read'}
Recent questions: ${sanitizeForExternalSearch(promptStr || 'general development')}
Agent tasks: ${sanitizeForExternalSearch(agentStr || 'code review, testing')}

Search query:`;
          const generated = await mlxGenerate(topicPrompt, { maxTokens: 40960, temperature: 0.7 });
          if (generated && generated.length > 5) {
            topic = sanitizeForExternalSearch(generated.trim().split('\n')[0]);
          }
        } catch {}
      }
    }
    console.log(`[vcontext:discover] Topic: "${topic}" (cycle ${cycleIndex}/${DISCOVERY_CATEGORIES.length})`);

    // Dedup: skip if we searched this topic in the last 24 hours
    const existing = dbQuery(`SELECT id FROM entries WHERE type = 'skill-discovery' AND content LIKE ${esc('%' + topic.slice(0, 30) + '%')} AND created_at >= datetime('now', '-24 hours') LIMIT 1;`);
    if (existing.length > 0) {
      console.log(`[vcontext:discover] Skipped (searched in last 24h)`);
    } else {

    const searchResult = await new Promise((resolve) => {
      const req = httpRequest(new URL(`${searxngUrl}/search?q=${encodeURIComponent(topic + ' 2026')}&format=json&language=auto`), {
        method: 'GET', timeout: 10000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (searchResult && searchResult.results && searchResult.results.length > 0) {
      const snippets = searchResult.results.slice(0, 5).map(r =>
        `[${r.engine || '?'}] ${r.title || ''}: ${(r.content || '').slice(0, 200)}`
      );
      const content = JSON.stringify({
        topic,
        results: snippets,
        discovered_at: new Date().toISOString(),
      });
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-discovery', ${esc(content)}, '["skill-discovery","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:discover] Searched "${topic}" → ${snippets.length} results`);
      } catch {}
    }
    } // end dedup else
  } catch {}
}

async function runOnePrediction() {
  try {
    console.log(`[vcontext:predict] entering runOnePrediction, mlxGen=${mlxGenerateAvailable}`);
    if (!mlxGenerateAvailable) { console.log('[vcontext:predict] skipped: mlx unavailable'); return; }
    console.log('[vcontext:predict] building prompt...');

    // PRIORITY: generate routing triggers from skill-gaps FIRST —
    // before the heavy DB queries that can hang on embed-loop write lock.
    // Uses direct MLX call (queue bypass) + lightweight entries query.
    try {
      const gapRows = dbQuery(`SELECT content FROM entries WHERE type = 'skill-gap' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 5;`);
      const gaps = gapRows.map(r => { try { return JSON.parse(r.content).prompt || ''; } catch { return ''; } }).filter(Boolean);
      if (gaps.length > 0) {
        console.log(`[vcontext:predict] generating triggers for ${gaps.length} gaps...`);
        const triggerPrompt = `Given these user prompts that matched NO skill:\n${gaps.map(g => `- "${g}"`).join('\n')}\n\nFor each prompt, output 2-3 Japanese/English keywords (pipe-separated) that would identify similar future prompts. Format: one line per prompt, keywords only.\nExample: 改善|improve|better`;
        // Queue normally — serial queue ensures it runs when MLX is free.
        // No bypass, no retry loop, no fighting for immediate access.
        const triggerOut = await mlxGenerate(triggerPrompt, { maxTokens: 40960, temperature: 0.2, caller: 'auto-trigger', priority: 0 });
        if (triggerOut && triggerOut.length > 5) {
          const lines = triggerOut.trim().split('\n').filter(l => l.includes('|'));
          for (const line of lines.slice(0, 5)) {
            const keywords = line.replace(/^[-\s*]+/, '').trim();
            if (keywords.length >= 3) {
              dbExec(`INSERT OR IGNORE INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, status, content_hash)
                VALUES ('skill-trigger', ${esc(JSON.stringify({ keywords, for_skills: ['infinite-skills'], generated_at: new Date().toISOString() }))},
                '["skill-trigger","auto"]', 'system', 10, datetime('now'), 0, 'ram', 'active',
                ${esc(require('node:crypto').createHash('sha256').update(keywords).digest('hex'))});`);
            }
          }
          console.log(`[vcontext:predict] Auto-generated ${lines.length} routing triggers`);
        }
      }
    } catch (e) { console.log(`[vcontext:predict] trigger gen failed: ${e.message}`); }

    // Get recent activity patterns (can hang on embed lock — non-critical)
    const recentTools = dbQuery(`SELECT tool_name, COUNT(*) as cnt FROM entry_index WHERE tool_name IS NOT NULL AND created_at >= datetime('now', '-24 hours') GROUP BY tool_name ORDER BY cnt DESC LIMIT 10;`);
    const recentErrors = dbQuery(`SELECT COUNT(*) as cnt FROM entry_index WHERE type = 'tool-error' AND created_at >= datetime('now', '-24 hours');`);
    const recentTopics = dbQuery(`SELECT type, COUNT(*) as cnt FROM entry_index WHERE created_at >= datetime('now', '-24 hours') GROUP BY type ORDER BY cnt DESC LIMIT 5;`);

    const activitySummary = `Tools used: ${recentTools.map(r => `${r.tool_name}(${r.cnt})`).join(', ')}
Errors: ${recentErrors[0]?.cnt || 0}
Event types: ${recentTopics.map(r => `${r.type}(${r.cnt})`).join(', ')}`;

    // Get existing skills
    const skillList = dbQuery(`SELECT DISTINCT tool_name FROM entry_index WHERE type IN ('skill-version','skill-diff');`);
    const existingSkills = skillList.map(r => r.tool_name).filter(Boolean).join(', ');

    // Skill effectiveness feedback
    const usageRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-usage' ORDER BY id DESC LIMIT 200;");
    const usageCounts = {};
    for (const row of usageRows) {
      try { const d = JSON.parse(row.content); for (const n of (d.skills || [])) usageCounts[n] = (usageCounts[n] || 0) + 1; } catch {}
    }
    const topSkills = Object.entries(usageCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ');
    const neverUsed = (existingSkills ? existingSkills.split(', ') : []).filter(s => !usageCounts[s]).slice(0, 5).join(', ');

    // Agent activity analysis
    const agentActivity = dbQuery(`SELECT content FROM entries WHERE type = 'subagent-start' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 20;`);
    const agentTasks = agentActivity.map(r => {
      try { const d = JSON.parse(r.content); return d.description || ''; } catch { return ''; }
    }).filter(Boolean).slice(0, 10);
    const agentErrors = dbQuery(`SELECT COUNT(*) as cnt FROM entries WHERE type = 'tool-error' AND tags LIKE '%agent%' AND created_at >= datetime('now', '-24 hours');`);

    // Skill-gap feedback: recent prompts that matched ZERO skills.
    // These are the highest-signal gaps — user actually asked for
    // something and the system had nothing. Priority over generic
    // activity-based suggestions.
    const gapRows = dbQuery(`SELECT content FROM entries WHERE type = 'skill-gap' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 5;`);
    const gaps = gapRows.map(r => {
      try { return JSON.parse(r.content).prompt || ''; } catch { return ''; }
    }).filter(Boolean);
    const gapSection = gaps.length > 0
      ? `\nRecent unmatched prompts (skill gaps):\n${gaps.map(g => `- "${g}"`).join('\n')}\nPrioritize creating skills that would have matched these prompts.\n`
      : '';

    // (trigger gen moved to top of function — runs before heavy DB queries)

    const prompt = `Based on user AND agent activity, suggest 1-2 NEW skills.

User activity (24h):
${activitySummary}

Agent tasks (24h): ${agentTasks.join('; ') || 'none'}
Agent errors: ${agentErrors[0]?.cnt || 0}
${gapSection}
Most used skills: ${topSkills || 'none yet'}
Never used skills: ${neverUsed || 'none'}
Existing skills: ${existingSkills || 'standard set'}

Focus on gaps: what patterns in user OR agent activity does NO existing skill cover?
Consider: what skills would help agents work more autonomously?
Do NOT suggest skills similar to never-used ones (they were not useful).
Output ONLY the suggestion in 2-3 sentences. Be specific.`;

    const suggestion = await mlxGenerate(prompt, { maxTokens: 40960, temperature: 0.5, caller: 'skill-suggestion', priority: 0 });
    if (suggestion && suggestion.length > 20) {
      const content = JSON.stringify({
        activity: activitySummary,
        suggestion: suggestion.trim(),
        suggested_at: new Date().toISOString(),
      });
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-suggestion', ${esc(content)}, '["skill-suggestion","auto"]', 'system', ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:predict] Skill suggestion generated`);
      } catch {}
    }
  } catch {}
}

// ── Auto skill creation from suggestions ──────────────────────

async function autoCreateSkill() {
  if (!mlxGenerateAvailable) return;

  try {

    // Get ALL unprocessed suggestions
    const suggestions = dbQuery(`SELECT id, content FROM entries WHERE type = 'skill-suggestion' AND tags NOT LIKE '%skill-created%' ORDER BY id ASC LIMIT 10;`);
    if (suggestions.length === 0) return;

    // Get existing skill names to avoid duplicates
    const skillsDir = join(process.env.HOME, 'skills', 'skills');
    let existingSkills = [];
    try { existingSkills = readdirSync(skillsDir).filter(d => statSync(join(skillsDir, d)).isDirectory()); } catch {}
    // Also check vcontext registry
    const registeredSkills = dbQuery("SELECT content FROM entries WHERE type = 'skill-registry';");
    for (const r of registeredSkills) {
      try { const s = JSON.parse(r.content); if (s.name) existingSkills.push(s.name); } catch {}
    }
    existingSkills = [...new Set(existingSkills)];

    let created = 0;
    for (const suggestion of suggestions) {
      let suggestionText = '';
      try { suggestionText = JSON.parse(suggestion.content).suggestion || ''; } catch { suggestionText = suggestion.content; }
      if (suggestionText.length < 20) continue;

      const genPrompt = `Create a new AI workflow skill based on this suggestion:
"${suggestionText.slice(0, 300)}"

Existing skills (do NOT duplicate): ${existingSkills.join(', ')}

Output in this EXACT format (nothing else):
SKILL_NAME: kebab-case-name
ROUTE_KEYWORDS: keyword1, keyword2, keyword3 (3-5 trigger words for auto-routing)
ROUTE_PRIORITY: P2-P7 (where it fits in routing: P2=debug, P3=plan, P4=review, P5=dev, P6=patterns, P7=research)
---
name: kebab-case-name
description: "One line description starting with Use when..."
origin: auto-generated
---

## Rules

1. First rule
2. Second rule

## Workflow

1. First step
2. Second step

## Gotchas

- First gotcha`;

      const generated = await mlxGenerate(genPrompt, { maxTokens: 40960, temperature: 0.3, caller: 'skill-creation', priority: 0 });
      await new Promise(r => setTimeout(r, 30000));
      if (!generated || generated.length < 50) continue;

      const nameMatch = generated.match(/SKILL_NAME:\s*([a-z0-9-]+)/);
      if (!nameMatch) continue;
      const skillName = nameMatch[1];
      const keywordsMatch = generated.match(/ROUTE_KEYWORDS:\s*(.+)/);
      const priorityMatch = generated.match(/ROUTE_PRIORITY:\s*(P[0-7])/);
      const routeKeywords = keywordsMatch ? keywordsMatch[1].trim() : skillName.replace(/-/g, ', ');
      const routePriority = priorityMatch ? priorityMatch[1] : 'P7';

      if (existingSkills.includes(skillName)) {
        console.log(`[vcontext:skill] Skipped "${skillName}" — already exists`);
        try { const t = dbQuery(`SELECT tags FROM entries WHERE id = ${suggestion.id};`); if (t[0]) { let tags = JSON.parse(t[0].tags || '[]'); tags.push('skill-created'); dbExec(`UPDATE entries SET tags = ${esc(JSON.stringify(tags))} WHERE id = ${suggestion.id};`); } } catch {}
        continue;
      }

      console.log(`[vcontext:skill] Creating "${skillName}" route=${routePriority}(${routeKeywords})`);

      const skillContent = generated.slice(generated.indexOf('---'));
      if (!skillContent || skillContent.length < 50) continue;

      // Register in vcontext with routing info (auto-router compatible)
      const descMatch = skillContent.match(/description:\s*["']?(.*?)(?:["']?\n|$)/s);
      const desc = descMatch ? descMatch[1].trim().slice(0, 200) : '';
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-registry', ${esc(JSON.stringify({ name: skillName, description: desc, full_content: skillContent, route_keywords: routeKeywords, route_priority: routePriority }))}, ${esc(JSON.stringify(['skill-registry', 'skill:' + skillName, 'route:' + routePriority]))}, 'system', ${estimateTokens(skillContent)}, datetime('now'), 0, 'ram');`);
      } catch {}

      // Mark suggestion as processed
      try { const t = dbQuery(`SELECT tags FROM entries WHERE id = ${suggestion.id};`); if (t[0]) { let tags = JSON.parse(t[0].tags || '[]'); tags.push('skill-created'); dbExec(`UPDATE entries SET tags = ${esc(JSON.stringify(tags))} WHERE id = ${suggestion.id};`); } } catch {}

      // Record creation
      try {
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('skill-created', ${esc(JSON.stringify({ skill_name: skillName, source_suggestion_id: suggestion.id, created_at: new Date().toISOString() }))}, '["skill-created","auto"]', 'system', 20, datetime('now'), 0, 'ram');`);
      } catch {}

      existingSkills.push(skillName);
      created++;
      console.log(`[vcontext:skill] Auto-created skill: ${skillName}`);
    }

    // Build all targets once after all skills created
    if (created > 0) {
      try {
        execSync(`node ${join(process.env.HOME, 'skills', 'scripts', 'build-all.js')}`, {
          cwd: join(process.env.HOME, 'skills'), timeout: 60000, encoding: 'utf-8',
        });
        console.log(`[vcontext:skill] Built ${created} new skills`);
      } catch (e) {
        console.error(`[vcontext:skill] Build failed: ${e.message?.slice(0, 80)}`);
      }
    }
  } catch (e) {
    console.error(`[vcontext:skill] Error: ${e.message?.slice(0, 80)}`);
  }
}

// ── RAM → SSD catch-up sync (fills gaps from failed write-through) ─
function syncRamToSsd() {
  if (!existsSync(SSD_DB_PATH)) return;
  const ssdMax = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;", SSD_DB_PATH);
  const ssdMaxId = ssdMax[0]?.max_id || 0;
  const ramMax = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;");
  const ramMaxId = ramMax[0]?.max_id || 0;
  const gap = ramMaxId - ssdMaxId;
  if (gap <= 0) return;
  // Use ATTACH to copy missing entries in one shot (including embedding)
  dbExec(`
    ATTACH '${SSD_DB_PATH}' AS ssd;
    INSERT OR IGNORE INTO ssd.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, embedding)
      SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ssd', reasoning, conditions, supersedes, confidence, status, embedding
      FROM main.entries WHERE id > ${ssdMaxId};
    DETACH ssd;
  `);
  console.log(`[vcontext:sync] Caught up ${gap} entries RAM→SSD (${ssdMaxId}→${ramMaxId})`);
}

// ── Embedding backfill RAM → SSD (batch via ATTACH)
// 2026-04-20 review cleanup: accept optional batchSize. Caller in
// doBackupAndMigrate passes 100; previously that arg was silently
// dropped (function had no params). Default remains 200 to preserve
// legacy behavior when no caller specifies.
function syncEmbeddingsToSsd(batchSize = 200) {
  if (!existsSync(SSD_DB_PATH)) return;
  try {
    dbExec(`
      ATTACH '${SSD_DB_PATH}' AS ssd;
      UPDATE ssd.entries SET embedding = (
        SELECT main.entries.embedding FROM main.entries
        WHERE main.entries.id = ssd.entries.id AND main.entries.embedding IS NOT NULL
      )
      WHERE ssd.entries.embedding IS NULL
      AND ssd.entries.id IN (
        SELECT id FROM main.entries WHERE embedding IS NOT NULL LIMIT ${batchSize|0}
      );
      DETACH ssd;
    `);
    const ssdCount = dbQuery("SELECT count(*) as c FROM entries WHERE embedding IS NOT NULL;", SSD_DB_PATH);
    const ramCount = dbQuery("SELECT count(*) as c FROM entries WHERE embedding IS NOT NULL;");
    const gap = (ramCount[0]?.c || 0) - (ssdCount[0]?.c || 0);
    if (gap > 0) console.log(`[vcontext:sync] Embedding SSD sync: ${ssdCount[0]?.c || 0} done, ${gap} remaining`);
  } catch (e) {
    console.error('[vcontext:sync] Embedding SSD sync error:', e.message?.slice(0, 80));
  }
}

// ── SSD → RAM restore (after reboot / RAM disk wipe) ────────────
function restoreRamFromSsd() {
  if (!existsSync(SSD_DB_PATH)) return;
  const ramCount = dbQuery("SELECT COALESCE(COUNT(*),0) as c FROM entries;");
  const ssdCount = dbQuery("SELECT COALESCE(COUNT(*),0) as c FROM entries;", SSD_DB_PATH);
  const ramC = ramCount[0]?.c || 0;
  const ssdC = ssdCount[0]?.c || 0;

  if (ramC >= ssdC) return; // RAM already has everything

  const gap = ssdC - ramC;
  const ramMaxId = dbQuery("SELECT COALESCE(MAX(id),0) as max_id FROM entries;")[0]?.max_id || 0;

  console.log(`[vcontext:restore] RAM has ${ramC} entries, SSD has ${ssdC} (${gap} missing). Restoring...`);

  try {
    dbExec(`
      ATTACH '${SSD_DB_PATH}' AS ssd;
      INSERT OR IGNORE INTO main.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, embedding)
        SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ram', reasoning, conditions, supersedes, confidence, status, embedding
        FROM ssd.entries WHERE id > ${ramMaxId};
      DETACH ssd;
    `);
    const afterCount = dbQuery("SELECT COUNT(*) as c FROM entries;")[0]?.c || 0;
    console.log(`[vcontext:restore] Restored ${afterCount - ramC} entries from SSD → RAM (now ${afterCount} total)`);
  } catch (e) {
    console.error(`[vcontext:restore] SSD → RAM restore failed: ${e.message}`);
    // Fallback: try backup file
    if (existsSync(BACKUP_PATH)) {
      console.log('[vcontext:restore] Trying backup file...');
      try {
        dbExec(`
          ATTACH '${BACKUP_PATH}' AS bak;
          INSERT OR IGNORE INTO main.entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status)
            SELECT id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, 'ram', reasoning, conditions, supersedes, confidence, status
            FROM bak.entries WHERE id > ${ramMaxId};
          DETACH bak;
        `);
        const afterCount = dbQuery("SELECT COUNT(*) as c FROM entries;")[0]?.c || 0;
        console.log(`[vcontext:restore] Restored from backup → RAM (now ${afterCount} total)`);
      } catch (e2) {
        console.error(`[vcontext:restore] Backup restore also failed: ${e2.message}`);
      }
    }
  }
}

// ── WebSocket (minimal, zero-dep) ─────────────────────────────
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5B56-A3CE3E4E2D';
const wsClients = new Map(); // id -> { socket, userId, groups, subscriptions }
let wsIdCounter = 0;

function handleWsUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  // Auth: check API key from query params or headers
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const apiKey = url.searchParams.get('key') || '';
  let auth;
  if (apiKey) {
    const keys = loadApiKeys();
    const entry = keys.keys[apiKey];
    if (!entry) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    auth = { userId: entry.userId, role: entry.role || 'member', groups: entry.groups || [] };
  } else {
    auth = { userId: LOCAL_USER_ID, role: 'owner', groups: ['*'] };
  }

  // WebSocket handshake
  const acceptKey = createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  const clientId = ++wsIdCounter;
  const client = {
    socket,
    userId: auth.userId,
    role: auth.role,
    groups: auth.groups,
    subscriptions: new Set(['all']), // default: receive all events
  };
  wsClients.set(clientId, client);
  console.log(`[ws] Client ${clientId} connected (${auth.userId})`);

  socket.on('data', (buf) => {
    try {
      const msg = decodeWsFrame(buf);
      if (!msg) return;
      const data = JSON.parse(msg);
      // Handle subscription changes
      if (data.action === 'subscribe') {
        if (data.namespace) client.subscriptions.add(`ns:${data.namespace}`);
        if (data.type) client.subscriptions.add(`type:${data.type}`);
        wsSend(client, { event: 'subscribed', subscriptions: [...client.subscriptions] });
      } else if (data.action === 'unsubscribe') {
        if (data.namespace) client.subscriptions.delete(`ns:${data.namespace}`);
        if (data.type) client.subscriptions.delete(`type:${data.type}`);
        wsSend(client, { event: 'unsubscribed', subscriptions: [...client.subscriptions] });
      } else if (data.action === 'ping') {
        wsSend(client, { event: 'pong', ts: new Date().toISOString() });
      }
    } catch {} // Ignore malformed messages
  });

  socket.on('close', () => {
    wsClients.delete(clientId);
    console.log(`[ws] Client ${clientId} disconnected`);
  });

  socket.on('error', () => {
    wsClients.delete(clientId);
  });

  // Send welcome
  wsSend(client, { event: 'connected', clientId, userId: auth.userId });
}

// Minimal WebSocket frame encoder/decoder (text frames only)
function encodeWsFrame(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const buf = Buffer.from(json, 'utf-8');
  const len = buf.length;
  let frame;
  if (len < 126) {
    frame = Buffer.alloc(2 + len);
    frame[0] = 0x81; // text frame, FIN
    frame[1] = len;
    buf.copy(frame, 2);
  } else if (len < 65536) {
    frame = Buffer.alloc(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    buf.copy(frame, 4);
  } else {
    frame = Buffer.alloc(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    buf.copy(frame, 10);
  }
  return frame;
}

function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x08) return null; // close frame
  if (opcode !== 0x01) return null; // only text frames
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  const payload = buf.slice(offset, offset + payloadLen);
  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return payload.toString('utf-8');
}

function wsSend(client, data) {
  try {
    client.socket.write(encodeWsFrame(data));
  } catch {} // Client may have disconnected
}

// Broadcast to relevant clients based on entry metadata
function wsBroadcast(eventType, entry) {
  const entryTags = entry.tags || '[]';
  const entryTagsStr = typeof entryTags === 'string' ? entryTags : JSON.stringify(entryTags);

  for (const [, client] of wsClients) {
    // Group access check
    if (!client.groups.includes('*')) {
      const hasGroupAccess = client.groups.some(g => entryTagsStr.includes(`group:${g}`));
      // If entry has group tags but client can't access them, skip
      if (entryTagsStr.includes('group:') && !hasGroupAccess) continue;
    }

    // Subscription check
    const subs = client.subscriptions;
    let match = subs.has('all');
    if (!match && entry.type) match = subs.has(`type:${entry.type}`);
    if (!match) {
      // Check namespace subscriptions
      for (const sub of subs) {
        if (sub.startsWith('ns:') && entryTagsStr.includes(`project:${sub.slice(3)}`)) {
          match = true;
          break;
        }
      }
    }

    if (match) {
      wsSend(client, {
        event: eventType,
        entry: {
          id: entry.id,
          type: entry.type,
          content: entry.content ? entry.content.slice(0, 200) : '',
          tags: entry.tags,
          session: entry.session,
          created_at: entry.created_at,
          userId: entryTagsStr.match(/user:([^",\]]+)/)?.[1] || null,
        },
      });
    }
  }
}

// ── sqlite-vec (optional, for fast vector search) ────────────
let vecDb = null; // better-sqlite3 instance with vec0 extension
let EMBED_DIM = 4096; // Qwen3-Embedding-8B (auto-detected from first embedding if available)

function initVecDb() {
  try {
    // Auto-detect embedding dimension (skip if DB under pressure)
    try {
      const dimRows = dbQuery("SELECT embedding FROM entries WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT 1;");
      if (dimRows[0]) { try { EMBED_DIM = JSON.parse(dimRows[0].embedding).length; } catch {} }
    } catch {}

    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    vecDb = new Database(VEC_DB_PATH);
    sqliteVec.load(vecDb);
    vecDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(embedding float[${EMBED_DIM}])`);
    console.log(`[sqlite-vec] Loaded — dim=${EMBED_DIM}, fast vector search enabled`);
  } catch (e) {
    console.log(`[sqlite-vec] Not available (${e.message}) — falling back to JS cosine`);
    vecDb = null;
  }
}

function vecUpsert(id, embedding) {
  if (!vecDb || !embedding || embedding.length !== EMBED_DIM) return;
  try {
    const embJson = JSON.stringify(embedding).replace(/'/g, "''");
    vecDb.exec(`INSERT OR REPLACE INTO vec_entries(rowid, embedding) VALUES (${Number(id)}, vec_f32('${embJson}'))`);
  } catch {}
}

function vecSearch(queryEmbedding, limit = 10) {
  if (!vecDb) return [];
  try {
    const qJson = JSON.stringify(queryEmbedding).replace(/'/g, "''");
    return vecDb.prepare(`SELECT rowid, distance FROM vec_entries WHERE embedding MATCH vec_f32('${qJson}') ORDER BY distance LIMIT ${Number(limit)}`).all();
  } catch { return []; }
}

function vecSync() {
  if (!vecDb) return;
  try {
    // MEMORY FIX (2026-04-18): prior impl did
    //   SELECT id, embedding FROM entries WHERE embedding IS NOT NULL ORDER BY id;
    //   .filter(r => !vecIds.has(r.id))
    //   .slice(0, 1000);
    // — which loaded ALL ~37k embedding JSON strings (~2.6 GB of raw bytes,
    // ~2.5 GB heap after V8 string materialization) on every invocation.
    // vecSync() runs every 300s inside doBackupAndMigrate(), so the peak
    // RSS spiked by ~1.5 GB every cycle and was the primary driver of the
    // 21 GB wired-memory peak + repeated OOM-kills (exit 137) seen today.
    //
    // Empirical probe (2026-04-18, /tmp/vcontext-memprobe.js, same dataset):
    //   rows=37294  rss 48→1520 MB  heap 3.7→2501 MB  query_ms=13880
    //
    // New strategy: do the set-difference in SQLite itself so we only
    // fetch the IDs that actually need syncing, then fetch the embedding
    // column in a small batch. ATTACH is not available here (vecDb is a
    // separate better-sqlite3 handle), so we use a two-step: pull missing
    // IDs (int list, tiny memory), then SELECT embeddings by id.
    const BATCH = 1000;
    // Step 1: collect rowids already in vec_entries as an int array.
    // ~37k ints ≈ 300 KB in V8 Set vs 2.5 GB for the embedding strings.
    const haveIds = vecDb.prepare('SELECT rowid FROM vec_entries').pluck().all();
    const haveSet = new Set(haveIds);
    // Step 2: find entry IDs (id-only, no content/embedding columns) that
    // have an embedding but aren't yet in vec_entries. SQLite does the
    // NOT-IN check; JS only keeps ~N ints.
    const candidateIds = dbQuery(
      `SELECT id FROM entries WHERE embedding IS NOT NULL ORDER BY id;`
    ).map(r => r.id).filter(id => !haveSet.has(id)).slice(0, BATCH);
    if (candidateIds.length === 0) return;
    // Step 3: fetch embedding strings ONLY for the batch we'll actually
    // insert. Worst case = 1000 × ~42 KB = ~42 MB, which is bounded.
    const idList = candidateIds.join(',');
    const rows = dbQuery(
      `SELECT id, embedding FROM entries WHERE id IN (${idList});`
    );
    let synced = 0;
    for (const row of rows) {
      try {
        const emb = JSON.parse(row.embedding);
        if (emb.length === EMBED_DIM) {
          const embStr = row.embedding.replace(/'/g, "''");
          vecDb.exec(`INSERT OR IGNORE INTO vec_entries(rowid, embedding) VALUES (${Number(row.id)}, vec_f32('${embStr}'))`);
          synced++;
        }
      } catch {}
    }
    if (synced > 0) console.log(`[sqlite-vec] Synced ${synced} vectors`);
  } catch (e) {
    console.error('[sqlite-vec] vecSync failed:', e.message?.slice(0, 120));
  }
}

// ── MLX Embedding Server (Apple Silicon GPU-accelerated) ──────
const MLX_EMBED_URL = process.env.MLX_EMBED_URL || process.env.COREML_EMBED_URL || 'http://127.0.0.1:3161';
let mlxAvailable = false;
let mlxEmbedDim = 0;    // auto-detected from health check
let mlxModelName = '';   // e.g. 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ'

/**
 * Check if MLX embed server is running on port 3161.
 * This is a fast local server for search-time query embedding.
 * (2026-04-17: legacy CoreML back-compat aliases removed — 0 callers.)
 */
let _mlxEmbedFailStreak = 0; // hysteresis: only flip to false after N consecutive failures

async function checkMlx() {
  try {
    const parsed = new URL(`${MLX_EMBED_URL}/api/health`);
    const data = await new Promise((resolve, reject) => {
      const req = httpRequest(parsed, { method: 'GET', timeout: 2000 }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    // MLX server returns status='healthy' (or legacy 'ok')
    const ok = data && (data.status === 'healthy' || data.status === 'ok');
    if (ok) {
      if (!mlxAvailable) console.log(`[mlx-embed] Available: model=${data.model_name || data.model || ''} (dim=${data.embedding_dim || 0})`);
      mlxAvailable = true;
      mlxEmbedDim = data.embedding_dim || 0;
      mlxModelName = data.model_name || data.model || '';
      _mlxEmbedFailStreak = 0;
    } else {
      _mlxEmbedFailStreak++;
      if (_mlxEmbedFailStreak >= 3) {
        if (mlxAvailable) console.log(`[mlx-embed] Unavailable: unexpected status (streak=${_mlxEmbedFailStreak})`);
        mlxAvailable = false;
      }
    }
  } catch (e) {
    _mlxEmbedFailStreak++;
    if (_mlxEmbedFailStreak === 1 || _mlxEmbedFailStreak >= 3) {
      console.log(`[mlx-embed] Probe failed (streak=${_mlxEmbedFailStreak}): ${e.message?.slice(0, 80)}`);
    }
    if (_mlxEmbedFailStreak >= 3) {
      mlxAvailable = false;
    }
  }
}

/**
 * Generate embedding via MLX server (/api/embeddings).
 * Returns N-dim normalized embedding array or null on failure.
 * Runs on Apple Silicon GPU (24/7, no restrictions).
 * Default model: Qwen3-Embedding-8B-4bit-DWQ (4096-dim, ~30-100ms per embed).
 */
const MLX_DEFAULT_MODEL = process.env.MLX_EMBED_MODEL || 'mlx-community/Qwen3-Embedding-8B-4bit-DWQ';

// Strip lone UTF-16 surrogates. .slice(0, N) on a string containing emoji
// or other astral-plane chars can split a surrogate pair at position N-1,
// leaving a high-surrogate without its low pair. Node's http body
// serializes via UTF-8, and Python's json (in MLX embed server) rejects
// lone surrogates as "surrogates not allowed" → 400, which poisons the
// whole batch (see 2026-04-18 embed-backlog incident).
function sanitizeEmbedText(s) {
  if (!s) return s;
  // Drop any unpaired high (D800-DBFF) or low (DC00-DFFF) surrogate.
  // Regex: \p{Surrogate} requires u flag; simpler: keep valid BMP + valid pairs.
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Code-point-aware slice (2026-04-18 followup to the embed-backlog fix).
// String.prototype.slice counts UTF-16 code UNITS, so an emoji (2 code units,
// 1 code point) at the cutoff is chopped in half — losing the character
// AND producing an unpaired surrogate. [...s] iterator yields code points,
// so slicing the array preserves whole characters.
//
// Trade-off: slight CPU (O(n) string → array, O(n) join) but N≤4000 so
// negligible vs MLX inference cost.  Callers should still pass the result
// through sanitizeEmbedText as defense-in-depth — if any exotic sequence
// slips through (e.g., non-surrogate control chars), sanitize catches it.
function safeSliceCodePoints(s, n) {
  if (!s || s.length <= n) return s;
  // Fast-path: ASCII-only strings have no astral chars, regular slice is safe.
  // Detect by checking for any char > 0x7F in the window we're about to slice.
  // If none found, plain slice is identical to code-point slice and faster.
  let hasMultiByte = false;
  for (let i = 0; i < Math.min(s.length, n + 2); i++) {
    if (s.charCodeAt(i) > 0x7F) { hasMultiByte = true; break; }
  }
  if (!hasMultiByte) return s.slice(0, n);
  const arr = [...s];
  if (arr.length <= n) return s;  // code-point length within limit
  return arr.slice(0, n).join('');
}

// Mutex for MLX embed — prevents GPU contention between embed loop and inline store
let _mlxEmbedLock = Promise.resolve();
function withMlxLock(fn) {
  const prev = _mlxEmbedLock;
  let release;
  _mlxEmbedLock = new Promise(r => { release = r; });
  return prev.then(() => fn().finally(release));
}

function _mlxEmbedRaw(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MLX_DEFAULT_MODEL, prompt: sanitizeEmbedText(text) });
    const parsed = new URL(`${MLX_EMBED_URL}/api/embeddings`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000, // 60s — MLX is fast but system under swap pressure may delay
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.embedding || []);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx embed timeout')); });
    req.write(body);
    req.end();
  });
}

// Public API — serialized via mutex to prevent GPU contention
function mlxEmbed(text) { return withMlxLock(() => _mlxEmbedRaw(text)); }

// Query-embedding LRU cache + short-timeout variant for the interactive
// recall path. The background embed loop holds withMlxLock while batching,
// so a naive await blocks recall for 30–60 s. mlxEmbedFast races against
// a timeout and returns null instead of waiting — recall degrades to
// FTS-only results rather than hanging the request.
const _queryEmbedCache = new Map(); // key → Float32Array embedding
const QUERY_EMBED_CACHE_MAX = 50;

async function mlxEmbedFast(text, timeoutMs = 2000) {
  const key = String(text).slice(0, 200);
  // LRU hit — move to end
  if (_queryEmbedCache.has(key)) {
    const cached = _queryEmbedCache.get(key);
    _queryEmbedCache.delete(key);
    _queryEmbedCache.set(key, cached);
    return cached;
  }
  try {
    // Bypass withMlxLock — the MLX embed HTTP server handles its own
    // queueing, and the app-level lock serializes with batch embedding
    // which adds seconds of wait. Direct call lets the server schedule.
    const embedPromise = _mlxEmbedRaw(text);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('mlxEmbedFast timeout')), timeoutMs));
    const result = await Promise.race([embedPromise, timeoutPromise]);
    if (result && result.length > 0) {
      _queryEmbedCache.set(key, result);
      if (_queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
        const oldest = _queryEmbedCache.keys().next().value;
        _queryEmbedCache.delete(oldest);
      }
    }
    return result;
  } catch {
    return null; // gracefully degrade — FTS results are still useful
  }
}

// Batch embed via /embed_batch (10x throughput vs single calls)
function _mlxEmbedBatchRaw(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ texts: texts.map(sanitizeEmbedText), model: MLX_DEFAULT_MODEL, normalize: true });
    const parsed = new URL(`${MLX_EMBED_URL}/embed_batch`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000, // 10min
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve((data.embeddings || []).map(e => e.embedding || e));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx embed_batch timeout')); });
    req.write(body);
    req.end();
  });
}
// (2026-04-17: coremlEmbed alias removed — 0 callers found in audit.)

// ── MLX Generate Server (Apple Silicon, 24/7) ────────────────

const MLX_GENERATE_URL = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162';
const MLX_GENERATE_MODEL = process.env.MLX_GENERATE_MODEL || 'mlx-community/Qwen3-8B-4bit';
let mlxGenerateAvailable = false;
let _mlxGenFailStreak = 0;  // hysteresis: only flip to false after N consecutive failures

async function checkMlxGenerate() {
  try {
    const data = await httpGet(`${MLX_GENERATE_URL}/v1/models`);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const ok = parsed && parsed.data && parsed.data.length > 0;
    if (ok) {
      if (!mlxGenerateAvailable) console.log(`[mlx-generate] Available: ${MLX_GENERATE_MODEL}`);
      mlxGenerateAvailable = true;
      _mlxGenFailStreak = 0;
    } else {
      _mlxGenFailStreak++;
      if (_mlxGenFailStreak >= 3) {
        if (mlxGenerateAvailable) console.log(`[mlx-generate] Unavailable: empty model list (streak=${_mlxGenFailStreak})`);
        mlxGenerateAvailable = false;
      }
    }
  } catch (e) {
    _mlxGenFailStreak++;
    // Log the first failure and every flip — previously a silent catch{} hid
    // transient 30s MLX restart windows from observability.
    if (_mlxGenFailStreak === 1 || _mlxGenFailStreak >= 3) {
      console.log(`[mlx-generate] Probe failed (streak=${_mlxGenFailStreak}): ${e.message?.slice(0, 80)}`);
    }
    // Only flip to false after 3 consecutive failures — absorbs transient
    // restart blips (seen during the watchdog pgrep bug).
    if (_mlxGenFailStreak >= 3) {
      mlxGenerateAvailable = false;
    }
  }
}

// Simple HTTP GET helper
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(parsed, { method: 'GET', timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Call MLX generate server (OpenAI-compatible chat completions)
// Attempt a single MLX chat/completions call. Returns the assistant
// content (may be '') on HTTP 200, or throws with status on 4xx/5xx.
// ── Cost / token tracker ────────────────────────────────────────
// Aggregates MLX token usage by feature so /metrics can report cost.
const _mlxUsage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, by_caller: {} };
function trackMlxUsage(caller, promptTokens, completionTokens) {
  _mlxUsage.calls++;
  _mlxUsage.prompt_tokens += promptTokens;
  _mlxUsage.completion_tokens += completionTokens;
  if (!_mlxUsage.by_caller[caller]) _mlxUsage.by_caller[caller] = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  _mlxUsage.by_caller[caller].calls++;
  _mlxUsage.by_caller[caller].prompt_tokens += promptTokens;
  _mlxUsage.by_caller[caller].completion_tokens += completionTokens;
}

function mlxGenerateOnce(prompt, options = {}) {
  return withMlxLock(() => _mlxGenerateRaw(prompt, options));
}
function _mlxGenerateRaw(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    // Thinking control — Qwen3 supports `/no_think` as a prompt directive
    // to skip the <think>...</think> block. For simple tasks (summarize,
    // classify, extract) thinking wastes 100-400 tokens of latency with
    // no quality win. Pass `noThink: true` to skip it.
    const effectivePrompt = options.noThink
      ? `/no_think\n${prompt}`
      : prompt;
    // vllm-mlx is 2.5x faster — allow higher tokens (Qwen3 thinking uses ~200)
    // and block embed loop. Qwen3 thinking mode uses ~200 tokens for think,
    // leaving ~300 for actual content. Sufficient for summarization tasks.
    const body = JSON.stringify({
      model: MLX_GENERATE_MODEL,
      messages: [{ role: 'user', content: effectivePrompt }],
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature ?? 0.3,
      ...(options.seed != null ? { seed: options.seed } : {}),
    });
    const parsed = new URL(`${MLX_GENERATE_URL}/v1/chat/completions`);
    const req = httpRequest(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000, // 10min
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (status === 200) {
            const content = data.choices?.[0]?.message?.content || '';
            const usage = data.usage || {};
            trackMlxUsage(options.caller || 'unknown', usage.prompt_tokens || 0, usage.completion_tokens || 0);
            return resolve(content.trim());
          }
          const err = new Error(`mlx http ${status}: ${data.error || data.detail || 'unknown'}`);
          err.status = status;
          reject(err);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('mlx generate timeout')); });
    req.write(body);
    req.end();
  });
}

// JS-side serialization: only ONE mlxGenerate call can be in flight
// server-wide. Prevents the server's own background tasks from self-DoS
// against MLX's lock (we saw 12+ concurrent node→MLX sockets all waiting
// on the same lock, each returning 503 repeatedly).
// Priority queue for MLX generate. Skills = high, everything else = normal.
// High-priority items jump ahead in the queue so skills are usable ASAP.
const MLX_PRIORITY = { high: 0, normal: 1, low: 2 };
const _mlxQueue = [];      // { resolve, reject, fn, priority }
let _mlxRunning = false;

// Per-item cross-process lock wait cap. Server-side generate is mostly
// background loops (chunk-summary, predict, skill-suggestion) that can
// afford to wait for a quick external caller; but if an agent's LoCoMo
// run takes the full 20 min we'd rather skip this loop tick than hang
// the queue forever. 5 min is the sweet spot — longer than any single
// external call but short enough that /ai/summarize (user-facing) can
// fail gracefully.
const _MLX_FILE_LOCK_WAIT_MS = 5 * 60 * 1000;
const _MLX_FILE_LOCK_HOLDER_PREFIX = `vcontext-server:${process.pid}`;
let _mlxFileLockSkips = 0;
let _mlxFileLockHoldMs = 0;
let _lastMlxFileLockLogAt = 0;

async function _mlxDrain() {
  if (_mlxRunning) return;
  _mlxRunning = true;
  while (_mlxQueue.length > 0) {
    // Sort by priority (stable: same-priority preserves insertion order)
    _mlxQueue.sort((a, b) => a.priority - b.priority);
    const item = _mlxQueue.shift();
    // ── Cross-process MLX lock handshake ─────────────────────
    // Before running the item, acquire /tmp/aios-mlx-lock. If an external
    // actor (task-runner, agent, locomo-eval, self-evolve) holds it, wait
    // up to _MLX_FILE_LOCK_WAIT_MS and then reject the item with a clear
    // error. Rejecting lets the caller decide (background loops retry
    // next tick; user-facing endpoints degrade gracefully).
    const holderId = `${_MLX_FILE_LOCK_HOLDER_PREFIX}:${Date.now()}`;
    const tAcq = Date.now();
    let acquired = false;
    try {
      acquired = await _fileTryMlxLock(holderId, { waitMs: _MLX_FILE_LOCK_WAIT_MS });
    } catch (e) {
      // Filesystem errors shouldn't crash the queue; log and fall through
      // as "not acquired" so the item gets a clean rejection.
      console.error('[mlx-lock] acquire error (non-fatal):', (e && e.message) || e);
    }
    if (!acquired) {
      _mlxFileLockSkips++;
      // Throttled logging — once every 5 min to avoid log spam when an
      // agent is holding the lock for the full window.
      if (Date.now() - _lastMlxFileLockLogAt > 5 * 60 * 1000) {
        const status = _fileMlxLockStatus();
        console.log(`[mlx-lock] yielding to external holder=${status.holder || '?'} age=${Math.round(status.ageMs/1000)}s (skip #${_mlxFileLockSkips})`);
        _lastMlxFileLockLogAt = Date.now();
      }
      item.reject(new Error('mlx-lock: external actor holding /tmp/aios-mlx-lock, skip this tick'));
      continue;
    }
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    } finally {
      _mlxFileLockHoldMs += Date.now() - tAcq;
      _fileReleaseMlxLock(holderId);
    }
  }
  _mlxRunning = false;
}

async function mlxGenerate(prompt, options = {}) {
  const priority = options.priority ?? MLX_PRIORITY.normal;
  return new Promise((resolve, reject) => {
    _mlxQueue.push({
      priority,
      resolve,
      reject,
      fn: async () => {
        const delays = [30000, 60000, 120000];
        let lastErr;
        for (let i = 0; i < delays.length + 1; i++) {
          try {
            return await mlxGenerateOnce(prompt, options);
          } catch (e) {
            lastErr = e;
            const transient = e.status === 503
              || e.code === 'ECONNREFUSED'
              || (e.message && /ECONNREFUSED|ECONNRESET|socket hang up/i.test(e.message));
            if (transient && i < delays.length) {
              await new Promise(r => setTimeout(r, delays[i]));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      },
    });
    _mlxDrain();
  });
}

// ── Local AI endpoint handlers ────────────────────────────────

// GET /ai/status — Show local AI status
function handleAiStatus(req, res) {
  // One aggregate query instead of 6 full-table scans — /ai/status was
  // 1.2s (6 × 200ms COUNT(*) over 40k rows). Single pass with SUM(CASE)
  // cuts it to ~200ms.
  let embeddingCount = 0;
  let embeddingBacklog = 0;       // 24h-recent eligible rows still missing embedding
  let embeddingEligibleTotal = 0; // total ELIGIBLE rows (denominator)
  let genStats = { summaries: 0, suggestions: 0, skills_created: 0, discoveries: 0 };
  try {
    const agg = dbQuery(`
      SELECT
        COUNT(*) AS total,
        COUNT(embedding) AS embedded,
        SUM(CASE WHEN reasoning IS NOT NULL AND reasoning != '' THEN 1 ELSE 0 END) AS with_reasoning,
        SUM(CASE WHEN type = 'skill-suggestion' THEN 1 ELSE 0 END) AS skill_suggestions,
        SUM(CASE WHEN type = 'skill-created' THEN 1 ELSE 0 END) AS skill_created,
        SUM(CASE WHEN type = 'skill-discovery' THEN 1 ELSE 0 END) AS skill_discoveries
      FROM entries;
    `)[0] || {};
    embeddingEligibleTotal = agg.total || 0;
    embeddingCount = agg.embedded || 0;
    embeddingBacklog = embeddingEligibleTotal - embeddingCount;
    genStats = {
      summaries: agg.with_reasoning || 0,
      suggestions: agg.skill_suggestions || 0,
      skills_created: agg.skill_created || 0,
      discoveries: agg.skill_discoveries || 0,
    };
  } catch {}

  sendJson(res, 200, {
    mlx_generate_available: mlxGenerateAvailable,
    mlx_generate_url: MLX_GENERATE_URL,
    mlx_generate_model: MLX_GENERATE_MODEL,
    gen_stats: genStats,
    mlx_available: mlxAvailable,
    mlx_url: MLX_EMBED_URL,
    mlx_model: mlxModelName,
    mlx_dim: mlxEmbedDim,
    embedding_count: embeddingCount,
    embedding_eligible_total: embeddingEligibleTotal,
    embedding_backlog: embeddingBacklog,
    preferred: {
      summarize: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
      embed: mlxAvailable ? `${mlxModelName} (mlx)` : null,
      judge: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
      code: mlxGenerateAvailable ? MLX_GENERATE_MODEL : null,
    },
    features: {
      auto_summarize: mlxGenerateAvailable,
      auto_embed: mlxAvailable,
      auto_conflict_resolve: mlxGenerateAvailable,
      semantic_search: mlxAvailable,
    },
  });
}

// POST /ai/summarize — Summarize entries using MLX generate
async function handleAiSummarize(req, res) {
  if (!mlxGenerateAvailable) {
    return sendJson(res, 503, { error: 'MLX generate server not available at ' + MLX_GENERATE_URL });
  }
  const body = await readBody(req);
  const ids = body.ids || [];

  if (ids.length === 0) {
    // Summarize all entries older than 24h that don't have a summary
    const rows = dbQuery(`SELECT id, content FROM entries WHERE reasoning IS NULL AND created_at < datetime('now', '-1 day') LIMIT 20;`);
    for (const row of rows) {
      try {
        const summary = await mlxGenerate(`Summarize in one sentence (max 50 words):\n\n${row.content.slice(0, 2000)}`, { maxTokens: 400, noThink: true });
        if (summary) dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${row.id};`);
      } catch {}
    }
    return sendJson(res, 200, { summarized: rows.length, model: MLX_GENERATE_MODEL });
  }

  // Summarize specific entries
  let count = 0;
  for (const id of ids) {
    const rows = dbQuery(`SELECT content FROM entries WHERE id = ${id};`);
    if (rows[0]) {
      try {
        const summary = await mlxGenerate(`Summarize in one sentence (max 50 words):\n\n${rows[0].content.slice(0, 2000)}`, { maxTokens: 400, noThink: true });
        if (summary) { dbExec(`UPDATE entries SET reasoning = ${esc(summary.trim())} WHERE id = ${id};`); count++; }
      } catch {}
    }
  }
  sendJson(res, 200, { summarized: count, model: MLX_GENERATE_MODEL });
}

// ── Cosine similarity for semantic search ─────────────────────
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// GET /search/semantic — Semantic similarity search using embeddings
async function handleSemanticSearch(req, res) {
  const params = parseQuery(req.url);
  const q = params.q;
  if (!q) return sendJson(res, 400, { error: 'Missing query parameter: q' });
  const typeFilter = params.type || ''; // NEW: restrict to a specific type

  // No embedding source at all → immediate FTS fallback
  // MLX is the sole embedding provider
  if (!mlxAvailable) {
    const limit = Math.min(parseInt(params.limit) || 10, 50);
    const typeClause = typeFilter ? ` AND type=${esc(typeFilter)}` : '';
    const ftsResults = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(q))} LIMIT ${limit * 3})${typeClause} LIMIT ${limit};`);
    parseTags(ftsResults);
    return sendJson(res, 200, { results: ftsResults, count: ftsResults.length, engine: 'fts-fallback', model_used: null, threshold: 0 });
  }

  const limit = Math.min(parseInt(params.limit) || 10, 50);
  const threshold = parseFloat(params.threshold) || 0.5;
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Generate query embedding — try MLX (fast ~30ms), then FTS fallback
  let queryEmbed;
  let embedSource = null;

  // Strategy 1: MLX (fast ~30ms on Apple Silicon GPU)
  // Only usable for vector search if MLX embedding dimension matches stored embeddings.
  // Use mlxEmbedFast (lock bypass + 2s timeout + LRU cache) — same fix
  // handleRecall got. The locked mlxEmbed serializes behind the background
  // _mlxEmbedBatchRaw loop and can stall /search/semantic for 30-60s.
  if (mlxAvailable) {
    try {
      const mlxResult = await mlxEmbedFast(q, 2000);
      if (mlxResult && mlxResult.length > 0) {
        // Check if MLX embedding dimension matches stored embeddings
        if (mlxResult.length === EMBED_DIM) {
          queryEmbed = mlxResult;
          embedSource = 'mlx';
        } else {
          // Dimension mismatch — MLX dim differs from stored embeddings
          // Can't use for vector search, but MLX is confirmed working
          // Fall through to FTS
        }
      }
    } catch (e) {
      // MLX failed — fall through to FTS
      console.log(`[search/semantic] MLX embed failed: ${e.message}`);
    }
  }

  // MLX is sole embedding provider
  // Strategy 2: FTS fallback if MLX embedding could not be generated
  if (!queryEmbed || queryEmbed.length === 0) {
    const ftsResults = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(q))} LIMIT ${limit});`);
    parseTags(ftsResults);
    return sendJson(res, 200, {
      results: ftsResults,
      count: ftsResults.length,
      engine: 'fts-fallback',
      model_used: null,
      threshold,
      _note: mlxAvailable
        ? `MLX available (dim=${mlxEmbedDim}) but mismatch with stored embeddings (dim=${EMBED_DIM}); fell back to FTS`
        : 'MLX embed server unavailable, fell back to FTS keyword search',
    });
  }

  const model_used = `${mlxModelName} (mlx)`;

  const results = [];

  // Type-scoped semantic search: when a type filter is active and the type
  // has relatively few entries, skip vec index (which is unfiltered) and
  // do JS cosine over embeddings of that type only. Guarantees the most
  // relevant entries of that type reach the caller even when dwarfed by
  // other types in the index.
  if (typeFilter) {
    const rows = dbQuery(`SELECT id, type, content, tags, created_at, reasoning, embedding FROM entries WHERE type=${esc(typeFilter)} AND embedding IS NOT NULL;`);
    for (const row of rows) {
      try {
        const entryEmbed = JSON.parse(row.embedding);
        const sim = cosineSimilarity(queryEmbed, entryEmbed);
        if (sim >= threshold || threshold <= 0.1) {
          results.push({
            id: row.id, type: row.type, content: row.content,
            tags: row.tags, created_at: row.created_at, reasoning: row.reasoning,
            similarity: Math.round(sim * 1000) / 1000, _engine: 'type-scoped',
          });
        }
      } catch {}
    }
    results.sort((a, b) => b.similarity - a.similarity);
    if (results.length > limit) results.length = limit;
    parseTags(results);
    return sendJson(res, 200, { results, count: results.length, engine: 'type-scoped', model_used, threshold });
  }

  // Fast path: sqlite-vec index search (no type filter)
  if (vecDb) {
    const vecResults = vecSearch(queryEmbed, limit * 2);
    if (vecResults.length > 0) {
      const ids = vecResults.map(r => r.rowid);
      const entries = dbQuery(`SELECT id, type, content, tags, created_at, reasoning FROM entries WHERE id IN (${ids.join(',')});`);
      const entryMap = {};
      for (const e of entries) entryMap[e.id] = e;

      for (const vr of vecResults) {
        const entry = entryMap[vr.rowid];
        if (!entry) continue;
        // vec0 returns L2 distance; convert to similarity via 1/(1+d)
        const similarity = Math.round(1 / (1 + vr.distance) * 1000) / 1000;
        if (similarity >= threshold || threshold <= 0.1) {  // always include at low threshold
          results.push({
            id: entry.id, type: entry.type, content: entry.content,
            tags: entry.tags, created_at: entry.created_at, reasoning: entry.reasoning,
            similarity, _engine: 'sqlite-vec',
          });
        }
      }
      results.sort((a, b) => b.similarity - a.similarity);
    }
  }

  // Slow path fallback: JS cosine over all entries (if sqlite-vec unavailable or empty)
  if (results.length === 0 && !vecDb) {
    const typeClause = typeFilter ? ` AND type=${esc(typeFilter)}` : '';
    const rows = dbQuery(`SELECT id, type, content, tags, created_at, embedding, reasoning FROM entries WHERE embedding IS NOT NULL${typeClause};`);
    for (const row of rows) {
      try {
        const entryEmbed = JSON.parse(row.embedding);
        const sim = cosineSimilarity(queryEmbed, entryEmbed);
        if (sim >= threshold) {
          results.push({
            id: row.id, type: row.type, content: row.content,
            tags: row.tags, created_at: row.created_at, reasoning: row.reasoning,
            similarity: Math.round(sim * 1000) / 1000, _engine: 'js-cosine',
          });
        }
      } catch {}
    }
    results.sort((a, b) => b.similarity - a.similarity);
  }

  // Apply group access filter
  const accessibleGroups = getAccessibleGroups(auth);
  const filtered = accessibleGroups ? results.filter(r => {
    const tags = r.tags || '';
    if (!tags.includes('group:')) return true;
    return accessibleGroups.some(g => tags.includes(`group:${g}`));
  }) : results;

  parseTags(filtered.slice(0, limit));

  sendJson(res, 200, {
    results: filtered.slice(0, limit),
    count: Math.min(filtered.length, limit),
    engine: results[0]?._engine || (vecDb ? 'sqlite-vec' : 'js-cosine'),
    model_used: model_used,
    embed_source: embedSource,
    threshold,
  });
}

// ── Usage analytics ───────────────────────────────────────────

// POST /analytics/track — Track a usage event
async function handleAnalyticsTrack(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const { event_type, skill_name, session, metadata } = body;

  if (!event_type) {
    return sendJson(res, 400, { error: 'Missing required field: event_type' });
  }

  const metaStr = metadata ? JSON.stringify(metadata) : '{}';
  const userId = auth.userId || null;

  dbExec(
    `INSERT INTO analytics (event_type, skill_name, session, user_id, metadata)
     VALUES (${esc(event_type)}, ${esc(skill_name || null)}, ${esc(session || null)}, ${esc(userId)}, ${esc(metaStr)});`
  );

  sendJson(res, 201, { tracked: true, event_type, skill_name: skill_name || null });
}

// GET /analytics/report — Usage analytics report
function handleAnalyticsReport(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const params = parseQuery(req.url);
  const days = parseInt(params.days) || 30;
  const since = `datetime('now', '-${days} days')`;

  // Total events in period
  const totalRows = dbQuery(`SELECT COUNT(*) as count FROM analytics WHERE created_at >= ${since};`);
  const totalEvents = totalRows[0]?.count || 0;

  // Skill usage breakdown
  const skillRows = dbQuery(
    `SELECT skill_name, COUNT(*) as count, MAX(created_at) as last_used
     FROM analytics
     WHERE skill_name IS NOT NULL AND created_at >= ${since}
     GROUP BY skill_name
     ORDER BY count DESC;`
  );
  const skillUsage = skillRows.map(r => ({
    skill: r.skill_name,
    count: r.count,
    last_used: r.last_used,
  }));

  // Find skills that were never used (compare against known skills from entries tags)
  const knownSkillRows = dbQuery(
    `SELECT DISTINCT skill_name FROM analytics WHERE skill_name IS NOT NULL;`
  );
  const usedSkills = new Set(knownSkillRows.map(r => r.skill_name));
  // Try to discover skill names from entry tags
  const tagRows = dbQuery(
    `SELECT DISTINCT tags FROM entries WHERE tags LIKE '%skill:%';`
  );
  const allSkills = new Set();
  for (const r of tagRows) {
    try {
      const tags = JSON.parse(r.tags);
      for (const t of tags) {
        if (t.startsWith('skill:')) allSkills.add(t.slice(6));
      }
    } catch {}
  }
  const neverUsed = [...allSkills].filter(s => !usedSkills.has(s));

  // Daily activity
  const dailyRows = dbQuery(
    `SELECT DATE(created_at) as date, COUNT(*) as events
     FROM analytics
     WHERE created_at >= ${since}
     GROUP BY DATE(created_at)
     ORDER BY date DESC;`
  );
  const dailyActivity = dailyRows.map(r => ({
    date: r.date,
    events: r.events,
  }));

  // Top users
  const userRows = dbQuery(
    `SELECT user_id, COUNT(*) as events
     FROM analytics
     WHERE user_id IS NOT NULL AND created_at >= ${since}
     GROUP BY user_id
     ORDER BY events DESC
     LIMIT 20;`
  );
  const topUsers = userRows.map(r => ({
    user: r.user_id,
    events: r.events,
  }));

  sendJson(res, 200, {
    period: `${days} days`,
    total_events: totalEvents,
    skill_usage: skillUsage,
    never_used: neverUsed,
    daily_activity: dailyActivity,
    top_users: topUsers,
  });
}

// ── Predictive search with privacy filter ─────────────────────

// Privacy filter: strip sensitive info before sending to external search
function sanitizeForExternalSearch(text) {
  return redactPII(text, { collapseWhitespace: true });
}

// Centralised PII redaction. Use everywhere data crosses a trust
// boundary (external search, audit log, dashboard, exports). Keep
// patterns conservative — false positives are less harmful than leaks.
function redactPII(text, opts = {}) {
  if (!text) return '';
  let s = String(text);
  // File paths
  s = s.replace(/\/(?:Users|home|var|tmp|etc|opt)\/[\w\-./]+/g, '[PATH]');
  // URLs
  s = s.replace(/https?:\/\/[^\s)]+/g, '[URL]');
  // Email
  s = s.replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[EMAIL]');
  // API keys / tokens (alnum >=20)
  s = s.replace(/\b[A-Za-z0-9_\-]{20,}\b/g, '[TOKEN]');
  // IPv4
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]');
  // SSN-like (XXX-XX-XXXX)
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
  // Credit card (13-19 digits w/ optional dashes/spaces)
  s = s.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CC]');
  // Phone (Japanese / E.164 / common formats)
  s = s.replace(/(?:\+?\d{1,3}[- ]?)?(?:\(?\d{2,4}\)?[- ]?){2,4}\d{2,4}/g, m => m.length >= 10 ? '[PHONE]' : m);
  // Tag-style user identifiers
  s = s.replace(/\b(?:user|userId|email):\S+/gi, '[USERID]');
  if (opts.collapseWhitespace) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * POST /predictive-search
 * Body: { prompt }
 * Extracts keywords from user prompt (via MLX generate, local only),
 * sanitizes for privacy, searches the web, stores results in vcontext.
 * Fully async — returns immediately, results stored in background.
 */
/**
 * POST /completion-check
 * Body: { session, assistant_message }
 * Auto-detects completion claims, runs checklist, stores violations as rules.
 */
async function handleCompletionCheck(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const msg = body.assistant_message || '';
  const session = body.session || '';

  // Detect completion claims
  const completionPatterns = /完了|complete|done|finished|100%|全て.*完了|実装.*済|修正.*済|対応.*済|コミット.*済/i;
  if (!completionPatterns.test(msg)) {
    return sendJson(res, 200, { checked: false, reason: 'no completion claim detected' });
  }

  // Completion check uses MLX generate (24/7)
  if (!mlxGenerateAvailable) {
    return sendJson(res, 200, { checked: true, analyzing: false, reason: 'MLX generate not available' });
  }

  sendJson(res, 202, { checked: true, analyzing: true });

  // Background: analyze recent work for gaps
  setImmediate(async () => {
    try {

      // Gather recent session activity
      const recentWork = dbQuery(`SELECT type, tool_name, substr(content,1,200) as preview FROM entry_index WHERE session = ${esc(session)} AND created_at >= datetime('now', '-1 hour') ORDER BY entry_id DESC LIMIT 30;`);

      const workSummary = recentWork.map(r =>
        `[${r.type}] ${r.tool_name || ''} ${r.preview || ''}`
      ).join('\n').slice(0, 2000);

      // Search for latest best practices relevant to this work
      let latestPractices = '';
      try {
        const tools = recentWork.map(r => r.tool_name).filter(Boolean);
        const mainTool = tools[0] || 'code';
        const searchQuery = sanitizeForExternalSearch(`${mainTool} completion checklist best practices`);
        const searchResult = await new Promise((resolve) => {
          const req = httpRequest(new URL(`${searxngUrl}/search?q=${encodeURIComponent(searchQuery + ' 2026')}&format=json&language=auto`), {
            method: 'GET', timeout: 8000,
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (searchResult && searchResult.results) {
          latestPractices = searchResult.results.slice(0, 3).map(r =>
            `- ${(r.content || '').slice(0, 150)}`
          ).join('\n');
        }
      } catch {}

      const checkPrompt = `An AI just claimed this work is complete: "${msg.slice(0, 300)}"

Recent actions in this session:
${workSummary}

${latestPractices ? `Latest best practices from web (2026):\n${latestPractices}\n` : ''}Check for these common AI omissions:
1. Did it update documentation (README, CLAUDE.md, roadmap)?
2. Did it run tests, build, lint?
3. Are there workarounds left (grep -v, TODO, FIXME, skip)?
4. Did it verify git status is clean (stash, untracked)?
5. Did it check related files that should change together?
6. Did it verify previous session claims independently?

List ONLY the violations found (omissions). If none, say "NONE".
Be specific about what was missed.`;

      const violations = await mlxGenerate(checkPrompt, { maxTokens: 40960, temperature: 0.2 });
      if (!violations || violations.trim() === 'NONE' || violations.length < 10) {
        console.log('[vcontext:check] Completion check passed');
        return;
      }

      // Store violations
      const content = JSON.stringify({
        completion_claim: msg.slice(0, 300),
        violations: violations.trim(),
        session,
        detected_at: new Date().toISOString(),
      });
      dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('completion-violation', ${esc(content)}, '["completion-violation","auto"]', ${esc(session)}, ${estimateTokens(content)}, datetime('now'), 0, 'ram');`);

      // Auto-generate a new rule from the violation pattern
      const rulePrompt = `Based on this violation, write a short MANDATORY RULE (1-2 sentences) to prevent it from happening again. Output ONLY the rule text.

Violation: ${violations.trim().slice(0, 300)}`;
      const newRule = await mlxGenerate(rulePrompt, { maxTokens: 40960, temperature: 0.2 });
      if (newRule && newRule.length > 20) {
        // Check if a similar rule already exists
        const existing = dbQuery(`SELECT id FROM entries WHERE type = 'decision' AND content LIKE ${esc('%' + newRule.trim().slice(0, 30) + '%')} AND tags LIKE '%global-rule%' LIMIT 1;`);
        if (existing.length === 0) {
          dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier, confidence, status) VALUES ('decision', ${esc('MANDATORY RULE: ' + newRule.trim())}, '["global-rule","quality-gate","mandatory","auto-generated"]', 'global', ${estimateTokens(newRule)}, datetime('now'), 0, 'ram', 'high', 'active');`);
          console.log(`[vcontext:check] New rule auto-generated: ${newRule.trim().slice(0, 80)}`);
        }
      }

      console.log(`[vcontext:check] Violations found: ${violations.trim().slice(0, 100)}`);
    } catch (e) {
      console.error('[vcontext:check] Error:', e.message);
    }
  });
}

/**
 * GET /predict/next — Pillar 4 (Predictive Ambience).
 *
 * Surface the top-K likely next actions given recent activity, so
 * Claude Code / the dashboard can pre-warm context instead of waiting
 * for the user to ask.
 *
 * Pure-SQL, no MLX round-trip — fits under 30ms so it can be called
 * on every session turn without tax. Heavier prediction (MLX
 * skill-suggestion generation) still runs in the 30-min background
 * loop; this endpoint just surfaces what's already been computed plus
 * cheap statistical signals.
 *
 * Signals (each contributes a candidate with a score 0-1):
 *   1. tool_name transitions in last 24h — if Read often follows Bash,
 *      and the latest tool was Bash, Read scores high.
 *   2. top skills used in last 24h (usage recency + frequency).
 *   3. open skill-gap prompts (unmatched user asks) — highest signal:
 *      if they reappear the system should have something ready.
 *   4. recent skill-suggestion entries from runOnePrediction().
 *
 * Query params:
 *   session=<id>   — scope tool-transition signal to this session
 *   limit=<int>    — default 5, max 20
 *
 * Shape: { generated_at, signals: { last_tool, active_gaps, top_skills },
 *          predictions: [{ kind, label, score, reason }] }
 */
function handlePredictNext(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('session') || null;
  let limit = parseInt(url.searchParams.get('limit') || '5', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 5;
  if (limit > 20) limit = 20;

  const predictions = [];

  // Signal 1 — tool transitions. Find last tool in the (optionally
  // session-scoped) window, then count what followed it historically.
  let lastTool = null;
  try {
    const sessionClause = sessionId ? `AND session = ${esc(sessionId)}` : '';
    const lastRow = dbQuery(`SELECT tool_name FROM entry_index WHERE tool_name IS NOT NULL ${sessionClause} ORDER BY entry_id DESC LIMIT 1;`);
    lastTool = lastRow[0]?.tool_name || null;
    if (lastTool) {
      // Get ordered tool stream in last 24h, then count pair frequencies.
      // Small enough that an in-memory scan is fine — entry_index is indexed
      // by entry_id and we bound to 500 rows.
      const stream = dbQuery(`SELECT tool_name FROM entry_index WHERE tool_name IS NOT NULL AND created_at >= datetime('now', '-24 hours') ORDER BY entry_id ASC LIMIT 500;`);
      const followCounts = {};
      let total = 0;
      for (let i = 0; i < stream.length - 1; i++) {
        if (stream[i].tool_name === lastTool) {
          const next = stream[i + 1].tool_name;
          if (next && next !== lastTool) {
            followCounts[next] = (followCounts[next] || 0) + 1;
            total++;
          }
        }
      }
      const ranked = Object.entries(followCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [tool, cnt] of ranked) {
        predictions.push({
          kind: 'tool',
          label: tool,
          score: Number((cnt / Math.max(total, 1)).toFixed(3)),
          reason: `followed "${lastTool}" ${cnt}× in last 24h`,
        });
      }
    }
  } catch (e) { /* best-effort */ }

  // Signal 2 — most-used skills (last 24h, from skill-usage entries).
  let topSkills = [];
  try {
    const usageRows = dbQuery(`SELECT content FROM entries WHERE type = 'skill-usage' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 200;`);
    const counts = {};
    for (const row of usageRows) {
      try {
        const d = JSON.parse(row.content);
        for (const n of (d.skills || [])) counts[n] = (counts[n] || 0) + 1;
      } catch {}
    }
    topSkills = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const maxCnt = Math.max(1, topSkills[0]?.[1] || 1);
    for (const [name, cnt] of topSkills) {
      predictions.push({
        kind: 'skill',
        label: name,
        score: Number((cnt / maxCnt * 0.8).toFixed(3)),
        reason: `used ${cnt}× in last 24h`,
      });
    }
  } catch {}

  // Signal 3 — open skill-gaps. Highest-signal: user literally asked for
  // something that had no matching skill. Likely to recur.
  let activeGaps = [];
  try {
    const gapRows = dbQuery(`SELECT id, content, created_at FROM entries WHERE type = 'skill-gap' AND created_at >= datetime('now', '-48 hours') ORDER BY id DESC LIMIT 5;`);
    for (const row of gapRows) {
      try {
        const d = JSON.parse(row.content);
        if (!d.prompt) continue;
        activeGaps.push({ id: row.id, prompt: d.prompt, created_at: row.created_at });
        predictions.push({
          kind: 'gap',
          label: d.prompt.slice(0, 80),
          score: 0.9,
          reason: 'recently unmatched user prompt (likely to recur)',
          parent_id: row.id,
        });
      } catch {}
    }
  } catch {}

  // Signal 4 — surface fresh skill-suggestion entries (already predicted
  // by runOnePrediction's MLX call; this just exposes them via HTTP).
  try {
    const sugRows = dbQuery(`SELECT id, content, created_at FROM entries WHERE type = 'skill-suggestion' AND created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 3;`);
    for (const row of sugRows) {
      try {
        const d = JSON.parse(row.content);
        if (!d.suggestion) continue;
        predictions.push({
          kind: 'suggestion',
          label: d.suggestion.slice(0, 120),
          score: 0.7,
          reason: 'MLX-generated skill suggestion (background loop)',
          parent_id: row.id,
        });
      } catch {}
    }
  } catch {}

  // Sort combined predictions by score, cap to limit
  predictions.sort((a, b) => b.score - a.score);
  const top = predictions.slice(0, limit);

  sendJson(res, 200, {
    generated_at: new Date().toISOString(),
    signals: {
      last_tool: lastTool,
      active_gap_count: activeGaps.length,
      top_skills: topSkills.map(([n, c]) => ({ name: n, count: c })),
    },
    predictions: top,
  });
}

async function handlePredictiveSearch(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  const body = await readBody(req);
  const prompt = body.prompt || '';
  if (!prompt || prompt.length < 10) {
    return sendJson(res, 200, { status: 'skipped', reason: 'prompt too short' });
  }

  // Predictive search uses MLX generate (24/7)
  if (!mlxGenerateAvailable) {
    return sendJson(res, 200, { status: 'skipped', reason: 'MLX generate not available' });
  }

  // Return immediately — do work in background
  sendJson(res, 202, { status: 'searching', prompt_length: prompt.length });

  setImmediate(async () => {
    console.log(`[vcontext:predict] handler entered, prompt_len=${prompt.length}`);
    try {
      if (!mlxGenerateAvailable) { console.log('[vcontext:predict] MLX unavailable, abort'); return; }

      // Step 1: Extract search keywords using MLX generate (no external call)
      const keywordPrompt = `Extract 2-3 search keywords from this user request. Output ONLY the keywords separated by spaces, nothing else. No explanation.

Request: ${prompt.slice(0, 500)}

Keywords:`;

      // Qwen3 emits <think>…</think> before answering. If max_tokens
      // is consumed by thinking, content is empty. 4000 leaves room
      // for think + short answer. If MLX still returns empty, fall back
      // to the user's prompt words so the pipeline keeps moving.
      let keywordsRaw = '';
      try {
        keywordsRaw = await mlxGenerate(keywordPrompt, { maxTokens: 2000, temperature: 0.1, noThink: true });
      } catch (e) {
        console.error(`[vcontext:predict] mlxGenerate failed: ${e.message}`);
      }
      let keywords = (keywordsRaw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!keywords || keywords.length < 3) {
        const words = prompt.match(/[\p{L}\p{N}]{3,}/gu) || [];
        keywords = words.slice(0, 3).join(' ');
        if (!keywords || keywords.length < 3) {
          console.log('[vcontext:predict] No usable keywords (empty MLX + empty prompt)');
          return;
        }
        console.log(`[vcontext:predict] Fallback keywords from prompt: "${keywords}"`);
      }
      const keywordsClean = keywords.split('\n')[0].trim();

      // Step 2: Privacy filter — sanitize before external search
      const sanitized = sanitizeForExternalSearch(keywordsClean);
      if (!sanitized || sanitized.length < 3) return;
      console.log(`[vcontext:predict] Keywords: "${keywordsClean}" → sanitized: "${sanitized}"`);

      // Step 3: Multi-source search with rate limiting
      // Sources: (a) vcontext FTS, (b) SearXNG, (c) MLX generate, (d) Wikipedia
      const parts = [];
      const searchWords = sanitized.split(' ').filter(w => w.length > 2);

      // 3a: Search own vcontext for related entries
      try {
        const related = dbQuery(`SELECT id, type, content, created_at FROM entries WHERE id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ${esc(ftsQuery(sanitized))} LIMIT 5);`);
        for (const r of related) {
          parts.push(`[past:${r.type}] ${String(r.content).slice(0, 200)}`);
        }
      } catch {}

      // 3b: SearXNG meta-search (Google+Bing+DDG+Brave, local instance)
      detectSearxngUrl(); // re-detect in case Docker restarted
      try {
        const searchQuery = sanitized + ' 2026';
        const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(searchQuery)}&format=json&language=auto`;
        const searchResult = await new Promise((resolve) => {
          const req = httpRequest(new URL(searchUrl), {
            method: 'GET', timeout: 10000,
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (searchResult && searchResult.results) {
          for (const r of searchResult.results.slice(0, 5)) {
            const engine = r.engine || '?';
            const title = r.title || '';
            const content = r.content || '';
            if (content.length > 20) {
              parts.push(`[web:${engine}] ${title}: ${content.slice(0, 300)}`);
            }
          }
          console.log(`[vcontext:predict] SearXNG: ${searchResult.results.length} results`);
        } else {
          console.log(`[vcontext:predict] SearXNG: no results or null response`);
        }
      } catch (e) {
        console.log(`[vcontext:predict] SearXNG error: ${e.message}`);
      }

      // 3c: Generate background knowledge with MLX (local, no external call)
      try {
        const bgPrompt = `List 3 key technical facts or best practices about: ${sanitized}
Output as a numbered list. Be specific and actionable. Max 100 words.`;
        const bgKnowledge = await mlxGenerate(bgPrompt, { maxTokens: 40960, temperature: 0.3 });
        if (bgKnowledge && bgKnowledge.length > 20) {
          parts.push(`[knowledge] ${bgKnowledge.trim()}`);
        }
      } catch {}

      // 3d: Wikipedia (one request for first keyword)
      try {
        const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(searchWords[0] || sanitized.split(' ')[0])}`;
        const wikiResult = await new Promise((resolve) => {
          const req = httpsRequest(new URL(wikiUrl), {
            method: 'GET', timeout: 5000,
            headers: { 'User-Agent': 'vcontext/2.0' },
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });
        if (wikiResult && wikiResult.extract) {
          parts.push(`[wiki] ${wikiResult.extract.slice(0, 300)}`);
        }
      } catch {}

      if (parts.length === 0) return;

      const content = JSON.stringify({
        query: sanitized,
        original_keywords: keywords.trim(),
        results: parts,
        source: 'vcontext+mlx+wikipedia',
        fetched_at: new Date().toISOString(),
      });

      // Step 5: Store in vcontext (use handleStore-compatible direct insert)
      try {
        const tagsJson = JSON.stringify(['predictive-search', 'auto']);
        const tokenEst = estimateTokens(content);
        // Use parameterized-safe esc() for the insert
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('predictive-search', ${esc(content)}, ${esc(tagsJson)}, ${esc(body.session || 'predictive')}, ${tokenEst}, datetime('now'), 0, 'ram');`);
        console.log(`[vcontext:predict] Searched: "${sanitized}" → ${parts.length} results stored`);
      } catch (storeErr) {
        // Fallback: store a simplified version if content has problematic chars
        const simpleContent = JSON.stringify({ query: sanitized, results: parts.map(p => p.slice(0, 200)), source: 'searxng' });
        try {
          dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate, last_accessed, access_count, tier) VALUES ('predictive-search', ${esc(simpleContent)}, '["predictive-search","auto"]', ${esc(body.session || 'predictive')}, ${estimateTokens(simpleContent)}, datetime('now'), 0, 'ram');`);
          console.log(`[vcontext:predict] Searched: "${sanitized}" → ${parts.length} results stored (simplified)`);
        } catch (e2) {
          console.error(`[vcontext:predict] Store failed: ${e2.message}`);
        }
      }
    } catch (e) {
      // Non-fatal
      console.error('[vcontext:predict] Error:', e.message);
    }
  });
}

// GET /skills/effectiveness — Skill usage stats + effectiveness
function handleSkillEffectiveness(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });

  // Count skill usage from skill-usage entries
  const usageRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-usage' ORDER BY id DESC LIMIT 500;");
  const skillCounts = {};
  for (const row of usageRows) {
    try {
      const d = JSON.parse(row.content);
      for (const name of (d.skills || [])) {
        skillCounts[name] = (skillCounts[name] || 0) + 1;
      }
    } catch {}
  }

  // Count skill creation
  const createdRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-created';");
  const created = createdRows.map(r => { try { return JSON.parse(r.content).skill_name; } catch { return null; } }).filter(Boolean);

  // Count total registered skills
  const registeredRows = dbQuery("SELECT content FROM entries WHERE type = 'skill-registry';");
  const registered = registeredRows.map(r => { try { return JSON.parse(r.content).name; } catch { return null; } }).filter(Boolean);

  // Find never-used skills
  const neverUsed = registered.filter(name => !skillCounts[name]);

  // Sort by usage
  const ranked = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  sendJson(res, 200, {
    total_registered: registered.length,
    total_auto_created: created.length,
    usage_ranking: ranked,
    never_used: neverUsed,
    never_used_count: neverUsed.length,
  });
}

// GET /metrics/report — API performance metrics
function handleMetricsReport(req, res) {
  const auth = validateApiKey(req);
  if (!auth.valid) return sendJson(res, 401, { error: 'Invalid API key' });
  const params = parseQuery(req.url);
  const hours = parseInt(params.hours) || 24;
  const since = esc(new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19));

  // Per-operation aggregates
  const opRows = dbQuery(`SELECT operation, COUNT(*) as count, AVG(latency_ms) as avg_latency, AVG(result_count) as avg_results, SUM(estimated_tokens_in) as total_tokens_in, SUM(estimated_tokens_out) as total_tokens_out FROM api_metrics WHERE created_at >= ${since} GROUP BY operation;`);
  const operations = {};
  for (const r of opRows) {
    operations[r.operation] = {
      count: r.count,
      avg_latency_ms: Math.round((r.avg_latency || 0) * 10) / 10,
      avg_result_count: Math.round((r.avg_results || 0) * 10) / 10,
      total_tokens_in: r.total_tokens_in || 0,
      total_tokens_out: r.total_tokens_out || 0,
    };
  }

  // Derived: resume cost (tokens used in session-recall operations)
  const resumeRows = dbQuery(`SELECT SUM(estimated_tokens_out) as cost FROM api_metrics WHERE task_kind = 'session-recall' AND created_at >= ${since};`);
  const resumeCost = resumeRows[0]?.cost || 0;

  // Derived: search hit rate (avg results / requested limit proxy)
  const recallOp = operations['recall'];
  const hitRate = recallOp ? Math.min(1, (recallOp.avg_result_count || 0) / 10) : 0;

  // Recent operations
  const recentRows = dbQuery(`SELECT * FROM api_metrics ORDER BY id DESC LIMIT 20;`);

  // Index stats
  const indexCount = dbQuery('SELECT COUNT(*) as c FROM entry_index;');
  const entryCount = dbQuery('SELECT COUNT(*) as c FROM entries;');

  // Credit savings calculation (two views):
  //
  // 24h savings: "of today's work, how much was served by prior context?"
  //   = prior_stored / (prior_stored + period_new)
  //   prior_stored = all tokens stored BEFORE this period
  //   period_new = tokens created in this period
  //
  // Cumulative: "of all knowledge, how much is reusable?"
  //   = all_stored / (all_stored + period_new)

  // All stored tokens
  const allStoredRows = dbQuery(`SELECT SUM(token_estimate) as total FROM entries;`);
  const allStoredTokens = allStoredRows[0]?.total || 0;

  // Tokens created in this period (new work)
  const periodNewRows = dbQuery(`SELECT SUM(token_estimate) as total FROM entries WHERE created_at >= ${since};`);
  const periodNewTokens = periodNewRows[0]?.total || 0;

  // Prior context = all stored minus what was created in this period
  const priorStoredTokens = Math.max(0, allStoredTokens - periodNewTokens);

  // 24h savings: prior context that didn't need regenerating / total needed
  const periodTotal = priorStoredTokens + periodNewTokens;
  const periodSavingsRate = periodTotal > 0 ? priorStoredTokens / periodTotal : 0;

  // Cumulative savings: all_stored / (all_stored + period_new)
  const cumulativeTotal = allStoredTokens + periodNewTokens;
  const cumulativeSavingsRate = cumulativeTotal > 0 ? allStoredTokens / cumulativeTotal : 0;

  // Session count for context
  const sessionCountRows = dbQuery(`SELECT COUNT(DISTINCT session) as c FROM entry_index WHERE created_at >= ${since};`);
  const activeSessions = sessionCountRows[0]?.c || 0;

  // Per-session breakdown
  const sessionRows = dbQuery(`SELECT session, COUNT(*) as events, SUM(token_estimate) as tokens FROM entry_index WHERE session IS NOT NULL AND created_at >= ${since} GROUP BY session ORDER BY events DESC LIMIT 20;`);
  const perSession = sessionRows.map(r => {
    const sessionNewTok = r.tokens || 0;
    const sessionTotal = allStoredTokens + sessionNewTok;
    return {
      session: r.session,
      events: r.events,
      tokens: sessionNewTok,
      savings_rate: sessionTotal > 0 ? Math.round(allStoredTokens / sessionTotal * 1000) / 1000 : 0,
    };
  });

  // Per-user breakdown (from entry tags)
  const userRows = dbQuery(`SELECT tags FROM entries WHERE created_at >= ${since} AND tags LIKE '%user:%';`);
  const userMap = {};
  for (const row of userRows) {
    try {
      const tags = JSON.parse(row.tags);
      for (const t of tags) {
        if (t.startsWith('user:')) {
          const u = t.slice(5);
          userMap[u] = (userMap[u] || 0) + 1;
        }
      }
    } catch {}
  }
  const perUser = Object.entries(userMap).sort((a, b) => b[1] - a[1]).map(([user, events]) => ({ user, events }));

  // Determine project (cwd) breakdown from entry_index content
  const projectRows = dbQuery(`SELECT ei.session, e.content FROM entry_index ei JOIN entries e ON ei.entry_id = e.id WHERE ei.created_at >= ${since} AND ei.session IS NOT NULL GROUP BY ei.session LIMIT 20;`);
  const projectMap = {};
  for (const row of projectRows) {
    try {
      const d = JSON.parse(row.content);
      const cwd = d.cwd || '';
      const project = cwd.split('/').filter(Boolean).pop() || 'unknown';
      projectMap[project] = (projectMap[project] || 0) + 1;
    } catch {}
  }
  const perProject = Object.entries(projectMap).sort((a, b) => b[1] - a[1]).map(([project, sessions]) => ({ project, sessions }));

  // Skill inventory for dashboard Metrics panel.
  // Note: some skill-registry contents contain YAML-style `"description":"|"`
  // which makes the string invalid JSON, so json_extract fails. Count by
  // distinct entry id instead and fall back to total if empty.
  const skillCountRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-registry';`);
  const skillCount = skillCountRow[0]?.c || 0;
  const skillCreatedRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-created';`);
  const skillCreated = skillCreatedRow[0]?.c || 0;
  // Auto-created within the current reporting window (option C — show both
  // lifetime and period counts so users know what's recent vs historical)
  const skillCreatedPeriodRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-created' AND created_at >= ${since};`);
  const skillCreatedPeriod = skillCreatedPeriodRow[0]?.c || 0;
  const skillUsageRow = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-usage' AND created_at >= ${since};`);
  const skillUsageRecent = skillUsageRow[0]?.c || 0;

  sendJson(res, 200, {
    period_hours: hours,
    operations,
    skills: {
      registered: skillCount,
      auto_created: skillCreated,                // lifetime total
      auto_created_in_period: skillCreatedPeriod, // within period_hours window
      usage_in_period: skillUsageRecent,
    },
    derived: {
      resume_cost_tokens: resumeCost,
      search_hit_rate: Math.round(hitRate * 1000) / 1000,
      period_savings_rate: periodSavingsRate,
      prior_stored_tokens: priorStoredTokens,
      period_new_tokens: periodNewTokens,
      cumulative_savings_rate: cumulativeSavingsRate,
      cumulative_stored_tokens: allStoredTokens,
      active_sessions: activeSessions,
    },
    per_session: perSession,
    per_user: perUser,
    per_project: perProject,
    index: {
      indexed: indexCount[0]?.c || 0,
      total: entryCount[0]?.c || 0,
      coverage: entryCount[0]?.c ? Math.round((indexCount[0]?.c || 0) / entryCount[0].c * 1000) / 1000 : 0,
    },
    recent_operations: recentRows,
  });
}

// ── Request router ─────────────────────────────────────────────
const ENDPOINTS_LIST = [
  'POST   /store             — store context entry (body: {type,content,tags?,session?,namespace?,group?,reasoning?,conditions?,supersedes?,confidence?,status?,parent_id?})',
  'GET    /trace/:id         — Pillar 3: causal ancestry walk via parent_id (root -> target + children)',
  'GET    /predict/next      — Pillar 4: ranked next-likely tools/skills/gaps (?session=&limit=)',
  'GET    /export            — Pillar 5: portable NDJSON dump of entries (owner only, ?since=&limit=&max_entries=&include_sensitive=)',
  'GET    /recall?q=         — full-text search (cascading tiers, &namespace=project-name)',
  'GET    /recent?n=         — recent entries (cascading tiers, &namespace=project-name)',
  'GET    /session/:id       — session entries',
  'POST   /summarize         — compact old entries',
  'GET    /stats             — database statistics',
  'DELETE /prune             — remove old entries',
  'GET    /health            — health check',
  'GET    /feed?since=       — activity feed since timestamp (&exclude_user=userId)',
  'POST   /tier/migrate      — trigger tier migration',
  'GET    /tier/stats        — per-tier statistics',
  'POST   /tier/config       — configure cloud provider',
  'POST   /auth/create-key   — create API key {userId, name, role?, groups?}',
  'GET    /auth/whoami       — show current user identity, role, groups',
  'POST   /auth/create-group — create group (owner only) {groupId, name}',
  'GET    /auth/groups       — list groups (owner=all, others=own)',
  'POST   /auth/update-key   — update key role/groups {apiKey, role?, groups?}',
  'GET    /auth/keys         — list API keys (admin+ only)',
  'POST   /resolve           — resolve conflicting decisions {query, context?, candidates?}',
  'POST   /consult           — create multi-model consultation {query, context?, models, candidates?}',
  'POST   /consult/:id/response — submit model response to consultation {model, chosen, reasoning?, confidence?}',
  'GET    /consult/:id       — check consultation status and aggregated results',
  'GET    /consult/pending?model= — list pending consultations for a model',
  'POST   /consult/auto-respond — batch respond to pending consultations {model, responses[]}',
  'GET    /ai/status         — local AI (MLX) status and capabilities',
  'POST   /ai/summarize      — summarize entries using local AI {ids?:[]}',
  'GET    /search/semantic?q= — semantic similarity search (&limit=10&threshold=0.5)',
  'POST   /analytics/track   — track usage event {event_type, skill_name?, session?, metadata?}',
  'GET    /analytics/report?days= — usage analytics report (default 30 days)',
  'GET    /metrics/report?hours= — API performance metrics (default 24h)',
  'WS     /ws                — WebSocket real-time push notifications (upgrade)',
  'WS     /ws?key=<apikey>   — WebSocket with API key auth',
  'GET    /dashboard         — browser dashboard UI',
  'GET    /summaries?level=  — hierarchical chunk summaries (level=1 ?hours=N, level=2 ?days=N, level=3 ?weeks=N)',
  'POST   /admin/trigger-l2-summary — force-generate L2 daily summary {date?: "YYYY-MM-DD"}',
  'POST   /admin/trigger-l3-summary — force-generate L3 weekly summary {week?: "YYYY-Www"}',
  'POST   /admin/task-request       — submit an AIOS task queue job',
  'GET    /admin/task-queue         — snapshot of pending/running/recent task queue',
  'POST   /admin/integrity-check    — run integrity_check + quick_check {target?: "primary"|"backup"} (default: backup, rate-limited 1/h)',
  'POST   /admin/backup             — trigger a .backup() snapshot of primary → BACKUP_PATH (rate-limited 1/60s, in-flight guard)',
  'POST   /admin/wal-checkpoint     — run PRAGMA wal_checkpoint(mode) on primary {mode?: "PASSIVE"|"FULL"|"RESTART"|"TRUNCATE"} (default: TRUNCATE)',
  'POST   /admin/vacuum             — VACUUM primary (size-guarded, rate-limited 1/7d) {target?:"primary"|"backup",force?:bool}; deferred if DB>VCTX_VACUUM_MAX_BYTES (default 512MiB) unless force+VCTX_VACUUM_ALLOW_LARGE=1; backup target not yet implemented',
  'POST   /admin/auto-tune          — ensure critical indexes + ANALYZE {analyze?:bool,ensure_indexes?:bool,force?:bool} (rate-limited 1/h)',
  'POST   /admin/snapshot           — ramDb.backup() to ~/skills/data/snapshots/<label>-<ts>.db {label:string,include_wal?:bool,force?:bool} (rate-limited 1/10min/label, in-flight guard)',
  'GET    /admin/metrics/window     — aggregate api_metrics + entries stats ?hours=N&metric=all|api_metrics|entries|latency_*  (hours 1..720)',
  'POST   /admin/gc/dry-run         — report GC candidates (read-only) {embedding_prune_days?:N,include_types?:[...]}',
  'POST   /admin/policy-check       — run policy checks (secret-scan, tier-balance, policy-violations) {checks?:[...],window_hours?:N}',
];

const server = createServer(async (req, res) => {
  const method = req.method;
  const path = parsePath(req.url);

  // CORS (for any local tooling)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Vcontext-Admin');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // Public-but-sensitive endpoints require API key when server is
    // bound to a non-loopback interface (LAN exposure). Loopback callers
    // are trusted as before.
    const PUBLIC_OPEN = new Set(['/dashboard', '/auth/whoami']);
    const isLoopback = (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1');
    const bindHost = process.env.VCONTEXT_BIND || '127.0.0.1';
    if (bindHost !== '127.0.0.1' && !isLoopback && !PUBLIC_OPEN.has(path)) {
      const auth = validateApiKey(req);
      if (!auth.valid) return sendJson(res, 401, { error: 'API key required (LAN access)' });
    }
    // Route
    if (method === 'POST' && path === '/store') {
      // Pillar 3: trace store/recall/recent as the hot-path entry points.
      // Observability is bonus — if the tracer is noop, this is a zero-cost
      // function-call wrapper. Any error inside the handler is re-raised
      // so the outer try-catch (line ~5830) still sends a 500.
      await getTracer('vcontext').startActiveSpan('vcontext.store', async (span) => {
        try {
          span.setAttribute('vcontext.op', 'store');
          span.setAttribute('http.request.method', 'POST');
          span.setAttribute('http.route', '/store');
          await handleStore(req, res);
          span.setAttribute('http.response.status_code', res.statusCode || 0);
        } catch (e) { span.recordException(e); span.setStatus({ code: 2 }); throw e; }
        finally { span.end(); }
      });
    } else if (method === 'GET' && path === '/recall') {
      await getTracer('vcontext').startActiveSpan('vcontext.recall', async (span) => {
        try {
          span.setAttribute('vcontext.op', 'recall');
          span.setAttribute('http.request.method', 'GET');
          span.setAttribute('http.route', '/recall');
          await handleRecall(req, res);
          span.setAttribute('http.response.status_code', res.statusCode || 0);
        } catch (e) { span.recordException(e); span.setStatus({ code: 2 }); throw e; }
        finally { span.end(); }
      });
    } else if (method === 'GET' && path === '/recent') {
      getTracer('vcontext').startActiveSpan('vcontext.recent', (span) => {
        try {
          span.setAttribute('vcontext.op', 'recent');
          span.setAttribute('http.request.method', 'GET');
          span.setAttribute('http.route', '/recent');
          handleRecent(req, res);
          span.setAttribute('http.response.status_code', res.statusCode || 0);
        } catch (e) { span.recordException(e); span.setStatus({ code: 2 }); throw e; }
        finally { span.end(); }
      });
    } else if (method === 'GET' && path.startsWith('/session/')) {
      handleSession(req, res);
    } else if (method === 'POST' && path === '/summarize') {
      await handleSummarize(req, res);
    } else if (method === 'GET' && path === '/stats') {
      handleStats(req, res);
    } else if (method === 'DELETE' && path === '/prune') {
      handlePrune(req, res);
    } else if (method === 'GET' && path === '/health') {
      handleHealth(req, res);
    } else if (method === 'GET' && /^\/trace\/\d+$/.test(path)) {
      // Pillar 3 — Causal ancestry walk. Returns root-to-target chain
      // via parent_id pointers plus immediate children.
      handleTrace(req, res);
    } else if (method === 'GET' && path === '/export') {
      // Pillar 5 — Portable NDJSON dump (owner-only). Caller can save,
      // replay, or fork to another AIOS instance.
      handleExport(req, res);
    } else if (method === 'GET' && path === '/otel/status') {
      // Pillar 3 diagnostic: is tracing live, what Langfuse host, what service.
      sendJson(res, 200, otelStatus());
    } else if (method === 'GET' && path === '/feed') {
      handleFeed(req, res);
    } else if (method === 'POST' && path === '/federation/route') {
      // Routes a prompt to an AI tier based on declared task complexity.
      // Local MLX is "default"; if external_url + external_api_key is
      // provided in body, federates there for high-tier tasks.
      // Body: { prompt, tier?: 'haiku'|'sonnet'|'opus', maxTokens?, external? }
      const body = await readBody(req);
      const tier = body.tier || 'sonnet';
      try {
        // For now: all tiers go to local MLX (stub for future external).
        // Different temperature per tier as a stand-in for real model differentiation.
        const tempByTier = { haiku: 0.1, sonnet: 0.3, opus: 0.5 };
        const out = await mlxGenerate(body.prompt || '', {
          maxTokens: body.maxTokens || 40960,
          temperature: tempByTier[tier] ?? 0.3,
          caller: `federation:${tier}`,
        });
        sendJson(res, 200, { tier, used: 'mlx-local', content: out });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/vote') {
      // Consensus: same prompt, N samples (different seeds), majority wins.
      // Body: { prompt, samples?: 3 }
      const body = await readBody(req);
      const n = Math.max(2, Math.min(parseInt(body.samples, 10) || 3, 5));
      const responses = [];
      for (let i = 0; i < n; i++) {
        try {
          const r = await mlxGenerate(body.prompt || '', { maxTokens: 40960, temperature: 0.4, seed: 1000 + i, caller: 'vote' });
          responses.push(r.trim());
        } catch (e) { responses.push(`__error__: ${e.message}`); }
      }
      // Simple majority by exact-match
      const counts = {};
      for (const r of responses) counts[r] = (counts[r] || 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const winner = sorted[0];
      sendJson(res, 200, {
        samples: n,
        consensus: winner ? winner[0] : null,
        confidence: winner ? winner[1] / n : 0,
        all_responses: responses,
      });
    } else if (method === 'POST' && path === '/admin/multi-role-check') {
      // Runs 6 role-perspective checks in parallel and aggregates findings.
      // Each role asks different questions against the same live system
      // so no single blind spot hides a bug. Part of the AI OS's checker
      // discipline (not just a memory rule).
      const out = { roles: {}, findings: [], checked_at: new Date().toISOString() };
      const ramCount = (q) => { try { return ramDb.prepare(q).get(); } catch { return null; } };
      const ssdCount = (q) => { try { return ssdDb.prepare(q).get(); } catch { return null; } };

      // 1. QA
      const qa = {
        tool_errors_1h: ramCount(`SELECT COUNT(*) c FROM entries WHERE type='tool-error' AND created_at > datetime('now','-1 hour')`)?.c || 0,
        completion_violations_24h: ramCount(`SELECT COUNT(*) c FROM entries WHERE type='completion-violation' AND created_at > datetime('now','-1 day')`)?.c || 0,
        null_hash_rows: ramCount(`SELECT COUNT(*) c FROM entries WHERE content_hash IS NULL AND type NOT IN ('test','working-state','session-recall','anomaly-alert')`)?.c || 0,
      };
      if (qa.tool_errors_1h > 20) out.findings.push({ role: 'qa', msg: `tool-error spike: ${qa.tool_errors_1h}/1h` });
      if (qa.null_hash_rows > 500) out.findings.push({ role: 'qa', msg: `${qa.null_hash_rows} rows missing content_hash (dedup ineffective)` });
      out.roles.qa = qa;

      // 2. Architect
      const ramE = ramCount(`SELECT COUNT(*) c FROM entries`)?.c || 0;
      const ssdE = ssdCount(`SELECT COUNT(*) c FROM entries`)?.c || 0;
      const arch = { ram: ramE, ssd: ssdE, ram_pct: ramE + ssdE > 0 ? +(ramE / (ramE + ssdE) * 100).toFixed(1) : 0 };
      if (arch.ram_pct > 60) out.findings.push({ role: 'architect', msg: `tier imbalance: RAM ${arch.ram_pct}% (target <60%)` });
      out.roles.architect = arch;

      // 3. UX / dashboard clarity
      let dashOk = false;
      try {
        const tierStats = ramCount(`SELECT MIN(created_at) o FROM entries`);
        dashOk = /^20\d\d-\d\d-\d\d/.test(tierStats?.o || '');
      } catch {}
      out.roles.ux = { dashboard_dates_valid: dashOk };
      if (!dashOk) out.findings.push({ role: 'ux', msg: 'dashboard timestamps corrupted' });

      // 4. Security — secret patterns with WORD BOUNDARIES to avoid
      // matching path fragments like 'serene-keller' for 'sk-'.
      const sec = {
        api_key_perm: (() => { try { return require('node:fs').statSync(join(BACKUP_DIR, 'vcontext-api-keys.json')).mode & 0o777; } catch { return null; } })(),
        bind_host: process.env.VCONTEXT_BIND || '127.0.0.1',
        // GLOB with explicit prefix boundaries
        secret_pattern_hits: ramCount(`SELECT COUNT(*) c FROM entries WHERE created_at > datetime('now','-1 hour') AND (
          content GLOB '*[^a-zA-Z0-9-]sk-[A-Za-z0-9]*' OR
          content GLOB '*[^a-zA-Z0-9-]ghp_[A-Za-z0-9]*' OR
          content GLOB '*[^a-zA-Z0-9-]AKIA[A-Z0-9]*' OR
          content GLOB '*Bearer eyJ*'
        )`)?.c || 0,
      };
      if (sec.api_key_perm && sec.api_key_perm !== 0o600) out.findings.push({ role: 'security', msg: `api-key file perm ${sec.api_key_perm.toString(8)} (expected 600)` });
      if (sec.secret_pattern_hits > 0) out.findings.push({ role: 'security', msg: `${sec.secret_pattern_hits} entries with known-secret patterns` });
      out.roles.security = sec;

      // 5. Holistic — cross-subsystem consistency
      const ftsMatch = (ramCount(`SELECT COUNT(*) c FROM entries`)?.c || 0) === (ramCount(`SELECT COUNT(*) c FROM entries_fts`)?.c || 0);
      const holistic = { fts_in_sync: ftsMatch, queue_pending: (() => { try { return require('node:fs').readFileSync('/tmp/vcontext-queue.jsonl', 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } })() };
      if (!ftsMatch) out.findings.push({ role: 'holistic', msg: 'FTS out of sync with entries' });
      if (holistic.queue_pending > 100) out.findings.push({ role: 'holistic', msg: `queue backlog ${holistic.queue_pending}` });
      out.roles.holistic = holistic;

      // 6. Meta-checker — did other checks miss anything?
      const audit_recent = (() => {
        try {
          const r = spawnSync('sqlite3', [join(BACKUP_DIR, 'vcontext-audit.db'), `SELECT COUNT(*) FROM audit WHERE at > datetime('now','-1 hour')`], { encoding: 'utf-8' });
          return parseInt((r.stdout || '0').trim(), 10) || 0;
        } catch { return 0; }
      })();
      const meta = { audit_events_1h: audit_recent, checks_emitting_findings: new Set(out.findings.map(f => f.role)).size };
      if (audit_recent === 0) out.findings.push({ role: 'meta', msg: 'audit log silent 1h — maintenance may not be running' });
      out.roles.meta = meta;

      sendJson(res, 200, out);
    } else if (method === 'POST' && path === '/admin/mlx-test') {
      // Reproducibility / debug endpoint — calls mlxGenerate with a seed.
      const body = await readBody(req);
      try {
        const out = await mlxGenerate(body.prompt || '', { maxTokens: 40960, temperature: 0, seed: body.seed, caller: 'repro' });
        sendJson(res, 200, { content: out, seed: body.seed });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/metrics/cost') {
      // MLX token usage since server start. Local model so no $ cost,
      // but useful for capacity planning and per-feature attribution.
      // Also expose /tmp/aios-mlx-lock coordination stats so operators
      // can see how often the server yielded to an external holder.
      sendJson(res, 200, {
        ..._mlxUsage,
        mlx_file_lock: {
          skips: _mlxFileLockSkips,
          hold_ms_total: _mlxFileLockHoldMs,
          current_status: _fileMlxLockStatus(),
        },
      });
    } else if (method === 'POST' && path === '/admin/wipe-user') {
      // Compliance: delete all entries tagged user:<id>. Returns count.
      const body = await readBody(req);
      const userId = body.userId;
      if (!userId) return sendJson(res, 400, { error: 'userId required' });
      try {
        const stmt = ramDb.prepare(`DELETE FROM entries WHERE tags LIKE ?`);
        const r = stmt.run(`%user:${userId}%`);
        const ssdR = ssdDb ? ssdDb.prepare(`DELETE FROM entries WHERE tags LIKE ?`).run(`%user:${userId}%`) : { changes: 0 };
        sendJson(res, 200, { ram_deleted: r.changes, ssd_deleted: ssdR.changes, userId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/verify-backup') {
      // Comprehensive backup verification:
      // 1. ALL snapshots integrity_check
      // 2. Latest snapshot: entry count + sample read + schema check
      // 3. Size & age validation
      try {
        const SNAP_DIR = join(BACKUP_DIR, 'snapshots');
        const fs = require('node:fs');
        const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
        if (files.length === 0) return sendJson(res, 404, { error: 'no snapshots found' });

        const results = [];
        for (const f of files.slice(0, 10)) { // check last 10 snapshots
          const fullPath = join(SNAP_DIR, f);
          const stat = fs.statSync(fullPath);
          const ageHours = (Date.now() - stat.mtimeMs) / 1000 / 3600;
          let integrity = 'unknown', entryCount = 0, schemaOk = false;
          try {
            const probe = new Database(fullPath, { readonly: true });
            try {
              const ok = probe.prepare('PRAGMA integrity_check').get();
              integrity = ok.integrity_check === 'ok' ? 'ok' : ok.integrity_check;
              const cnt = probe.prepare('SELECT COUNT(*) as c FROM entries').get();
              entryCount = cnt.c;
              // Schema check — verify required tables exist
              const tables = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
              schemaOk = tables.includes('entries') && tables.includes('entries_fts');
            } finally { probe.close(); }
          } catch (e) { integrity = 'error: ' + e.message.slice(0, 50); }
          results.push({
            snapshot: f,
            size_mb: Math.round(stat.size / 1024 / 1024),
            age_hours: Math.round(ageHours * 10) / 10,
            integrity,
            entry_count: entryCount,
            schema_ok: schemaOk,
            status: (integrity === 'ok' && schemaOk) ? 'pass' : 'fail',
          });
        }

        const failed = results.filter(r => r.status === 'fail');
        const latest = results[0] || {};
        const alerts = [];
        if (failed.length > 0) alerts.push(`${failed.length} snapshot(s) failed verification`);
        if (latest.age_hours > 48) alerts.push(`Latest snapshot is ${latest.age_hours}h old (>48h threshold)`);
        if (latest.entry_count < 1000) alerts.push(`Latest snapshot has only ${latest.entry_count} entries (suspicious)`);

        sendJson(res, 200, {
          checked: results.length,
          passed: results.length - failed.length,
          failed: failed.length,
          integrity: failed.length === 0 ? 'ok' : 'fail',
          latest: latest.snapshot,
          alerts,
          snapshots: results,
          verified_at: new Date().toISOString(),
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/admin/pending-patches') {
      // List pending patches awaiting user approval
      try {
        const rows = dbQuery(`SELECT id, content, created_at FROM entries WHERE type='pending-patch' AND tags LIKE '%pending-patch%' ORDER BY id DESC LIMIT 50;`);
        const patches = rows.map(r => { try { return { id: r.id, created_at: r.created_at, ...JSON.parse(r.content) }; } catch { return { id: r.id }; } });
        sendJson(res, 200, { patches, count: patches.length });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/approve-patch') {
      // Apply patch → test → reload. Auto-rollback on failure.
      // CSRF defense: require custom header.  Simple cross-origin requests
      // can't set this without CORS preflight, defeating trivial CSRF
      // (a malicious browser page curl-bombing localhost:3150).
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required for destructive admin actions' });
      }
      const body = await readBody(req);
      const patchId = parseInt(body.id);
      if (!patchId) return sendJson(res, 400, { error: 'id required' });
      try {
        const rows = dbQuery(`SELECT content FROM entries WHERE id=${patchId} AND type='pending-patch';`);
        if (rows.length === 0) return sendJson(res, 404, { error: 'patch not found' });
        const data = JSON.parse(rows[0].content);
        const proposal = data.proposal || '';
        // Parse FILE/LINE/BEFORE/AFTER from proposal
        const fileMatch = proposal.match(/^FILE:\s*(.+)$/m);
        const beforeMatch = proposal.match(/^BEFORE:\s*(.+)$/m);
        const afterMatch = proposal.match(/^AFTER:\s*(.+)$/m);
        if (!fileMatch || !beforeMatch || !afterMatch) {
          return sendJson(res, 400, { error: 'patch format invalid' });
        }
        const fs = require('node:fs');
        const path = require('node:path');
        // Path validation — reject anything that tries to escape ~/skills
        // or contains shell metacharacters.  Before this, a pending-patch
        // entry with a crafted FILE: field (e.g. "foo.js; rm -rf ~/")
        // would reach execSync('node -c ${file}') and achieve arbitrary
        // command execution under the vcontext approve flow.
        const rawFile = fileMatch[1].trim();
        if (/[;&|<>`$(){}\[\]\\\*?!'"\n\r\t ]/.test(rawFile) || rawFile.includes('..')) {
          return sendJson(res, 400, { error: 'patch FILE contains invalid characters' });
        }
        const skillsRoot = path.join(process.env.HOME, 'skills');
        const file = path.resolve(skillsRoot, rawFile);
        if (!file.startsWith(skillsRoot + path.sep)) {
          return sendJson(res, 400, { error: 'patch FILE resolves outside ~/skills' });
        }
        const before = beforeMatch[1].trim();
        const after = afterMatch[1].trim();
        const original = fs.readFileSync(file, 'utf-8');
        if (!original.includes(before)) {
          dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'rejected-no-match'}))} WHERE id = ${patchId};`);
          return sendJson(res, 400, { error: 'BEFORE text not found in file', file });
        }
        // Create git branch, apply, test, reload
        execSync(`cd ~/skills && git checkout -b patch-${patchId} 2>/dev/null || git checkout patch-${patchId}`, { stdio: 'ignore' });
        const patched = original.replace(before, after);
        fs.writeFileSync(file, patched, 'utf-8');
        // Syntax test — execFileSync passes file as a separate arg so no
        // shell expansion even if path validation misses something.
        let testOk = false;
        try {
          execFileSync('node', ['-c', file], { stdio: 'ignore' });
          testOk = true;
        } catch { testOk = false; }
        if (!testOk) {
          fs.writeFileSync(file, original, 'utf-8');
          execSync(`cd ~/skills && git checkout main && git branch -D patch-${patchId}`, { stdio: 'ignore' });
          dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'rejected-test-failed'}))} WHERE id = ${patchId};`);
          return sendJson(res, 500, { error: 'syntax test failed, rolled back' });
        }
        // Commit, merge, reload
        execSync(`cd ~/skills && git add -A && git commit -m "self-improve: patch ${patchId} (user-approved)" && git checkout main && git merge patch-${patchId} && git branch -d patch-${patchId}`, { stdio: 'ignore' });
        execSync(`bash ~/skills/scripts/vcontext-reload.sh`, { stdio: 'ignore' });
        dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'applied', applied_at: new Date().toISOString()}))} WHERE id = ${patchId};`);
        sendJson(res, 200, { applied: true, patchId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/reject-patch') {
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      const body = await readBody(req);
      const patchId = parseInt(body.id);
      if (!patchId) return sendJson(res, 400, { error: 'id required' });
      try {
        const rows = dbQuery(`SELECT content FROM entries WHERE id=${patchId};`);
        if (rows.length === 0) return sendJson(res, 404, { error: 'not found' });
        const data = JSON.parse(rows[0].content);
        dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'rejected', rejected_at: new Date().toISOString()}))} WHERE id = ${patchId};`);
        sendJson(res, 200, { rejected: true, patchId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/adopt-idea') {
      // Idea adoption (from article-scanner's pending-idea entries):
      // Mark source pending-idea as status='adopted' and mirror the idea
      // into a new `adopted-idea` entry so dashboards can track what was
      // accepted without losing the original evaluation context.
      // Does NOT apply code changes — adoption just records intent;
      // humans still schedule the actual implementation.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      const body = await readBody(req);
      const ideaId = parseInt(body.id);
      if (!ideaId) return sendJson(res, 400, { error: 'id required' });
      try {
        const rows = dbQuery(`SELECT content, tags FROM entries WHERE id=${ideaId} AND type='pending-idea';`);
        if (rows.length === 0) return sendJson(res, 404, { error: 'pending-idea not found' });
        const data = JSON.parse(rows[0].content);
        const adoptedAt = new Date().toISOString();
        // Mark source as adopted (preserves original payload + history).
        dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'adopted', adopted_at: adoptedAt}))} WHERE id = ${ideaId};`);
        // Create a mirror adopted-idea entry for dashboard / analytics reach.
        const mirror = { original_idea_id: ideaId, adopted_at: adoptedAt, ...data };
        const tags = JSON.stringify(['adopted-idea', `source:${data.source || 'unknown'}`, `effort:${data.effort || 'M'}`]);
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES ('adopted-idea', ${esc(JSON.stringify(mirror))}, ${esc(tags)}, 'system', 0);`);
        sendJson(res, 200, { adopted: true, ideaId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/reject-idea') {
      // Symmetric to /admin/reject-patch but for pending-idea entries.
      // Dashboard "Today's Ideas" Dismiss button calls this.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      const body = await readBody(req);
      const ideaId = parseInt(body.id);
      if (!ideaId) return sendJson(res, 400, { error: 'id required' });
      try {
        const rows = dbQuery(`SELECT content FROM entries WHERE id=${ideaId} AND type='pending-idea';`);
        if (rows.length === 0) return sendJson(res, 404, { error: 'pending-idea not found' });
        const data = JSON.parse(rows[0].content);
        dbExec(`UPDATE entries SET content = ${esc(JSON.stringify({...data, status: 'rejected', rejected_at: new Date().toISOString()}))} WHERE id = ${ideaId};`);
        sendJson(res, 200, { rejected: true, ideaId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/replay-wal') {
      // Replay entries-wal.jsonl back into entries table (INSERT OR IGNORE).
      // Use after catastrophic DB loss if both RAM and SSD SQLite are gone
      // but the JSONL log survived. Non-destructive — duplicates are skipped.
      // CSRF-guarded because it does bulk DB writes.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      try {
        const fs = require('node:fs');
        if (!fs.existsSync(ENTRIES_WAL_PATH)) {
          return sendJson(res, 404, { error: 'no WAL file' });
        }
        const lines = fs.readFileSync(ENTRIES_WAL_PATH, 'utf8').split('\n').filter(Boolean);
        let inserted = 0, skipped = 0, failed = 0;
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            const tagsJson = JSON.stringify(e.tags || []);
            const tokenEst = estimateTokens(e.content || '');
            // INSERT OR IGNORE preserves any existing row
            const before = dbQuery('SELECT COUNT(*) as c FROM entries WHERE id = ' + Number(e.id))[0]?.c || 0;
            dbExec(`INSERT OR IGNORE INTO entries (id, type, content, tags, session, created_at, token_estimate, last_accessed, access_count, tier, reasoning, conditions, supersedes, confidence, status, content_hash) VALUES (${Number(e.id)}, ${esc(e.type)}, ${esc(e.content)}, ${esc(tagsJson)}, ${esc(e.session)}, ${esc(e.created_at)}, ${tokenEst}, ${esc(e.created_at)}, 0, 'ram', ${esc(e.reasoning)}, ${esc(e.conditions)}, ${e.supersedes == null ? 'NULL' : Number(e.supersedes)}, ${esc(e.confidence || 'medium')}, ${esc(e.status || 'active')}, ${esc(e.content_hash)});`);
            const after = dbQuery('SELECT COUNT(*) as c FROM entries WHERE id = ' + Number(e.id))[0]?.c || 0;
            if (after > before) inserted++; else skipped++;
          } catch { failed++; }
        }
        sendJson(res, 200, { total: lines.length, inserted, skipped, failed, wal_path: ENTRIES_WAL_PATH });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/admin/wal-status') {
      // Check size and line count of the append-only WAL
      try {
        const fs = require('node:fs');
        if (!fs.existsSync(ENTRIES_WAL_PATH)) {
          return sendJson(res, 200, { exists: false, path: ENTRIES_WAL_PATH });
        }
        const st = fs.statSync(ENTRIES_WAL_PATH);
        const content = fs.readFileSync(ENTRIES_WAL_PATH, 'utf8');
        const lines = content.split('\n').filter(Boolean).length;
        sendJson(res, 200, {
          exists: true,
          path: ENTRIES_WAL_PATH,
          size_bytes: st.size,
          size_mb: Math.round(st.size / 1024 / 1024 * 10) / 10,
          lines,
          modified: new Date(st.mtimeMs).toISOString(),
          rotate_threshold_mb: ENTRIES_WAL_MAX_BYTES / 1024 / 1024
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/admin/ramdisk-stats') {
      // RAM disk capacity / usage — surfaces the 2026-04-18 death-spiral
      // root cause (98% fill → WAL write fail → DB corruption loop) as a
      // proactive dashboard metric. Thresholds mirror vcontext-watchdog.sh:
      // 80% warn, 95% critical.
      // 2026-04-18 (post RAM→SSD migration): when no RAM disk is mounted
      // (SSD-only mode), return status='disabled' so the dashboard can
      // render the card as "N/A" instead of a red error.
      try {
        const mountPoint = '/Volumes/VContext';
        if (!existsSync(mountPoint)) {
          sendJson(res, 200, {
            mount: mountPoint,
            enabled: false,
            status: 'disabled',
            reason: 'ramdisk not mounted (SSD-only mode)',
          });
          return;
        }
        // `df -k` output: Filesystem 1K-blocks Used Avail Capacity ...
        const df = execFileSync('/bin/df', ['-k', mountPoint], { encoding: 'utf-8' });
        const lines = df.trim().split('\n');
        if (lines.length < 2) throw new Error('unexpected df output');
        // Fields: fs, total, used, avail, capacity, ...
        const parts = lines[1].trim().split(/\s+/);
        const totalKB = parseInt(parts[1]);
        const usedKB = parseInt(parts[2]);
        const availKB = parseInt(parts[3]);
        const capacity = parts[4]; // "98%"
        const pctNum = parseInt(capacity);
        let status = 'ok';
        if (pctNum >= 95) status = 'critical';
        else if (pctNum >= 80) status = 'warn';
        sendJson(res, 200, {
          mount: mountPoint,
          total_gb: Math.round(totalKB / 1024 / 1024 * 100) / 100,
          used_gb: Math.round(usedKB / 1024 / 1024 * 100) / 100,
          avail_gb: Math.round(availKB / 1024 / 1024 * 100) / 100,
          used_pct: pctNum,
          status,
          thresholds: { warn_pct: 80, critical_pct: 95 },
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/admin/health-report') {
      // Human-readable daily/weekly brief — formatted string + structured data.
      // ?days=1 for yesterday, ?days=7 for weekly. Used by vcontext-morning-brief.sh.
      try {
        const q = parseQuery(req.url);
        const days = Math.max(1, Math.min(30, parseInt(q.days) || 1));
        const hours = days * 24;
        const since = `datetime('now', '-${days} days')`;

        const events = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE created_at > ${since};`)[0]?.c || 0;
        const sessions = dbQuery(`SELECT COUNT(DISTINCT session) as c FROM entries WHERE created_at > ${since};`)[0]?.c || 0;
        const errors = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='tool-error' AND created_at > ${since};`)[0]?.c || 0;
        const skills = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-usage' AND created_at > ${since};`)[0]?.c || 0;
        const decisions = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='decision' AND created_at > ${since};`)[0]?.c || 0;
        const topTools = dbQuery(`SELECT tool_name, COUNT(*) as cnt FROM entry_index WHERE tool_name IS NOT NULL AND created_at > ${since} GROUP BY tool_name ORDER BY cnt DESC LIMIT 5;`);
        const slowestOps = dbQuery(`SELECT operation, ROUND(AVG(latency_ms),0) as ms, COUNT(*) as n FROM api_metrics WHERE created_at > ${since} GROUP BY operation ORDER BY ms DESC LIMIT 3;`);
        const anomalies = dbQuery(`SELECT content FROM entries WHERE type='anomaly-alert' AND created_at > ${since} ORDER BY id DESC LIMIT 5;`);
        const patchesQ = dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='pending-patch' AND created_at > ${since};`)[0]?.c || 0;

        const label = days === 1 ? 'Daily' : (days === 7 ? 'Weekly' : `${days}-day`);
        let brief = `vcontext ${label} Brief (last ${days}d)\n`;
        brief += `━━━━━━━━━━━━━━━━━━━━━\n`;
        brief += `Events:    ${events.toLocaleString()}  (${Math.round(events/hours)}/h)\n`;
        brief += `Sessions:  ${sessions}\n`;
        brief += `Skills:    ${skills} uses\n`;
        brief += `Decisions: ${decisions}\n`;
        brief += `Errors:    ${errors}${errors > 50 ? ' ⚠️' : ''}\n`;
        if (patchesQ > 0) brief += `Proposals: ${patchesQ} pending\n`;
        if (topTools.length > 0) {
          brief += `\nTop tools: ` + topTools.map(t => `${t.tool_name}×${t.cnt}`).join(', ') + `\n`;
        }
        if (slowestOps.length > 0) {
          brief += `Slowest:   ` + slowestOps.map(s => `${s.operation}=${s.ms}ms`).join(', ') + `\n`;
        }
        if (anomalies.length > 0) {
          brief += `\nAnomalies (${anomalies.length}):\n`;
          for (const a of anomalies.slice(0, 3)) {
            try {
              const ad = JSON.parse(a.content);
              if (ad.alerts) {
                for (const alert of ad.alerts.slice(0, 1)) brief += `  • ${alert.msg}\n`;
              }
            } catch {}
          }
        }
        sendJson(res, 200, {
          period_days: days, brief,
          stats: { events, sessions, errors, skills, decisions, patches: patchesQ },
          top_tools: topTools, slowest_ops: slowestOps
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/rollback-last') {
      // Rollback last self-improve commit (git reset + reload).
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      try {
        execSync(`cd ~/skills && git log --oneline -1 | grep -q 'self-improve'`, { stdio: 'ignore' });
        execSync(`cd ~/skills && git reset --hard HEAD~1`, { stdio: 'ignore' });
        execSync(`bash ~/skills/scripts/vcontext-reload.sh`, { stdio: 'ignore' });
        sendJson(res, 200, { rolled_back: true });
      } catch (e) { sendJson(res, 500, { error: e.message || 'no self-improve commit to rollback' }); }
    } else if (method === 'POST' && path === '/admin/restart-aios') {
      // Soft restart — send SIGHUP to the wrapper, which kills the current
      // server and starts a fresh one (sub-5s downtime). LaunchAgent stays
      // loaded, so a crash at any point still auto-recovers.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      try {
        // PID_FILE is set by wrapper; fall back to parent-pid if missing.
        const fs = require('node:fs');
        let wrapperPid = null;
        try { wrapperPid = parseInt(fs.readFileSync('/tmp/vcontext-wrapper.lock', 'utf-8').trim()) || null; } catch {}
        if (!wrapperPid) {
          // No lock file → server was started outside the wrapper; nothing to SIGHUP.
          return sendJson(res, 503, { error: 'wrapper lock not found — cannot restart via SIGHUP' });
        }
        sendJson(res, 200, { restarting: true, wrapper_pid: wrapperPid });
        // Defer so the response flushes before the server exits.
        setTimeout(() => { try { process.kill(wrapperPid, 'SIGHUP'); } catch (e) { console.error('[admin/restart-aios]', e.message); } }, 100);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/stop-aios') {
      // Hard stop — disables the launchd agent persistently, then exits.
      // Uses `launchctl disable` instead of `bootout` for two reasons:
      //   1. `disable` writes persistent state (survives reboot) with clear
      //      semantics "user explicitly stopped this".
      //   2. `bootout` has observed cross-reboot edge cases where the
      //      service failed to reload on next boot (seen 2026-04-18:
      //      `launchctl list` missing com.vcontext.server after bootout+
      //      reboot even though plist was valid).
      // The watchdog self-heal (vcontext-watchdog.sh) honors `disable`
      // state — it will NOT auto-restart us until the user re-enables.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, { error: 'X-Vcontext-Admin: yes header required' });
      }
      const body = await readBody(req).catch(() => ({}));
      // Require an explicit confirm token to prevent a drive-by click from
      // killing the service. Dashboard sends {"confirm":"yes"}.
      if (body?.confirm !== 'yes') {
        return sendJson(res, 400, { error: 'confirm:"yes" required in body' });
      }
      try {
        const uid = process.getuid();
        const svc = `gui/${uid}/com.vcontext.server`;
        const restartCmd = `launchctl enable ${svc} && launchctl kickstart ${svc}`;
        sendJson(res, 200, {
          stopped: true,
          restart_cmd: restartCmd,
          note: 'Run the restart_cmd in a terminal to bring vcontext back up. The watchdog will not auto-restart while disabled.',
        });
        // Deferred shutdown so the response reaches the client.
        setTimeout(() => {
          try {
            // Step 1: persistent disable — watchdog and next boot both respect this.
            execSync(`launchctl disable ${svc}`, { stdio: 'ignore', timeout: 5000 });
          } catch (e) { console.error('[admin/stop-aios] disable failed:', e.message); }
          try {
            // Step 2: kill the current process group so wrapper + server both die.
            // KeepAlive=true on the agent would re-spawn, but disable above
            // overrides that. Use kickstart-kill to target the launchd service.
            execSync(`launchctl kill SIGKILL ${svc}`, { stdio: 'ignore', timeout: 5000 });
          } catch {}
          console.log('[admin/stop-aios] launchctl disable + kill issued; exiting process.');
          process.exit(0);
        }, 300);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/analytics/weekly-summary') {
      // Weekly summary: what did the user/AI actually do?
      // Cached for 30s per `days` value. Each call runs 10 DB aggregations
      // over the full entries table; dashboard fires this on every refresh.
      // The data is backward-looking so a 30s lag is fine.
      try {
        const days = parseInt(parseQuery(req.url).days) || 7;
        const cacheKey = `weekly:${days}`;
        _analyticsCache = _analyticsCache || {};
        const cached = _analyticsCache[cacheKey];
        if (cached && (Date.now() - cached.at) < 30_000) {
          return sendJson(res, 200, cached.data);
        }
        const since = `datetime('now', '-${days} days')`;
        const stats = {
          period_days: days,
          total_events: dbQuery(`SELECT COUNT(*) as c FROM entries WHERE created_at > ${since};`)[0]?.c || 0,
          sessions: dbQuery(`SELECT COUNT(DISTINCT session) as c FROM entries WHERE created_at > ${since};`)[0]?.c || 0,
          projects: dbQuery(`SELECT COUNT(DISTINCT namespace) as c FROM entries WHERE tags LIKE '%project:%' AND created_at > ${since};`)[0]?.c || 0,
          by_type: dbQuery(`SELECT type, COUNT(*) as cnt FROM entries WHERE created_at > ${since} GROUP BY type ORDER BY cnt DESC LIMIT 10;`),
          top_tools: dbQuery(`SELECT tool_name, COUNT(*) as cnt FROM entry_index WHERE tool_name IS NOT NULL AND created_at > ${since} GROUP BY tool_name ORDER BY cnt DESC LIMIT 10;`),
          top_sessions: dbQuery(`SELECT session, COUNT(*) as cnt FROM entries WHERE created_at > ${since} AND session != 'system' GROUP BY session ORDER BY cnt DESC LIMIT 5;`),
          skills_used: dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-usage' AND created_at > ${since};`)[0]?.c || 0,
          skills_created: dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='skill-created' AND created_at > ${since};`)[0]?.c || 0,
          errors: dbQuery(`SELECT COUNT(*) as c FROM entries WHERE type='tool-error' AND created_at > ${since};`)[0]?.c || 0,
          decisions: dbQuery(`SELECT substr(content,1,120) as c FROM entries WHERE type='decision' AND created_at > ${since} ORDER BY id DESC LIMIT 10;`),
          _cached: false,
        };
        _analyticsCache[cacheKey] = { at: Date.now(), data: { ...stats, _cached: true } };
        sendJson(res, 200, stats);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/analytics/skill-effectiveness') {
      // Skill effectiveness: which skills actually lead to outcomes?
      // We aggregate in JS instead of SQL json_each — SQLite's optimizer
      // pushes json_each above the type filter in multiple plan shapes
      // (CTE, MATERIALIZED, inner subquery) and any non-array content
      // throws "malformed JSON" that floods the log. Pure JS is correct
      // and within ~10ms for 500 rows.
      try {
        const usage = dbQuery(`SELECT content, created_at FROM entries WHERE type='skill-usage' ORDER BY id DESC LIMIT 2000;`);
        const counts = {};
        for (const row of usage) {
          try {
            const data = JSON.parse(row.content);
            const names = Array.isArray(data.skills) ? data.skills : [];
            for (const name of names) {
              if (typeof name !== 'string') continue;
              if (!counts[name]) counts[name] = { skill_name: name, usage_count: 0, last_used: row.created_at };
              counts[name].usage_count++;
              if (row.created_at > counts[name].last_used) counts[name].last_used = row.created_at;
            }
          } catch {}
        }
        const skills = Object.values(counts).sort((a, b) => b.usage_count - a.usage_count).slice(0, 30);
        sendJson(res, 200, { skills, count: skills.length });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/pipeline/health') {
      // Per-feature heartbeat derived from entry recency — in a loosely
      // coupled AI OS, silent degradation is the biggest risk. This
      // endpoint lets the dashboard surface each pipeline's last
      // successful run alongside green/yellow/red thresholds.
      // Thresholds reflect each feature's INTENDED cadence:
      //  - Hook-driven (working-state, skill-usage, handoff): should fire
      //    every few minutes during active work
      //  - Scheduler-driven (predict 30m, discovery 5m with 24h dedup per
      //    topic, suggestion 30m): tens of minutes to hours
      //  - Condition-driven (completion-violation): no cadence — only
      //    fires when a completion is claimed; never = OK
      const features = [
        { key: 'predictive-search',  label: 'Predictive search',   type: 'predictive-search',   yellowMin: 60,    redMin: 360,  condition: false },
        { key: 'skill-discovery',    label: 'Skill discovery',     type: 'skill-discovery',     yellowMin: 1500,  redMin: 2880, condition: false }, // 24h topic cooldown
        { key: 'skill-suggestion',   label: 'Skill suggestion',    type: 'skill-suggestion',    yellowMin: 120,   redMin: 720,  condition: false },
        { key: 'skill-created',      label: 'Auto-create skill',   type: 'skill-created',       yellowMin: 360,   redMin: 1440, condition: false },
        { key: 'anomaly-alert',      label: 'Anomaly detection',   type: 'anomaly-alert',       yellowMin: null,  redMin: null, condition: true  }, // only fires when anomaly exists — silence = healthy
        { key: 'completion-violation', label: 'Completion check',  type: 'completion-violation',yellowMin: null,  redMin: null, condition: true  },
        { key: 'skill-usage',        label: 'Skill routing',       type: 'skill-usage',         yellowMin: 30,    redMin: 180,  condition: false },
        { key: 'working-state',      label: 'Per-turn snapshot',   type: 'working-state',       yellowMin: 10,    redMin: 60,   condition: false },
        { key: 'handoff',            label: 'Session handoff',     type: 'handoff',             yellowMin: 120,   redMin: 1440, condition: false },
        { key: 'session-recall',     label: 'Session recall',      type: 'session-recall',      yellowMin: null,  redMin: null, condition: true  }, // fires on session start — silence = no new session
      ];
      const now = Date.now();
      const features_out = features.map(f => {
        const row = dbQuery(
          `SELECT MAX(created_at) as last, COUNT(*) as total, SUM(CASE WHEN created_at > datetime('now','-24 hours') THEN 1 ELSE 0 END) as today FROM entries WHERE type = ${esc(f.type)};`
        );
        const last = row[0]?.last || null;
        const total = row[0]?.total || 0;
        const today = row[0]?.today || 0;
        let ageMin = null;
        if (last) {
          // SQLite returns 'YYYY-MM-DD HH:MM:SS' (UTC). Parse as UTC.
          ageMin = Math.floor((now - Date.parse(last.replace(' ', 'T') + 'Z')) / 60000);
        }
        let status = 'green';
        if (f.condition) {
          // Condition-driven features are idle by default; only flag
          // when there's been specific activity that aged out.
          status = 'idle';
        } else if (ageMin == null || ageMin > f.redMin) {
          status = 'red';
        } else if (ageMin > f.yellowMin) {
          status = 'yellow';
        }
        return { key: f.key, label: f.label, last, age_min: ageMin, total, today, status, condition: !!f.condition };
      });
      const summary = {
        green:  features_out.filter(f => f.status === 'green').length,
        yellow: features_out.filter(f => f.status === 'yellow').length,
        red:    features_out.filter(f => f.status === 'red').length,
        idle:   features_out.filter(f => f.status === 'idle').length,
      };
      // Loop heartbeats — distinguishes "loop alive but idle" from
      // "loop stuck / dead".  Feature-recency above tells us the
      // EFFECTS of the loop; heartbeat tells us the LOOP ITSELF.
      const loops = {
        embed: {
          running: embedLoopRunning,
          last_tick_ms_ago: _loopHeartbeat.embed ? Date.now() - _loopHeartbeat.embed : null,
          iterations: _loopHeartbeat.embed_iter,
          status: !embedLoopRunning ? 'stopped'
            : _loopHeartbeat.embed && (Date.now() - _loopHeartbeat.embed) < 120_000 ? 'green'
            : _loopHeartbeat.embed && (Date.now() - _loopHeartbeat.embed) < 600_000 ? 'yellow'
            : 'red',
        },
        discovery: {
          running: discoveryLoopRunning,
          last_tick_ms_ago: _loopHeartbeat.discovery ? Date.now() - _loopHeartbeat.discovery : null,
          iterations: _loopHeartbeat.discovery_iter,
          status: !discoveryLoopRunning ? 'stopped'
            : _loopHeartbeat.discovery && (Date.now() - _loopHeartbeat.discovery) < 600_000 ? 'green'
            : _loopHeartbeat.discovery && (Date.now() - _loopHeartbeat.discovery) < 3600_000 ? 'yellow'
            : 'red',
        },
        chunk_summary: {
          running: chunkSummaryLoopRunning,
          last_tick_ms_ago: _loopHeartbeat.chunk_summary ? Date.now() - _loopHeartbeat.chunk_summary : null,
          iterations: _loopHeartbeat.chunk_summary_iter,
          // 5-min cadence → 600s yellow / 1800s red matches loop pacing.
          status: !chunkSummaryLoopRunning ? 'stopped'
            : _loopHeartbeat.chunk_summary && (Date.now() - _loopHeartbeat.chunk_summary) < 600_000 ? 'green'
            : _loopHeartbeat.chunk_summary && (Date.now() - _loopHeartbeat.chunk_summary) < 1800_000 ? 'yellow'
            : 'red',
        },
        chunk_summary_l2: {
          running: chunkSummaryL2LoopRunning,
          last_tick_ms_ago: _loopHeartbeat.chunk_summary_l2 ? Date.now() - _loopHeartbeat.chunk_summary_l2 : null,
          iterations: _loopHeartbeat.chunk_summary_l2_iter,
          // 30-min cadence → 3600s yellow / 10800s red.
          status: !chunkSummaryL2LoopRunning ? 'stopped'
            : _loopHeartbeat.chunk_summary_l2 && (Date.now() - _loopHeartbeat.chunk_summary_l2) < 3600_000 ? 'green'
            : _loopHeartbeat.chunk_summary_l2 && (Date.now() - _loopHeartbeat.chunk_summary_l2) < 10800_000 ? 'yellow'
            : 'red',
        },
        chunk_summary_l3: {
          running: chunkSummaryL3LoopRunning,
          last_tick_ms_ago: _loopHeartbeat.chunk_summary_l3 ? Date.now() - _loopHeartbeat.chunk_summary_l3 : null,
          iterations: _loopHeartbeat.chunk_summary_l3_iter,
          // 60-min cadence → 7200s yellow / 21600s red.
          status: !chunkSummaryL3LoopRunning ? 'stopped'
            : _loopHeartbeat.chunk_summary_l3 && (Date.now() - _loopHeartbeat.chunk_summary_l3) < 7200_000 ? 'green'
            : _loopHeartbeat.chunk_summary_l3 && (Date.now() - _loopHeartbeat.chunk_summary_l3) < 21600_000 ? 'yellow'
            : 'red',
        },
      };
      sendJson(res, 200, { summary, features: features_out, loops });
    } else if (method === 'POST' && path === '/admin/task-request') {
      // AIOS Task Queue — submit long-running work that survives Claude Code
      // crashes. Stores a type='task-request' entry; aios-task-runner.js
      // (independent LaunchAgent) polls and dispatches. Result lands back as
      // type='task-result' so the next Claude Code session can /recall it.
      try {
        const body = await readBody(req);
        const ALLOWED_TASK_TYPES = new Set([
          'locomo-eval',
          'skill-discovery-adhoc',
          'article-scan-adhoc',
          'self-evolve-dryrun',
          'shell-command',
        ]);
        const task_type = typeof body.task_type === 'string' ? body.task_type : '';
        if (!ALLOWED_TASK_TYPES.has(task_type)) {
          return sendJson(res, 400, { error: `Unknown task_type. Allowed: ${[...ALLOWED_TASK_TYPES].join(', ')}` });
        }
        const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};
        // shell-command RCE guard — admin header + explicit user-approval marker.
        // Defense-in-depth: header (CSRF/DNS-rebind) + approved_by_user (intent).
        // Non-shell task types (locomo-eval, skill-discovery-adhoc, etc.) are
        // intentionally exempt from the header check to preserve adhoc dispatch.
        // See docs/spec/2026-04-18-task-request-admin-header.md.
        if (task_type === 'shell-command') {
          if (req.headers['x-vcontext-admin'] !== 'yes') {
            return sendJson(res, 403, {
              error: 'shell-command requires X-Vcontext-Admin: yes header',
              docs: 'docs/policy/autonomous-commit-gate.md §0',
            });
          }
          if (payload.approved_by_user !== true) {
            return sendJson(res, 403, { error: 'shell-command task requires payload.approved_by_user === true' });
          }
        }
        const priority = [1, 2, 3].includes(body.priority) ? body.priority : 2;
        const requested_by = typeof body.requested_by === 'string' ? body.requested_by.slice(0, 120) : 'unknown';
        const request_id = require('node:crypto').randomUUID();
        const created_at = new Date().toISOString();
        const taskEntry = {
          request_id,
          task_type,
          payload,
          priority,
          requested_by,
          status: 'pending',
          created_at,
        };
        const tags = JSON.stringify(['task-queue', `task-type:${task_type}`, `priority:${priority}`, `request:${request_id}`]);
        dbExec(`INSERT INTO entries (type, content, tags, session, token_estimate) VALUES ('task-request', ${esc(JSON.stringify(taskEntry))}, ${esc(tags)}, 'task-queue', 0);`);
        // queue_position = count of pending task-request entries (minus terminal ones)
        let queue_position = 1;
        try {
          const pendingCount = dbQuery(
            `SELECT COUNT(*) as c FROM entries WHERE type='task-request' AND tags LIKE '%task-queue%';`
          )[0]?.c || 1;
          queue_position = pendingCount;
        } catch {}
        sendJson(res, 200, { request_id, status: 'pending', queue_position, created_at });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/admin/task-queue') {
      // Snapshot of the task queue for dashboard + runner polling.
      // Derives pending/running/completed from type='task-request',
      // type='task-status-update', type='task-result' entries.
      try {
        const LIMIT = 20;
        // Pull the last ~200 task-request entries (newest first) and join in
        // status-updates + results via request_id. Keep lists bounded at LIMIT.
        const requestRows = dbQuery(
          `SELECT id, content, created_at FROM entries WHERE type='task-request' ORDER BY id DESC LIMIT 200;`
        );
        const statusRows = dbQuery(
          `SELECT id, content, created_at FROM entries WHERE type='task-status-update' ORDER BY id DESC LIMIT 400;`
        );
        const resultRows = dbQuery(
          `SELECT id, content, created_at FROM entries WHERE type='task-result' ORDER BY id DESC LIMIT 200;`
        );
        const statusByReq = new Map();
        for (const r of statusRows) {
          try {
            const d = JSON.parse(r.content || '{}');
            if (!d.request_id) continue;
            if (!statusByReq.has(d.request_id)) statusByReq.set(d.request_id, []);
            statusByReq.get(d.request_id).push({ ...d, entry_id: r.id, created_at: r.created_at });
          } catch {}
        }
        const resultByReq = new Map();
        for (const r of resultRows) {
          try {
            const d = JSON.parse(r.content || '{}');
            if (!d.request_id) continue;
            if (!resultByReq.has(d.request_id)) {
              resultByReq.set(d.request_id, { ...d, entry_id: r.id, created_at: r.created_at });
            }
          } catch {}
        }
        const pending = [];
        const running = [];
        const recent_results = [];
        for (const r of requestRows) {
          let req;
          try { req = JSON.parse(r.content || '{}'); } catch { continue; }
          const reqId = req.request_id;
          if (!reqId) continue;
          const result = resultByReq.get(reqId);
          if (result) {
            if (recent_results.length < LIMIT) {
              recent_results.push({
                request_id: reqId,
                task_type: req.task_type,
                status: result.status || 'completed',
                duration_ms: result.duration_ms || null,
                completed_at: result.completed_at || result.created_at,
                created_at: r.created_at,
                entry_id: r.id,
                error: result.error || null,
              });
            }
            continue;
          }
          const updates = statusByReq.get(reqId) || [];
          const latest = updates[0];
          if (latest && latest.status === 'running') {
            if (running.length < LIMIT) {
              running.push({
                request_id: reqId,
                task_type: req.task_type,
                started_at: latest.started_at || latest.created_at,
                created_at: r.created_at,
                entry_id: r.id,
              });
            }
            continue;
          }
          // No result, no running-update → still pending.
          if (pending.length < LIMIT) {
            pending.push({
              request_id: reqId,
              task_type: req.task_type,
              priority: req.priority || 2,
              requested_by: req.requested_by || 'unknown',
              payload: req.payload || {},
              created_at: r.created_at,
              entry_id: r.id,
            });
          }
        }
        // Sort pending by priority asc (1 = highest), then by created_at asc (FIFO).
        pending.sort((a, b) => (a.priority - b.priority) || (a.created_at || '').localeCompare(b.created_at || ''));
        sendJson(res, 200, { pending, running, recent_results });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/trigger-l2-summary') {
      // Manually generate an L2 (daily) summary for a given UTC date.
      // Body: {date: "YYYY-MM-DD"}.  Omit date → default to yesterday.
      // Fire-and-forget so a slow MLX gen can't stall the HTTP loop.
      try {
        const body = await readBody(req);
        const dayId = body.date || dayIdFor(Date.now() - 24 * 3600 * 1000);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayId)) {
          return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
        }
        if (!mlxGenerateAvailable) return sendJson(res, 503, { error: 'MLX generate unavailable' });
        sendJson(res, 202, { status: 'triggered', chunk_id: dayId, level: 2 });
        setImmediate(async () => {
          try { const r = await runOneChunkSummaryL2(dayId);
            console.log(`[admin:trigger-l2] ${dayId}: ${JSON.stringify(r)}`);
          } catch (e) { console.error(`[admin:trigger-l2] ${dayId}: ${e.message}`); }
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/trigger-l3-summary') {
      // Manually generate an L3 (weekly) summary for a given ISO week.
      // Body: {week: "YYYY-Www"}.  Omit → default to last week.
      try {
        const body = await readBody(req);
        const weekId = body.week || weekIdFor(Date.now() - 7 * 24 * 3600 * 1000);
        if (!/^\d{4}-W\d{2}$/.test(weekId)) {
          return sendJson(res, 400, { error: 'week must be YYYY-Www (e.g. 2026-W16)' });
        }
        if (!mlxGenerateAvailable) return sendJson(res, 503, { error: 'MLX generate unavailable' });
        sendJson(res, 202, { status: 'triggered', chunk_id: weekId, level: 3 });
        setImmediate(async () => {
          try { const r = await runOneChunkSummaryL3(weekId);
            console.log(`[admin:trigger-l3] ${weekId}: ${JSON.stringify(r)}`);
          } catch (e) { console.error(`[admin:trigger-l3] ${weekId}: ${e.message}`); }
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'POST' && path === '/admin/run-all') {
      // Manually fire the AI-driven loops whose scheduler has gone quiet.
      // MLX uses a single serialized lock — run tasks SEQUENTIALLY so
      // they don't starve each other with 503 busy responses.
      sendJson(res, 202, { status: 'triggered' });
      setImmediate(async () => {
        const results = {};
        const safeRun = async (name, fn) => {
          const t0 = Date.now();
          try { await fn(); results[name] = `ok in ${Date.now()-t0}ms`; }
          catch (e) { results[name] = `err: ${e.message}`; }
        };
        await safeRun('discovery', () => runOneDiscovery());
        await safeRun('prediction', () => runOnePrediction());
        await safeRun('auto-create-skill', () => autoCreateSkill());
        console.log(`[vcontext:admin] run-all: ${JSON.stringify(results)}`);
      });
    } else if (method === 'POST' && path === '/admin/fts-rebuild') {
      // Rebuild the FTS5 index (recovers DELETE triggers after corruption).
      try {
        ramDb.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
        sendJson(res, 200, { status: 'rebuilt' });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/backup') {
      // Stage 3 of loose-coupling redesign. Replaces scripts/vcontext-
      // backup.sh's sqlite3-CLI `.backup` invocation — that external
      // process held a read-snapshot on primary.sqlite for 1-2 minutes,
      // and when it hung (observed 2026-04-20 for 1h 59m), blocked the
      // live WAL from checkpointing → 3 GB WAL bloat + server stalls.
      //
      // Server-owned backup uses `ramDb.backup(tmpPath)` (better-sqlite3
      // online backup API) — same connection as the server, so no
      // cross-process lock contention. Atomic rename + integrity-gate
      // the .bak rotation (same safety invariants as legacy doBackup).
      //
      // Auth: admin-tier. Body: {} reserved for future options.
      // Returns: { status: ok|fail|skipped, backup_path, size_bytes,
      //            integrity, duration_ms, ran_at, cached?, reason? }
      //
      // Rate-limit: 1/60s. backup.sh LaunchAgent fires every 15 min
      // anyway; the rate-limit stops accidental hammering.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        await readBody(req);
        const now = Date.now();
        const THROTTLE_MS = 60 * 1000; // 60s

        // 2026-04-20 Stage 3 agile fix: in-flight guard.
        // If a backup is already running, return 429 so callers don't
        // stack multiple concurrent ramDb.backup() invocations (each
        // copies 6 GB and the parallel IO saturates CPU for minutes).
        // Observed in testing: 2 concurrent calls made server 100% CPU
        // for 4+ minutes with /stats /recall timing out.
        if (globalThis._backupInFlight) {
          return sendJson(res, 429, {
            status: 'busy',
            reason: 'backup_already_running',
            hint: 'wait for the current backup to complete before retrying',
          });
        }

        if (!globalThis._backupCache) globalThis._backupCache = null;
        const cached = globalThis._backupCache;
        if (cached && now - cached.ran_at_ms < THROTTLE_MS) {
          return sendJson(res, 200, {
            ...cached.result,
            cached: true,
            next_in_seconds: Math.ceil((THROTTLE_MS - (now - cached.ran_at_ms)) / 1000),
          });
        }
        if (!existsSync(DB_PATH) || !ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'primary_db_unavailable' });
        }

        // try/finally wraps the whole backup block so the in-flight flag
        // is ALWAYS released — any early return (500 / 429), any thrown
        // exception (renameSync EEXIST, statSync error, unexpected code
        // path), any future refactor. Reviewer 2026-04-20 caught 3
        // missing reset paths in the pre-finally shape; finally is the
        // only robust option.
        globalThis._backupInFlight = true;
        try {
          const startT = Date.now();
          const tmpPath = BACKUP_PATH + '.tmp';
          cleanupBackupTmp(tmpPath);

          // Perform the online backup. better-sqlite3's backup() yields
          // to the event loop between page-chunks (setImmediate between
          // each transfer(rate) call per node_modules/better-sqlite3/
          // lib/methods/backup.js L41) — /health stays responsive.
          try {
            await ramDb.backup(tmpPath);
          } catch (e) {
            cleanupBackupTmp(tmpPath);
            return sendJson(res, 500, { status: 'fail', reason: 'backup_failed', detail: e.message });
          }

          // Verify integrity of the tmp before promoting.
          if (!verifyBackupFile(tmpPath)) {
            emitBackupIntegrityAlert(tmpPath, 'admin-backup: integrity_check failed on freshly-written tmp');
            cleanupBackupTmp(tmpPath);
            return sendJson(res, 500, {
              status: 'fail', reason: 'integrity_fail_on_tmp',
              hint: '.bak preserved, .sqlite untouched',
            });
          }

          // Truncate WAL on the verified tmp so rename moves a single self-contained file.
          try {
            const tmpDb = new Database(tmpPath);
            tmpDb.pragma('wal_checkpoint(TRUNCATE)');
            tmpDb.close();
          } catch { /* non-fatal */ }

          const fsMod = require('node:fs');
          // Rotate current .sqlite → .bak if valid.
          if (existsSync(BACKUP_PATH)) {
            if (verifyBackupFile(BACKUP_PATH)) {
              try { fsMod.renameSync(BACKUP_PATH, BACKUP_PATH + '.bak'); } catch {}
              for (const s of ['-wal', '-shm']) {
                try { fsMod.renameSync(BACKUP_PATH + s, BACKUP_PATH + '.bak' + s); } catch {}
              }
            } else {
              emitBackupIntegrityAlert(BACKUP_PATH, 'admin-backup: integrity_check failed on current .sqlite; .bak rotation skipped');
              try { fsMod.unlinkSync(BACKUP_PATH); } catch {}
              for (const s of ['-wal', '-shm']) {
                try { fsMod.unlinkSync(BACKUP_PATH + s); } catch {}
              }
            }
          }

          // Promote tmp → BACKUP_PATH.
          fsMod.renameSync(tmpPath, BACKUP_PATH);
          cleanupBackupTmp(tmpPath);

          const size = statSync(BACKUP_PATH).size;
          const integrity = verifyBackupFile(BACKUP_PATH) ? 'ok' : 'fail';
          const result = {
            status: 'ok',
            backup_path: BACKUP_PATH,
            size_bytes: size,
            integrity,
            duration_ms: Date.now() - startT,
            ran_at: new Date().toISOString(),
          };
          globalThis._backupCache = { ran_at_ms: now, result };

          // Record as admin-op entry for dashboard observability.
          try {
            ramDb.prepare(
              `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
               VALUES (?, ?, ?, 'admin-op', ?, datetime('now'), ?)`
            ).run(
              'admin-op',
              JSON.stringify({ op: 'backup', ...result }),
              JSON.stringify(['admin-op', `op:backup`, `result:${result.status}`]),
              Math.ceil(JSON.stringify(result).length / 4),
              require('node:crypto').createHash('sha256')
                .update(`backup:${now}`).digest('hex'),
            );
          } catch { /* non-fatal */ }

          sendJson(res, 200, result);
        } finally {
          globalThis._backupInFlight = false;
        }
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/wal-checkpoint') {
      // Stage 4 of the 2026-04-20 loose-coupling redesign.
      // Server-internal WAL checkpoint — previously scripts spawned
      // external `sqlite3 "$PRIMARY" 'PRAGMA wal_checkpoint(TRUNCATE)'`
      // subprocesses (see scripts/vcontext-backup.sh:78 pre-3b). That
      // held a file lock on primary.sqlite which could block the
      // server's readers — the exact class of coupling we're removing.
      //
      // Here we use ramDb's own connection (no new Database(), no
      // subprocess) so the call is in-process SQLite, yielding the
      // event loop between page copies per better-sqlite3 semantics.
      //
      // Body: { mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" }
      //   default: TRUNCATE (shrinks the -wal file; the only mode that
      //   reclaims disk space)
      // Returns: { status, mode, busy, log, checkpointed, duration_ms, ran_at }
      //
      // Auth: admin-tier (X-Vcontext-Admin: yes), same as sibling
      // endpoints (/admin/integrity-check, /admin/backup).
      // No rate-limit: checkpoint is cheap (ms-scale on a clean WAL,
      // low-seconds on a multi-GB runaway WAL). Callers can invoke as
      // often as they like.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const body = await readBody(req);
        const VALID_MODES = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'];
        const mode = (body && typeof body.mode === 'string') ? body.mode : 'TRUNCATE';
        if (!VALID_MODES.includes(mode)) {
          return sendJson(res, 400, {
            error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}`,
            received: mode,
          });
        }
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        const startT = Date.now();
        // ramDb.pragma returns [{busy, log, checkpointed}] for wal_checkpoint.
        // busy=1 means another reader blocked the checkpoint (PASSIVE-like
        // fallback); log=N is frames in WAL before; checkpointed=N is frames
        // copied to main.
        const rows = ramDb.pragma(`wal_checkpoint(${mode})`);
        const row = Array.isArray(rows) && rows[0] ? rows[0] : { busy: 0, log: 0, checkpointed: 0 };
        const result = {
          status: 'ok',
          mode,
          busy: row.busy | 0,
          log: row.log | 0,
          checkpointed: row.checkpointed | 0,
          duration_ms: Date.now() - startT,
          ran_at: new Date().toISOString(),
        };

        // Record as admin-op entry for dashboard / forensic replay.
        try {
          ramDb.prepare(
            `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
             VALUES (?, ?, ?, 'admin-op', ?, datetime('now'), ?)`
          ).run(
            'admin-op',
            JSON.stringify({ op: 'wal-checkpoint', ...result }),
            JSON.stringify(['admin-op', 'op:wal-checkpoint', `mode:${mode}`]),
            Math.ceil(JSON.stringify(result).length / 4),
            require('node:crypto').createHash('sha256')
              .update(`wal-checkpoint:${mode}:${startT}`).digest('hex'),
          );
        } catch { /* non-fatal */ }

        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/vacuum') {
      // Stage 4.5 Commit C2 (docs/specs/2026-04-21-stage-4.5-spec.md §3.2.5).
      // Replaces hooks.js:2316 hourly VACUUM (audit UC1/#11, already
      // removed in 884cc0b) and maintenance.sh:156 weekly VACUUM.
      //
      // Body: { target?: "primary"|"backup", force?: boolean }
      //   default target: "primary"
      // Returns: { status, target, freed_bytes?, elapsed_ms?, ran_at? }
      //   statuses: ok | skipped | deferred | disabled | not_implemented | fail
      //
      // Safety deviations from spec §3.2.5 (primary.sqlite is ~6.7 GB
      // as of 2026-04-20, so a sync VACUUM would block the event loop
      // for minutes and invite watchdog SIGKILL):
      //
      //   Size guard — if target file size > VCTX_VACUUM_MAX_BYTES
      //   (default 512 MiB), refuse with status=deferred UNLESS the
      //   caller sets `force=true` AND env VCTX_VACUUM_ALLOW_LARGE=1.
      //   Both are required so that a stray cron can't accidentally
      //   trigger a 10-minute stall.
      //
      //   target=backup — deferred (501). Would require a second
      //   better-sqlite3 connection to BACKUP_PATH; not in C2 scope.
      //   Follow-up commit C2b after worker-thread scaffolding lands.
      //
      // Rate-limit: 1 per 7 days per target, persisted as an
      // admin-vacuum-run entry. `force=true` bypasses the rate gate
      // (but NOT the size gate unless the env var is also set).
      //
      // Rollback: VCTX_VACUUM_DISABLED=1 → unconditional 503.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      if (process.env.VCTX_VACUUM_DISABLED === '1') {
        return sendJson(res, 503, {
          status: 'disabled',
          reason: 'VCTX_VACUUM_DISABLED=1',
        });
      }
      try {
        const body = await readBody(req);
        const VALID_TARGETS = ['primary', 'backup'];
        const target = (body && typeof body.target === 'string') ? body.target : 'primary';
        const force = !!(body && body.force === true);
        if (!VALID_TARGETS.includes(target)) {
          return sendJson(res, 400, {
            error: `Invalid target. Must be one of: ${VALID_TARGETS.join(', ')}`,
            received: target,
          });
        }
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        // Backup target deferred to C2b (needs separate connection).
        if (target === 'backup') {
          return sendJson(res, 501, {
            status: 'not_implemented',
            target,
            reason: 'backup_target_deferred',
            hint: 'target=backup requires a dedicated better-sqlite3 connection to BACKUP_PATH; scheduled for C2b after worker-thread scaffolding. Until then use target=primary or run VACUUM INTO offline.',
          });
        }

        // Rate-limit: look up last run for this target.
        const RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
        const targetTag = `"target:${target}"`;
        let recentRow;
        try {
          recentRow = ramDb.prepare(
            `SELECT created_at FROM entries
             WHERE type = 'admin-vacuum-run'
               AND tags LIKE '%' || ? || '%'
             ORDER BY id DESC LIMIT 1`
          ).get(targetTag);
        } catch { recentRow = null; }
        if (recentRow && !force) {
          const lastMs = Date.parse(recentRow.created_at.replace(' ', 'T') + 'Z');
          const age = Date.now() - (Number.isFinite(lastMs) ? lastMs : 0);
          if (age < RATE_LIMIT_MS) {
            return sendJson(res, 200, {
              status: 'skipped',
              target,
              reason: 'recent_vacuum',
              last_ran_at: recentRow.created_at,
              age_ms: age,
              retry_after_ms: RATE_LIMIT_MS - age,
            });
          }
        }

        // Size guard.
        const MAX_BYTES = parseInt(
          process.env.VCTX_VACUUM_MAX_BYTES || String(512 * 1024 * 1024),
          10,
        );
        const allowLarge = process.env.VCTX_VACUUM_ALLOW_LARGE === '1';
        let dbSizeBefore = 0;
        try {
          const st = require('node:fs').statSync(DB_PATH);
          dbSizeBefore = st.size;
        } catch { /* ignore */ }

        if (dbSizeBefore > MAX_BYTES && !(force && allowLarge)) {
          return sendJson(res, 503, {
            status: 'deferred',
            target,
            reason: 'db_too_large_for_sync_vacuum',
            current_bytes: dbSizeBefore,
            threshold_bytes: MAX_BYTES,
            hint: 'set body.force=true AND env VCTX_VACUUM_ALLOW_LARGE=1 to override (accepts event-loop stall). Prefer waiting for worker-thread VACUUM (C2b).',
          });
        }

        // Execute VACUUM. WARNING: blocks event loop for the duration.
        // With the size guard above this path only runs when DB
        // <= MAX_BYTES (or caller explicitly opted into large-DB stall).
        const startT = Date.now();
        ramDb.exec('VACUUM;');
        let dbSizeAfter = dbSizeBefore;
        try {
          dbSizeAfter = require('node:fs').statSync(DB_PATH).size;
        } catch { /* ignore */ }

        const result = {
          status: 'ok',
          target,
          freed_bytes: Math.max(0, dbSizeBefore - dbSizeAfter),
          bytes_before: dbSizeBefore,
          bytes_after: dbSizeAfter,
          elapsed_ms: Date.now() - startT,
          ran_at: new Date().toISOString(),
        };

        // Persist run record for rate-limit gate on next call.
        try {
          ramDb.prepare(
            `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
             VALUES ('admin-vacuum-run', ?, ?, 'admin-op', ?, datetime('now'), ?)`
          ).run(
            JSON.stringify(result),
            JSON.stringify(['admin-op', 'op:vacuum', `target:${target}`]),
            Math.ceil(JSON.stringify(result).length / 4),
            require('node:crypto').createHash('sha256')
              .update(`vacuum:${target}:${startT}`).digest('hex'),
          );
        } catch { /* non-fatal */ }

        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/auto-tune') {
      // Stage 4.5 Commit C3 (spec §3.2.4). Replaces
      // vcontext-maintenance.sh:137-149 CREATE INDEX + ANALYZE block
      // (audit #14). Runs on the server's own ramDb — no external lock.
      //
      // Body: { analyze?: bool (default true), ensure_indexes?: bool (default true) }
      // Returns: { status, indexes_created, analyze_elapsed_ms, ran_at }
      //
      // Rate-limit: 1/hour via admin-auto-tune-run entries.
      // force=true in body bypasses rate gate (for manual reruns).
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const body = (await readBody(req)) || {};
        const doAnalyze = body.analyze !== false;
        const doIndexes = body.ensure_indexes !== false;
        const force = body.force === true;
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        // Rate-limit check.
        const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour
        let recent;
        try {
          recent = ramDb.prepare(
            `SELECT created_at FROM entries
             WHERE type = 'admin-auto-tune-run'
             ORDER BY id DESC LIMIT 1`
          ).get();
        } catch { recent = null; }
        if (recent && !force) {
          const lastMs = Date.parse(recent.created_at.replace(' ', 'T') + 'Z');
          const age = Date.now() - (Number.isFinite(lastMs) ? lastMs : 0);
          if (age < RATE_LIMIT_MS) {
            return sendJson(res, 200, {
              status: 'skipped',
              reason: 'recent_tune',
              last_ran_at: recent.created_at,
              age_ms: age,
              retry_after_ms: RATE_LIMIT_MS - age,
              indexes_created: 0,
              analyze_elapsed_ms: 0,
            });
          }
        }

        // Canonical index list (lifted from maintenance.sh:137-149 — the
        // dead path we are replacing). If new indexes are needed, add
        // them here; idempotent via IF NOT EXISTS.
        const INDEX_STATEMENTS = [
          { name: 'idx_entries_embedding_null',
            sql: "CREATE INDEX IF NOT EXISTS idx_entries_embedding_null ON entries(id) WHERE embedding IS NULL" },
          { name: 'idx_entries_type_created',
            sql: "CREATE INDEX IF NOT EXISTS idx_entries_type_created ON entries(type, created_at DESC)" },
          { name: 'idx_entries_session_id',
            sql: "CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session, id DESC)" },
        ];

        let indexesCreated = 0;
        if (doIndexes) {
          // Enumerate existing indexes to report how many we actually
          // added (vs. pre-existing idempotent no-ops).
          let existingIndexes = new Set();
          try {
            const rows = ramDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            ).all();
            existingIndexes = new Set(rows.map(r => r.name));
          } catch { /* ignore */ }
          for (const ix of INDEX_STATEMENTS) {
            if (!existingIndexes.has(ix.name)) {
              try {
                ramDb.exec(ix.sql);
                indexesCreated++;
              } catch { /* per-index failure is non-fatal */ }
            }
          }
        }

        let analyzeElapsed = 0;
        if (doAnalyze) {
          const aT = Date.now();
          try { ramDb.exec('ANALYZE;'); } catch { /* non-fatal */ }
          analyzeElapsed = Date.now() - aT;
        }

        const result = {
          status: 'ok',
          indexes_created: indexesCreated,
          analyze_elapsed_ms: analyzeElapsed,
          analyzed: doAnalyze,
          indexes_ensured: doIndexes,
          ran_at: new Date().toISOString(),
        };

        // Persist for rate-limit gate.
        try {
          ramDb.prepare(
            `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
             VALUES ('admin-auto-tune-run', ?, ?, 'admin-op', ?, datetime('now'), ?)`
          ).run(
            JSON.stringify(result),
            JSON.stringify(['admin-op', 'op:auto-tune']),
            Math.ceil(JSON.stringify(result).length / 4),
            require('node:crypto').createHash('sha256')
              .update(`auto-tune:${Date.now()}`).digest('hex'),
          );
        } catch { /* non-fatal */ }

        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/snapshot') {
      // Stage 4.5 Commit C3 (spec §3.2.1). Replaces
      // vcontext-hooks.js:2408 cmdSnapshot → spawnSync('sqlite3',
      // [VCTX_RAM_DB, '.backup', dst]) (audit UC2/#13).
      //
      // Body: { label: string (required), include_wal?: bool, force?: bool }
      // Returns: { status, label, path, size_bytes, elapsed_ms, ran_at }
      //
      // Rate-limit: 1 per 10 min per label (force bypasses).
      // In-flight guard: prevents parallel snapshot() calls (each copies
      // the full 6.7 GB DB — two at once saturates IO for minutes).
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const body = (await readBody(req)) || {};
        const label = (body.label && typeof body.label === 'string') ? body.label.trim() : '';
        const force = body.force === true;

        // Validate label: alphanum + underscore + hyphen only, 1-64 chars.
        // Prevents path traversal (../../etc/passwd), null bytes, etc.
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) {
          return sendJson(res, 400, {
            error: 'Invalid label. Must match /^[A-Za-z0-9_-]{1,64}$/',
            received: label,
          });
        }
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        // In-flight guard (snapshots of 6.7 GB stack badly).
        const inflightKey = '_snapshotInFlight';
        if (globalThis[inflightKey]) {
          return sendJson(res, 429, {
            status: 'busy',
            reason: 'snapshot_already_running',
            hint: 'wait for current snapshot to complete before retrying',
          });
        }

        // Rate-limit check.
        const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 min per label
        const labelTag = `"label:${label}"`;
        let recent;
        try {
          recent = ramDb.prepare(
            `SELECT created_at FROM entries
             WHERE type = 'admin-snapshot-run'
               AND tags LIKE '%' || ? || '%'
             ORDER BY id DESC LIMIT 1`
          ).get(labelTag);
        } catch { recent = null; }
        if (recent && !force) {
          const lastMs = Date.parse(recent.created_at.replace(' ', 'T') + 'Z');
          const age = Date.now() - (Number.isFinite(lastMs) ? lastMs : 0);
          if (age < RATE_LIMIT_MS) {
            return sendJson(res, 429, {
              status: 'skipped',
              label,
              reason: 'recent_snapshot',
              last_ran_at: recent.created_at,
              age_ms: age,
              retry_after_ms: RATE_LIMIT_MS - age,
            });
          }
        }

        const fsMod = require('node:fs');
        const pathMod = require('node:path');
        const SNAP_DIR = pathMod.join(process.env.HOME, 'skills', 'data', 'snapshots');
        try { fsMod.mkdirSync(SNAP_DIR, { recursive: true }); } catch { /* ignore */ }

        // Filename: <label>-<YYYYMMDD-HHmm>.db
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
        const destName = `${label}-${stamp}.db`;
        const destPath = pathMod.join(SNAP_DIR, destName);
        const tmpPath = destPath + '.tmp';

        // Clean up any stale tmp from a prior crashed attempt.
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try { fsMod.unlinkSync(tmpPath + suffix); } catch { /* ignore */ }
        }

        globalThis[inflightKey] = true;
        try {
          const startT = Date.now();
          try {
            await ramDb.backup(tmpPath);
          } catch (e) {
            for (const suffix of ['', '-wal', '-shm', '-journal']) {
              try { fsMod.unlinkSync(tmpPath + suffix); } catch { /* ignore */ }
            }
            return sendJson(res, 500, {
              status: 'fail',
              label,
              reason: 'backup_failed',
              detail: e.message,
            });
          }

          // Size sanity before promotion.
          let sizeBytes = 0;
          try { sizeBytes = fsMod.statSync(tmpPath).size; } catch { /* ignore */ }
          if (sizeBytes <= 0) {
            try { fsMod.unlinkSync(tmpPath); } catch { /* ignore */ }
            return sendJson(res, 500, {
              status: 'fail',
              label,
              reason: 'zero_byte_snapshot',
            });
          }

          // Truncate WAL in the tmp so the promoted file is self-contained
          // (one-file snapshot, portable). Skip if include_wal=true.
          if (body.include_wal !== true) {
            try {
              const tmpDb = new Database(tmpPath);
              tmpDb.pragma('wal_checkpoint(TRUNCATE)');
              tmpDb.close();
            } catch { /* non-fatal — snapshot still usable */ }
          }

          // Atomic rename into final slot.
          try {
            fsMod.renameSync(tmpPath, destPath);
          } catch (e) {
            try { fsMod.unlinkSync(tmpPath); } catch { /* ignore */ }
            return sendJson(res, 500, {
              status: 'fail',
              label,
              reason: 'rename_failed',
              detail: e.message,
            });
          }

          // Re-stat after rename in case truncate changed size.
          try { sizeBytes = fsMod.statSync(destPath).size; } catch { /* ignore */ }

          const result = {
            status: 'ok',
            label,
            path: destPath,
            size_bytes: sizeBytes,
            elapsed_ms: Date.now() - startT,
            ran_at: new Date().toISOString(),
          };

          // Persist for rate-limit gate.
          try {
            ramDb.prepare(
              `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
               VALUES ('admin-snapshot-run', ?, ?, 'admin-op', ?, datetime('now'), ?)`
            ).run(
              JSON.stringify(result),
              JSON.stringify(['admin-op', 'op:snapshot', `label:${label}`]),
              Math.ceil(JSON.stringify(result).length / 4),
              require('node:crypto').createHash('sha256')
                .update(`snapshot:${label}:${startT}`).digest('hex'),
            );
          } catch { /* non-fatal */ }

          sendJson(res, 200, result);
        } finally {
          globalThis[inflightKey] = false;
        }
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/integrity-check') {
      // Stage 2 of loose-coupling redesign (docs/specs/2026-04-20-true-
      // loose-coupling-redesign.md). Runs PRAGMA integrity_check against
      // the BACKUP SNAPSHOT (not live primary) so maintenance.sh and
      // hooks.js no longer spawn sqlite3 CLIs that hold read-locks on
      // primary.sqlite for minutes at a time (root cause of today's
      // 3 GB WAL bloat).
      //
      // Target design decision (2026-04-20 agile iteration):
      //   v1 supported target=primary via ramDb.prepare('integrity_check')
      //   — which blocked the Node event loop for 37 seconds on our 6 GB
      //   DB. That's the exact symptom we're trying to eliminate. v2
      //   drops target=primary entirely: integrity of primary is
      //   guaranteed by SQLite WAL+fsync on every commit, so explicit
      //   re-verification on live primary is not a useful maintenance
      //   task. Backup snapshot is the right check surface — isolated
      //   file, no lock contention, takes minutes but doesn't matter.
      //
      // Body: {} (reserved for future options; currently ignored)
      // Returns { status, backup_path, integrity_check, quick_check,
      //           duration_ms, ran_at, cached?: bool }.
      //
      // Rate-limit: 1/hour. Maintenance.sh cycles every 30-60 min;
      // first call of each hour does the check, subsequent return cache.
      //
      // Auth: admin-tier operation. Requires X-Vcontext-Admin: yes
      // (same gate as /admin/fts-rebuild and other destructive admin
      // ops). Security-review 2026-04-20 found v1 missed this guard.
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        await readBody(req); // consume body even if unused
        const now = Date.now();
        const THROTTLE_MS = 60 * 60 * 1000; // 1h
        const backupPath = join(BACKUP_DIR, 'vcontext-backup.sqlite');

        // In-memory cache (persists for server lifetime).
        if (!globalThis._integrityCache) globalThis._integrityCache = {};
        const cached = globalThis._integrityCache['backup'];
        if (cached && now - cached.ran_at_ms < THROTTLE_MS) {
          return sendJson(res, 200, {
            ...cached.result,
            cached: true,
            next_in_minutes: Math.round((THROTTLE_MS - (now - cached.ran_at_ms)) / 60000),
          });
        }

        // Sanity-check the backup file before spending time on it.
        if (!existsSync(backupPath)) {
          return sendJson(res, 503, {
            status: 'skipped', reason: 'backup_missing', backup_path: backupPath,
          });
        }
        let stat;
        try { stat = statSync(backupPath); } catch (e) {
          return sendJson(res, 503, {
            status: 'skipped', reason: 'stat_failed', detail: e.message,
          });
        }
        if (stat.size < 1024 * 1024) {
          return sendJson(res, 503, {
            status: 'skipped', reason: 'backup_too_small', size: stat.size,
            hint: 'likely a fresh / in-progress backup; will retry next cycle',
          });
        }
        // If an .ext-tmp exists alongside, a backup cycle is in progress.
        // Don't check mid-write — the main .sqlite file is stable but its
        // -wal/-shm could be racing. Return "skipped" to let the next
        // cycle retry against a completed backup.
        if (existsSync(backupPath + '.ext-tmp')) {
          return sendJson(res, 503, {
            status: 'skipped', reason: 'backup_cycle_in_progress',
            hint: '.ext-tmp present; retry in a few minutes',
          });
        }

        const startT = Date.now();
        const { spawnSync } = require('node:child_process');
        const runOne = (pragma) => {
          const r = spawnSync('sqlite3', [backupPath, pragma], {
            encoding: 'utf-8',
            timeout: 10 * 60 * 1000, // 10 min hard cap
            killSignal: 'SIGKILL',
          });
          return {
            stdout: (r.stdout || '').trim(),
            stderr: (r.stderr || '').trim(),
            signal: r.signal,
            status: r.status,
          };
        };
        const ic = runOne('PRAGMA integrity_check;');
        const qc = runOne('PRAGMA quick_check;');
        const ok = ic.stdout === 'ok' && qc.stdout === 'ok'
                && !ic.stderr && !qc.stderr
                && ic.status === 0 && qc.status === 0;
        const result = {
          status: ok ? 'ok' : 'fail',
          target: 'backup',
          backup_path: backupPath,
          backup_size: stat.size,
          integrity_check: ic.stdout,
          integrity_stderr: ic.stderr || undefined,
          integrity_exit: ic.status,
          quick_check: qc.stdout,
          quick_stderr: qc.stderr || undefined,
          quick_exit: qc.status,
          duration_ms: Date.now() - startT,
          ran_at: new Date().toISOString(),
        };

        globalThis._integrityCache['backup'] = { ran_at_ms: now, result };

        // Record as entry for dashboard / observability.
        try {
          ramDb.prepare(
            `INSERT INTO entries (type, content, tags, session, token_estimate, created_at, content_hash)
             VALUES (?, ?, ?, 'admin-op', ?, datetime('now'), ?)`
          ).run(
            'admin-op',
            JSON.stringify({ op: 'integrity-check', ...result }),
            JSON.stringify(['admin-op', `op:integrity-check`, `result:${result.status}`]),
            Math.ceil(JSON.stringify(result).length / 4),
            require('node:crypto').createHash('sha256')
              .update(`integrity:backup:${now}`).digest('hex'),
          );
        } catch (e) {
          // Non-fatal — logging failure shouldn't block the op result.
        }

        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/dedup-ssd') {
      // Focused SSD dedup. Creates index first to avoid O(n²) scan,
      // then uses MIN(id) GROUP BY (O(n log n)).
      const result = { deleted: 0, schema_fixed: 0, vacuumed: false, indexed: false, error: null };
      try {
        try {
          ssdDb.exec(`CREATE INDEX IF NOT EXISTS idx_ssd_dedup ON entries(type, content_hash);`);
          result.indexed = true;
        } catch {}
        try {
          const fix = ssdDb.prepare(
            `UPDATE entries SET created_at = token_estimate, token_estimate = CAST(created_at AS INTEGER)
             WHERE created_at NOT LIKE '20__-%' AND token_estimate LIKE '20__-%';`
          ).run();
          result.schema_fixed = fix.changes;
        } catch {}
        // Fast dedup: IDs to KEEP = MIN(id) per (type, content_hash);
        // DELETE everything else (within non-skip types).
        const del = ssdDb.prepare(`
          DELETE FROM entries
          WHERE type NOT IN ('test','working-state','session-recall','anomaly-alert')
            AND content_hash IS NOT NULL
            AND id NOT IN (
              SELECT MIN(id) FROM entries
              WHERE type NOT IN ('test','working-state','session-recall','anomaly-alert')
                AND content_hash IS NOT NULL
              GROUP BY type, content_hash
            );`).run();
        result.deleted = del.changes;
        try { ssdDb.exec(`VACUUM;`); result.vacuumed = true; } catch {}
        sendJson(res, 200, result);
      } catch (e) { result.error = e.message; sendJson(res, 500, result); }
    } else if (method === 'POST' && path === '/admin/dedup-migration') {
      // One-shot migration: add content_hash column, backfill for all
      // rows, delete duplicate entries (keep oldest id per group), then
      // add a UNIQUE index so future writes are atomically deduped.
      // Skip types where repetition is legitimate.
      const SKIP = ['test', 'working-state', 'session-recall', 'anomaly-alert'];
      const skipSql = SKIP.map(t => `'${t}'`).join(',');
      const crypto = require('node:crypto');
      const result = { added_column: false, backfilled: 0, deleted: 0, index_created: false, error: null };
      try {
        // 1. Add column (idempotent)
        try {
          ramDb.exec(`ALTER TABLE entries ADD COLUMN content_hash TEXT;`);
          result.added_column = true;
        } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

        // 2. Backfill hashes for rows that don't have one
        const rows = ramDb.prepare(`SELECT id, content FROM entries WHERE content_hash IS NULL OR content_hash = '';`).all();
        const update = ramDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
        const tx = ramDb.transaction((rs) => {
          for (const r of rs) {
            const h = crypto.createHash('sha256').update(String(r.content)).digest('hex');
            update.run(h, r.id);
          }
        });
        tx(rows);
        result.backfilled = rows.length;

        // 3. Identify + delete duplicates (keep MIN(id) per group)
        const delSql = `
          DELETE FROM entries WHERE id IN (
            SELECT id FROM entries e1
            WHERE type NOT IN (${skipSql})
              AND EXISTS (
                SELECT 1 FROM entries e2
                WHERE e2.session = e1.session
                  AND e2.type = e1.type
                  AND e2.content_hash = e1.content_hash
                  AND e2.id < e1.id
              )
          );`;
        const delInfo = ramDb.prepare(delSql).run();
        result.deleted = delInfo.changes;

        // 4. Create UNIQUE index
        try {
          ramDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_entry_hash ON entries(session, type, content_hash) WHERE type NOT IN (${skipSql});`);
          result.index_created = true;
        } catch (e) { result.error = 'index: ' + e.message; }

        // 5. Same for SSD DB (best-effort): backfill hashes AND delete
        //    duplicates cross-session (SSD is long-term cold store, rarely
        //    accessed; repeat content is always waste).
        if (ssdDb) {
          try {
            try { ssdDb.exec(`ALTER TABLE entries ADD COLUMN content_hash TEXT;`); } catch {}
            // 5a. Fix column-shift corruption from old migrateRamToSsd bug
            //     (some rows have integer in created_at, date in token_estimate).
            try {
              const fix = ssdDb.prepare(
                `UPDATE entries SET created_at = token_estimate, token_estimate = CAST(created_at AS INTEGER)
                 WHERE created_at NOT LIKE '20__-%' AND token_estimate LIKE '20__-%';`
              ).run();
              result.ssd_schema_fixed = fix.changes;
            } catch {}
            // 5b. Backfill hashes
            const ssdRows = ssdDb.prepare(`SELECT id, content FROM entries WHERE content_hash IS NULL OR content_hash = '';`).all();
            const ssdUpd = ssdDb.prepare(`UPDATE entries SET content_hash = ? WHERE id = ?`);
            const ssdTx = ssdDb.transaction((rs) => {
              for (const r of rs) {
                const h = crypto.createHash('sha256').update(String(r.content)).digest('hex');
                ssdUpd.run(h, r.id);
              }
            });
            ssdTx(ssdRows);
            result.ssd_backfilled = ssdRows.length;
            // 5c. Delete duplicates (keep MIN(id) per type+hash; SSD is
            //     cross-session so ignore session)
            const ssdDel = ssdDb.prepare(`
              DELETE FROM entries WHERE id IN (
                SELECT id FROM entries e1
                WHERE type NOT IN (${skipSql})
                  AND EXISTS (
                    SELECT 1 FROM entries e2
                    WHERE e2.type = e1.type AND e2.content_hash = e1.content_hash AND e2.id < e1.id
                  )
              );`).run();
            result.ssd_deleted = ssdDel.changes;
            try { ssdDb.exec(`VACUUM;`); } catch {}
          } catch (e) { result.ssd_error = e.message; }
        }

        // 6. VACUUM
        ramDb.exec(`VACUUM;`);
        sendJson(res, 200, result);
      } catch (e) {
        result.error = e.message;
        sendJson(res, 500, result);
      }
    } else if (method === 'GET' && path === '/admin/metrics/window') {
      // Stage 4.5 Commit C4 (spec §3.2.3). Replaces
      // vcontext-hooks.js cmdMetrics (6 spawnSync sites) +
      // maintenance.sh perf-regression block + self-improve/abtest shell
      // queries. Single HTTP hit, no external file locks.
      //
      // Query: ?hours=N&metric=<name>   metric='all' returns everything.
      // Hours: 1..720 (30 days cap, sanity check).
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const params = parseQuery(req.url);
        const hours = parseInt(params.hours || '1', 10);
        const metric = typeof params.metric === 'string' ? params.metric : 'all';
        if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
          return sendJson(res, 400, {
            error: 'Invalid hours. Must be 1..720 (integer).',
            received: params.hours,
          });
        }
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        const since = `datetime('now', '-${hours} hours')`;
        const result = { window_hours: hours };

        // ── api_metrics aggregates ──
        if (metric === 'all' || metric === 'api_metrics' || /^latency_/.test(metric)) {
          let am = { latency_p50_ms: 0, latency_p95_ms: 0, latency_p99_ms: 0,
                     request_count: 0, error_count: 0 };
          try {
            const row = ramDb.prepare(
              `SELECT COUNT(*) AS n, AVG(latency_ms) AS avg_lat
               FROM api_metrics WHERE created_at >= ${since}`
            ).get();
            am.request_count = row?.n | 0;
            // p50/p95/p99 via ORDER BY + LIMIT percentile approximation
            // (cheap on api_metrics index, avoids window function overhead)
            if (am.request_count > 0) {
              const p = (pct) => {
                const offset = Math.max(0, Math.floor(am.request_count * (1 - pct / 100)));
                const r = ramDb.prepare(
                  `SELECT latency_ms FROM api_metrics WHERE created_at >= ${since}
                   ORDER BY latency_ms DESC LIMIT 1 OFFSET ?`
                ).get(offset);
                return Math.round(r?.latency_ms || 0);
              };
              am.latency_p50_ms = p(50);
              am.latency_p95_ms = p(95);
              am.latency_p99_ms = p(99);
            }
          } catch { /* non-fatal */ }
          result.api_metrics = am;
        }

        // ── entries aggregates ──
        if (metric === 'all' || metric === 'entries') {
          let en = { total: 0, with_embedding: 0, by_type: {}, distinct_sessions: 0 };
          try {
            const total = ramDb.prepare(
              `SELECT COUNT(*) AS n FROM entries WHERE created_at >= ${since}`
            ).get();
            en.total = total?.n | 0;

            const withEmb = ramDb.prepare(
              `SELECT COUNT(*) AS n FROM entries
               WHERE created_at >= ${since} AND embedding IS NOT NULL`
            ).get();
            en.with_embedding = withEmb?.n | 0;

            const byType = ramDb.prepare(
              `SELECT type, COUNT(*) AS n FROM entries
               WHERE created_at >= ${since} GROUP BY type`
            ).all();
            en.by_type = {};
            for (const r of byType) en.by_type[r.type] = r.n | 0;

            const sess = ramDb.prepare(
              `SELECT COUNT(DISTINCT session) AS n FROM entries
               WHERE created_at >= ${since} AND session IS NOT NULL`
            ).get();
            en.distinct_sessions = sess?.n | 0;
          } catch { /* non-fatal */ }
          result.entries = en;
        }

        result.generated_at = new Date().toISOString();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/gc/dry-run') {
      // Stage 4.5 Commit C4 (spec §3.2.6). Replaces
      // vcontext-hooks.js:2288 cmdGc expiry scan. Read-only — the WRITE
      // side of gc stays on the existing /admin/gc/apply (if present) or
      // a future POST; this endpoint is deliberately harmless.
      //
      // Body: { embedding_prune_days?: N (default 30),
      //         include_types?: [type,...] (default all candidate types) }
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const body = (await readBody(req)) || {};
        const pruneDays = Number.isFinite(+body.embedding_prune_days)
          ? Math.max(1, Math.min(3650, +body.embedding_prune_days))
          : 30;
        const defaultTypes = [
          'skill-discovery', 'skill-suggestion', 'pre-tool', 'tool-use',
          'assistant-response', 'skill-usage', 'skill-gap',
        ];
        const includeTypes = Array.isArray(body.include_types) && body.include_types.length > 0
          ? body.include_types.filter(t => typeof t === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t))
          : defaultTypes;
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        const windowEnd = `datetime('now', '-${pruneDays} days')`;
        const candidates = [];
        let totalBytes = 0;
        try {
          const stmt = ramDb.prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(length(content)), 0) AS bytes
             FROM entries
             WHERE type = ? AND created_at < ${windowEnd}`
          );
          for (const t of includeTypes) {
            const row = stmt.get(t);
            const c = row?.count | 0;
            const b = row?.bytes | 0;
            if (c > 0) {
              candidates.push({ type: t, count: c, bytes: b });
              totalBytes += b;
            }
          }
        } catch { /* non-fatal */ }

        sendJson(res, 200, {
          candidates,
          total_bytes: totalBytes,
          window_end: new Date(Date.now() - pruneDays * 24 * 3600 * 1000).toISOString(),
          prune_days: pruneDays,
          included_types: includeTypes,
          ran_at: new Date().toISOString(),
        });
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/policy-check') {
      // Stage 4.5 Commit C4 (spec §3.2.7). Replaces
      // vcontext-hooks.js cmdPolicyCheck's 6 spawnSync sites.
      //
      // Body: { checks?: string[], window_hours?: N (default 24) }
      // Available checks:
      //   secret-scan       — regex-scan recent entries for
      //                       obvious credentials (API keys, PEMs)
      //   tier-balance      — entries per tier (ram/ssd) ratio check
      //   policy-violations — explicit type='policy-violation' count
      //
      // Status logic:
      //   - any finding with severity='high' → 'fail'
      //   - any finding with severity='warn' → 'warn'
      //   - otherwise → 'pass'
      if (req.headers['x-vcontext-admin'] !== 'yes') {
        return sendJson(res, 403, {
          error: 'X-Vcontext-Admin: yes header required for admin operations',
        });
      }
      try {
        const body = (await readBody(req)) || {};
        const AVAILABLE = ['secret-scan', 'tier-balance', 'policy-violations'];
        const requested = Array.isArray(body.checks) && body.checks.length > 0
          ? body.checks.filter(c => AVAILABLE.includes(c))
          : AVAILABLE;
        const hours = Number.isFinite(+body.window_hours)
          ? Math.max(1, Math.min(720, +body.window_hours))
          : 24;
        if (!ramDb) {
          return sendJson(res, 503, { status: 'skipped', reason: 'ramdb_unavailable' });
        }

        const since = `datetime('now', '-${hours} hours')`;
        const findings = [];

        if (requested.includes('secret-scan')) {
          // Cheap regex over recent entries' content. Keep bounded by
          // LIMIT to avoid scanning millions on big windows.
          const SECRET_RE = /(api[_-]?key|aws[_-]?access[_-]?key|secret[_-]?key|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z]+ PRIVATE KEY-----)/i;
          let hits = 0;
          try {
            const rows = ramDb.prepare(
              `SELECT id, content FROM entries
               WHERE created_at >= ${since}
                 AND length(content) > 10
               ORDER BY id DESC LIMIT 5000`
            ).all();
            for (const r of rows) {
              if (SECRET_RE.test(r.content || '')) hits++;
            }
          } catch { /* non-fatal */ }
          findings.push({
            check: 'secret-scan',
            count: hits,
            severity: hits > 0 ? 'warn' : 'info',
            scope: `recent ${hours}h, up to 5000 entries`,
          });
        }

        if (requested.includes('tier-balance')) {
          // Imbalance if ssd:ram ratio > 20 within the window (arbitrary
          // threshold; easy to tune later).
          let byTier = { ram: 0, ssd: 0, other: 0 };
          try {
            const rows = ramDb.prepare(
              `SELECT COALESCE(tier,'other') AS tier, COUNT(*) AS n FROM entries
               WHERE created_at >= ${since} GROUP BY tier`
            ).all();
            for (const r of rows) {
              const key = (r.tier === 'ram' || r.tier === 'ssd') ? r.tier : 'other';
              byTier[key] += r.n | 0;
            }
          } catch { /* non-fatal */ }
          const ratio = byTier.ram > 0 ? byTier.ssd / byTier.ram : Infinity;
          findings.push({
            check: 'tier-balance',
            count: byTier.ram + byTier.ssd + byTier.other,
            severity: (Number.isFinite(ratio) && ratio > 20) ? 'warn' : 'info',
            by_tier: byTier,
            ssd_to_ram_ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
          });
        }

        if (requested.includes('policy-violations')) {
          let count = 0;
          try {
            const row = ramDb.prepare(
              `SELECT COUNT(*) AS n FROM entries
               WHERE type = 'policy-violation' AND created_at >= ${since}`
            ).get();
            count = row?.n | 0;
          } catch { /* non-fatal */ }
          findings.push({
            check: 'policy-violations',
            count,
            severity: count > 0 ? 'high' : 'info',
          });
        }

        // Derive overall status.
        const sev = findings.map(f => f.severity);
        const overall = sev.includes('high') ? 'fail'
                      : sev.includes('warn') ? 'warn'
                      : 'pass';

        sendJson(res, 200, {
          status: overall,
          findings,
          window_hours: hours,
          ran_at: new Date().toISOString(),
        });
      } catch (e) {
        sendJson(res, 500, { status: 'fail', error: e.message });
      }
    } else if (method === 'POST' && path === '/admin/fts-full-rebuild') {
      // Nuclear rebuild: drop FTS + triggers, recreate, reindex from entries,
      // then hard-delete all status='migrated' rows. Done in a single
      // transaction on the live DB (no server restart needed).
      const result = { dropped: false, recreated: false, reindexed: 0, cleaned: 0, error: null };
      try {
        const tx = ramDb.transaction(() => {
          // Drop delete trigger FIRST so DROP TABLE doesn't cascade-fire it
          ramDb.exec(`DROP TRIGGER IF EXISTS entries_ai;`);
          ramDb.exec(`DROP TRIGGER IF EXISTS entries_ad;`);
          ramDb.exec(`DROP TABLE IF EXISTS entries_fts;`);
          result.dropped = true;
          // Recreate FTS virtual table + triggers
          ramDb.exec(`CREATE VIRTUAL TABLE entries_fts USING fts5(content, tags, type);`);
          ramDb.exec(`CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, content, tags, type) VALUES (new.id, new.content, new.tags, new.type);
          END;`);
          // DELETE trigger: use FTS5 contentless-deletion. The previous
          // form (VALUES('delete', rowid, content, tags, type)) requires
          // the stored columns to exactly match the old row — any drift
          // yields "SQL logic error" and blocks every DELETE on entries.
          // A plain DELETE from the FTS shadow table by rowid is safer.
          ramDb.exec(`CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
            DELETE FROM entries_fts WHERE rowid = old.id;
          END;`);
          result.recreated = true;
          // Reindex all rows
          const reindex = ramDb.prepare(
            `INSERT INTO entries_fts(rowid, content, tags, type) SELECT id, content, tags, type FROM entries;`
          );
          const info = reindex.run();
          result.reindexed = info.changes;
          // Hard-delete soft-migrated rows — trigger now works
          const del = ramDb.prepare(`DELETE FROM entries WHERE status='migrated'`);
          const delInfo = del.run();
          result.cleaned = delInfo.changes;
        });
        tx();
        // Vacuum to reclaim space
        ramDb.exec(`VACUUM;`);
        sendJson(res, 200, result);
      } catch (e) {
        result.error = e.message;
        console.error('[admin:fts-rebuild]', e.message);
        sendJson(res, 500, result);
      }
    } else if (method === 'POST' && path === '/admin/fts-hard-cleanup') {
      // After a successful FTS rebuild, attempt hard-delete of soft-
      // migrated rows. Returns counts.
      let deleted = 0, failed = 0;
      try {
        const rows = ramDb.prepare(`SELECT id FROM entries WHERE status='migrated'`).all();
        const del = ramDb.prepare(`DELETE FROM entries WHERE id = ?`);
        for (const r of rows) {
          try { del.run(r.id); deleted++; } catch { failed++; }
        }
      } catch {}
      sendJson(res, 200, { deleted, failed });
    } else if (method === 'POST' && path === '/tier/migrate') {
      handleTierMigrate(req, res);
    } else if (method === 'GET' && path === '/summaries') {
      // Hierarchical chunk summaries (PHOTON-inspired memory tier).
      //   level=1 (default)  → 10-min chunks, ?hours=N window (max 30d)
      //   level=2            → daily chunks,   ?days=N  window (max 365d)
      //   level=3            → weekly chunks,  ?weeks=N window (max 104w)
      // Use this BEFORE drilling into raw entries for long-term recall.
      try {
        const params = parseQuery(req.url);
        const level = parseInt(params.level) || 1;
        let periodLabel, periodValue, sinceMs, expected;
        if (level === 2) {
          const days = Math.min(parseInt(params.days) || 30, 365);
          sinceMs = days * 24 * 3600000;
          periodLabel = 'period_days'; periodValue = days;
          expected = days;
        } else if (level === 3) {
          const weeks = Math.min(parseInt(params.weeks) || 12, 104);
          sinceMs = weeks * 7 * 24 * 3600000;
          periodLabel = 'period_weeks'; periodValue = weeks;
          expected = weeks;
        } else {
          const hours = Math.min(parseInt(params.hours) || 24, 24 * 30);
          sinceMs = hours * 3600000;
          periodLabel = 'period_hours'; periodValue = hours;
          expected = Math.floor(hours * 60 / 10);
        }
        const since = esc(new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19));
        const rows = dbQuery(`
          SELECT id, content, created_at FROM entries
          WHERE type='chunk-summary' AND tags LIKE ${esc('%level:' + level + '%')}
            AND created_at >= ${since}
          ORDER BY created_at DESC LIMIT 500;
        `);
        const summaries = rows.map(r => {
          try { return { id: r.id, created_at: r.created_at, ...JSON.parse(r.content) }; }
          catch { return { id: r.id, created_at: r.created_at, raw: r.content }; }
        });
        sendJson(res, 200, {
          level, [periodLabel]: periodValue, count: summaries.length,
          expected_chunks: expected,
          coverage: expected > 0 ? Math.min(1, summaries.length / expected) : 0,
          summaries,
        });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/sessions/summary') {
      // Compact session aggregate for the dashboard's Sessions card.
      // Replaces the old pattern of `/recent?n=200&short=1` (200KB payload)
      // being aggregated client-side. SQL does the same work in ~5KB.
      try {
        const params = parseQuery(req.url);
        const hours = Math.min(parseInt(params.hours) || 24, 24 * 7);
        const since = esc(new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19));
        // Per-session aggregates: event count, first/last seen.
        // entry_index is already indexed on (session, created_at) so this
        // is a bounded table scan, not a full entries scan.
        const agg = dbQuery(`
          SELECT session, COUNT(*) as events, MIN(created_at) as first_seen, MAX(created_at) as last_active
          FROM entry_index WHERE session IS NOT NULL AND session != ''
            AND created_at >= ${since}
          GROUP BY session ORDER BY last_active DESC LIMIT 100;
        `);
        if (agg.length === 0) return sendJson(res, 200, { sessions: [], count: 0 });
        // Type-breakdown per session — a separate grouped query, then joined in JS.
        const sids = agg.map(r => esc(r.session)).join(',');
        const typeRows = dbQuery(`
          SELECT session, type, COUNT(*) as cnt FROM entry_index
          WHERE session IN (${sids}) AND created_at >= ${since}
          GROUP BY session, type;
        `);
        const typesMap = {};
        for (const r of typeRows) {
          (typesMap[r.session] = typesMap[r.session] || {})[r.type] = r.cnt;
        }
        // Project (cwd) per session — fetch exactly one representative
        // entry per session via MIN(id) subquery. Uses idx_entries_session_id
        // (session, id DESC) so the inner query is an index-range scan, not
        // a full content-LIKE scan. ~10x faster for 50-session windows.
        const projRows = dbQuery(`
          SELECT e.session, substr(e.content, 1, 400) as content FROM entries e
          WHERE e.id IN (
            SELECT MIN(id) FROM entries WHERE session IN (${sids}) GROUP BY session
          );
        `);
        const projMap = {};
        for (const r of projRows) {
          try {
            const d = JSON.parse(r.content + (r.content.endsWith('}') ? '' : '}'));
            if (d.cwd) projMap[r.session] = d.cwd.split('/').filter(Boolean).pop();
          } catch {
            // content was truncated mid-object; regex fallback
            const m = /"cwd"\s*:\s*"([^"]+)"/.exec(r.content || '');
            if (m) projMap[r.session] = m[1].split('/').filter(Boolean).pop();
          }
        }
        const sessions = agg.map(r => ({
          session: r.session,
          events: r.events,
          first_seen: r.first_seen,
          last_active: r.last_active,
          types: typesMap[r.session] || {},
          project: projMap[r.session] || '',
        }));
        sendJson(res, 200, { sessions, count: sessions.length, period_hours: hours });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    } else if (method === 'GET' && path === '/tier/stats') {
      handleTierStats(req, res);
    } else if (method === 'POST' && path === '/tier/config') {
      await handleTierConfig(req, res);
    } else if (method === 'POST' && path === '/auth/create-key') {
      await handleCreateKey(req, res);
    } else if (method === 'GET' && path === '/auth/whoami') {
      handleWhoami(req, res);
    } else if (method === 'POST' && path === '/auth/create-group') {
      await handleCreateGroup(req, res);
    } else if (method === 'GET' && path === '/auth/groups') {
      handleListGroups(req, res);
    } else if (method === 'POST' && path === '/auth/update-key') {
      await handleUpdateKey(req, res);
    } else if (method === 'GET' && path === '/auth/keys') {
      handleListKeys(req, res);
    } else if (method === 'POST' && path === '/resolve') {
      await handleResolve(req, res);
    } else if (method === 'POST' && path === '/consult') {
      await handleConsult(req, res);
    } else if (method === 'GET' && path === '/consult/pending') {
      handleConsultPending(req, res);
    } else if (method === 'POST' && path === '/consult/auto-respond') {
      await handleConsultAutoRespond(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/response$/)) {
      await handleConsultResponse(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/claim$/)) {
      await handleConsultClaim(req, res);
    } else if (method === 'POST' && path.match(/^\/consult\/[^/]+\/close$/)) {
      await handleConsultClose(req, res);
    } else if (method === 'GET' && path === '/consult/list') {
      handleConsultList(req, res);
    } else if (method === 'GET' && path.match(/^\/consult\/[^/]+$/) && !path.endsWith('/response')) {
      handleConsultStatus(req, res);
    } else if (method === 'GET' && path === '/ai/status') {
      handleAiStatus(req, res);
    } else if (method === 'POST' && path === '/ai/summarize') {
      await handleAiSummarize(req, res);
    } else if (method === 'GET' && path === '/search/semantic') {
      await handleSemanticSearch(req, res);
    } else if (method === 'POST' && path === '/analytics/track') {
      await handleAnalyticsTrack(req, res);
    } else if (method === 'GET' && path === '/analytics/report') {
      handleAnalyticsReport(req, res);
    } else if (method === 'GET' && path === '/metrics/report') {
      handleMetricsReport(req, res);
    } else if (method === 'GET' && path === '/skills/effectiveness') {
      handleSkillEffectiveness(req, res);
    } else if (method === 'GET' && path === '/predict/next') {
      // Pillar 4 — Predictive Ambience: ranked next-likely tool / skill
      // / open-gap candidates from recent activity. Pure-SQL, no MLX.
      handlePredictNext(req, res);
    } else if (method === 'POST' && path === '/predictive-search') {
      await handlePredictiveSearch(req, res);
    } else if (method === 'POST' && path === '/completion-check') {
      await handleCompletionCheck(req, res);
    } else if (method === 'GET' && path === '/dashboard') {
      // no-cache + must-revalidate so browsers don't pin a broken JS
      // bundle across deploys.  Today's "Loading..." freeze was caused
      // by a browser holding onto a SyntaxError-laden HTML that my fix
      // had already replaced on the server.  File is ~48KB so revalidate
      // cost is negligible.
      const html = readFileSync(join(SCRIPT_DIR, 'vcontext-dashboard.html'), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      res.end(html);
    } else {
      sendJson(res, 404, {
        error: 'Not found',
        endpoints: ENDPOINTS_LIST,
      });
    }
  } catch (e) {
    console.error(`[${method} ${path}]`, e.message);
    // Client-side errors vs server errors.  readBody throws typed messages
    // that should surface as 4xx, not 5xx (smoke test caught this).
    const msg = e.message || 'Internal error';
    if (/invalid json body|body > \d+ bytes/i.test(msg)) {
      sendJson(res, 400, { error: msg });
    } else {
      sendJson(res, 500, { error: msg });
    }
  }
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  handleWsUpgrade(req, socket);
});

// ── Lifecycle ──────────────────────────────────────────────────

// Ensure RAM disk + DB exist
ensureRamDisk();

// Rotate entries-wal.jsonl if oversized (keep last 3 generations: .1, .2, .3)
try {
  const fs = require('node:fs');
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(ENTRIES_WAL_PATH) && fs.statSync(ENTRIES_WAL_PATH).size > ENTRIES_WAL_MAX_BYTES) {
    // shift .2 → .3, .1 → .2, current → .1
    for (let i = 3; i >= 1; i--) {
      const src = `${ENTRIES_WAL_PATH}.${i}`;
      const dst = `${ENTRIES_WAL_PATH}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i === 3) { try { fs.unlinkSync(src); } catch {} } // drop oldest
        else { try { fs.renameSync(src, dst); } catch {} }
      }
    }
    fs.renameSync(ENTRIES_WAL_PATH, `${ENTRIES_WAL_PATH}.1`);
    console.log(`[startup] Rotated entries-wal.jsonl`);
  }
} catch (e) { console.error('[startup] WAL rotate:', e.message?.slice(0, 60)); }

// 2026-04-20 Stage 3 boot-time sweep: clear any backup-tmp orphans.
// Reviewer agent found a 5.28 GB .tmp file on disk that survived a
// server restart — no existing code path cleans it. Without this sweep
// the orphan sits forever, and worst-case (see morning's 28 GB WAL
// incident) grows through subsequent failed cycles. Two tmp-family
// prefixes to cover: ".tmp" (server/admin endpoint's) and ".ext-tmp"
// (external LaunchAgent's — cleaned by the script itself in normal
// cycles, but if that was mid-write and killed, we mop here too).
try {
  const BACKUP_TMP = BACKUP_PATH + '.tmp';
  const EXT_TMP = BACKUP_PATH + '.ext-tmp';
  let sweptBytes = 0;
  for (const base of [BACKUP_TMP, EXT_TMP]) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = base + suffix;
      try {
        const sz = statSync(p).size;
        require('node:fs').unlinkSync(p);
        sweptBytes += sz;
      } catch { /* not present — fine */ }
    }
  }
  if (sweptBytes > 0) {
    console.log(`[startup] swept backup-tmp orphans: ${(sweptBytes/1024/1024).toFixed(1)} MB`);
  }
} catch (e) { console.error('[startup] backup-tmp sweep:', e.message?.slice(0, 60)); }

// Open in-process SQLite connections (must precede schema migrations)
try { openDatabases(); } catch (e) { console.error('[startup] openDatabases:', e.message?.slice(0, 60)); }

// Startup tasks — each wrapped to prevent crash on memory pressure
try { migrateRamSchema(); } catch (e) { console.error('[startup] migrateRamSchema:', e.message?.slice(0, 60)); }
try { ensureSsdDb(); } catch (e) { console.error('[startup] ensureSsdDb:', e.message?.slice(0, 60)); }
// Open ssdDb if ensureSsdDb just created the file (was null at openDatabases time)
if (!ssdDb && existsSync(SSD_DB_PATH)) {
  try {
    ssdDb = new Database(SSD_DB_PATH);
    ssdDb.pragma('journal_mode = WAL');
    ssdDb.pragma('busy_timeout = 5000');
  } catch (e) { console.error('[startup] ssdDb late-open:', e.message?.slice(0, 60)); }
}
try { ensureConsultationsTable(); } catch (e) { console.error('[startup] ensureConsultationsTable:', e.message?.slice(0, 60)); }
try { restoreRamFromSsd(); } catch (e) { console.error('[startup] restoreRamFromSsd:', e.message?.slice(0, 60)); }
try { initVecDb(); if (vecDb) vecSync(); } catch (e) { console.error('[startup] initVecDb:', e.message?.slice(0, 60)); }

// Periodic backup + migration check (replaces plain backup timer)
const backupTimer = setInterval(doBackupAndMigrate, BACKUP_INTERVAL_MS);

// Fast entries-only sync (raw data is irreplaceable — minimize loss window from 5min→1min)
// This ONLY runs the cheap entries-gap sync, not the full backup/migrate/embedding cycle.
const RAW_SYNC_INTERVAL_MS = 60 * 1000; // 1 minute
const rawSyncTimer = setInterval(() => {
  try { syncRamToSsd(); } catch (e) { console.error('[vcontext:raw-sync]', e.message?.slice(0, 80)); }
}, RAW_SYNC_INTERVAL_MS);

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[vcontext] Received ${signal}, shutting down...`);
  clearInterval(backupTimer);
  clearInterval(rawSyncTimer);
  // Close all WebSocket connections
  for (const [id, client] of wsClients) {
    try { client.socket.destroy(); } catch {}
  }
  wsClients.clear();
  // Synchronous backup on shutdown (doBackup is async now, so use copyFileSync directly)
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (existsSync(DB_PATH)) {
      copyFileSync(DB_PATH, BACKUP_PATH);
      console.log('[vcontext] Shutdown backup (file copy) complete');
    }
  } catch (e) { console.error('[vcontext] Shutdown backup failed:', e.message); }
  embedLoopRunning = false;
  discoveryLoopRunning = false;
  if (vecDb) { try { vecDb.close(); } catch {} }
  if (ramDb) { try { ramDb.close(); } catch {} }
  if (ssdDb) { try { ssdDb.close(); } catch {} }
  server.close(() => {
    console.log('[vcontext] Server closed');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process-level safety nets — today's audit showed no unhandledRejection
// handler, which correlates with several exit-137 crashes via async errors
// escaping setImmediate(async...) callbacks (auto-summarize, auto-embed,
// auto-conflict-detect). Log and swallow rather than crash the server.
process.on('unhandledRejection', (reason, promise) => {
  const msg = (reason && reason.message) || String(reason);
  console.error('[unhandledRejection]', msg?.slice(0, 200));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message?.slice(0, 200));
  console.error(err?.stack?.split('\n').slice(0, 5).join('\n'));
  // Don't exit — let the event loop continue. If state is corrupt the
  // next request will surface the real issue more precisely.
});

// Check local AI availability + start background loops
// 2026-04-18: Always start the embed loop regardless of initial probe
// result. The loop has an internal `!mlxAvailable` guard that awaits
// checkMlx() and retries every 60s until MLX comes up. Previously, a
// concurrent restart where MLX was still booting when vcontext started
// left mlxAvailable=false and the loop was never started — forcing a
// wait for the 5-min self-heal cycle (which itself had an await bug).
checkMlx().then(() => {
  startEmbedLoop().catch(() => {});
}).catch(() => {
  // Even if the probe throws, start the loop — its internal retry
  // handles MLX unavailability gracefully.
  startEmbedLoop().catch(() => {});
});
checkMlxGenerate().then(() => {
  if (mlxGenerateAvailable) {
    startDiscoveryLoop().catch(() => {});
    console.log('[discovery] Loop started (MLX generate available)');
    startChunkSummaryLoop().catch(() => {});
    console.log('[chunk-summary] Loop started (MLX generate available)');
    startChunkSummaryL2Loop().catch(() => {});
    console.log('[chunk-summary-l2] Loop started (30-min cadence, daily summaries)');
    startChunkSummaryL3Loop().catch(() => {});
    console.log('[chunk-summary-l3] Loop started (60-min cadence, weekly summaries)');
  }
}).catch(() => {});

// Start — default 127.0.0.1 for safety, set VCONTEXT_BIND=0.0.0.0 for LAN.
const BIND_HOST = process.env.VCONTEXT_BIND || '127.0.0.1';

// Pillar 3: kick off OTEL SDK. initOtel() is idempotent and noop-safe when
// LANGFUSE_HOST is unset; we await it here so the first request already
// sees the active exporter (not strictly required — getTracer() returns
// noop until _ready flips — but cleaner log ordering).
initOtel().then(enabled => {
  if (enabled) console.log('[vcontext] OTEL tracing -> Langfuse (Pillar 3)');
}).catch(() => {});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[vcontext] Virtual Context server running at http://${BIND_HOST}:${PORT}`);
  console.log(`[vcontext] Tier 1 (RAM):   ${DB_PATH}`);
  console.log(`[vcontext] Tier 2 (SSD):   ${SSD_DB_PATH}`);
  console.log(`[vcontext] Tier 3 (Cloud): ${cloudStore.isConfigured() ? 'configured' : 'not configured'}`);
  console.log(`[vcontext] Backup every ${BACKUP_INTERVAL_MS / 1000}s to ${BACKUP_PATH}`);
  console.log(`[vcontext] Auto-migrate: RAM→SSD after ${RAM_TO_SSD_DAYS}d, SSD→Cloud after ${SSD_TO_CLOUD_DAYS}d`);
  console.log(`[vcontext] WebSocket:   ws://127.0.0.1:${PORT}/ws`);
  console.log('[vcontext] Endpoints:');
  for (const ep of ENDPOINTS_LIST) {
    console.log(`  ${ep}`);
  }
});
