// scripts/workers/verify-snapshot.mjs — Stage 4.5 C5
//
// Worker thread runner for /admin/verify-backup's per-snapshot
// integrity_check + schema probe. The main thread spawns one of
// these, posts workerData={snapDir,maxFiles}, and receives a single
// postMessage with {ok, results|error} when done.
//
// Why a worker: better-sqlite3 operations (PRAGMA integrity_check,
// SELECT COUNT(*) FROM entries) are synchronous. On a 6.7 GB snapshot
// each integrity_check blocks Node for multi-seconds. Doing that 10×
// inline in the server event loop stalled /health for ~20 s — the
// exact failure mode spec §AC-4 calls out.
//
// Inside this worker each snapshot still blocks *this thread's* loop,
// but the main Node event loop stays free to serve /health, /recall,
// /store, etc. When the worker finishes, the main thread resumes its
// handler via the resolved Promise.
//
// better-sqlite3 is documented to be safe in worker threads as long as
// each Database instance is bound to its thread — we only open probe
// DBs inside the worker, never share handles with the main thread.

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const { snapDir, maxFiles } = workerData;

function verify(snapDir, maxFiles) {
  const files = fs
    .readdirSync(snapDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse();
  if (files.length === 0) {
    return { files: 0, results: [] };
  }

  const results = [];
  for (const f of files.slice(0, maxFiles)) {
    const fullPath = path.join(snapDir, f);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      results.push({
        snapshot: f,
        size_mb: 0,
        age_hours: 0,
        integrity: 'stat_error: ' + e.message.slice(0, 50),
        entry_count: 0,
        schema_ok: false,
        status: 'fail',
      });
      continue;
    }
    const ageHours = (Date.now() - stat.mtimeMs) / 1000 / 3600;

    let integrity = 'unknown';
    let entryCount = 0;
    let schemaOk = false;
    try {
      const probe = new Database(fullPath, { readonly: true });
      try {
        const ok = probe.prepare('PRAGMA integrity_check').get();
        integrity = ok.integrity_check === 'ok' ? 'ok' : ok.integrity_check;
        const cnt = probe.prepare('SELECT COUNT(*) AS c FROM entries').get();
        entryCount = cnt.c | 0;
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name);
        schemaOk = tables.includes('entries') && tables.includes('entries_fts');
      } finally {
        probe.close();
      }
    } catch (e) {
      integrity = 'error: ' + e.message.slice(0, 50);
    }

    results.push({
      snapshot: f,
      size_mb: Math.round(stat.size / 1024 / 1024),
      age_hours: Math.round(ageHours * 10) / 10,
      integrity,
      entry_count: entryCount,
      schema_ok: schemaOk,
      status: integrity === 'ok' && schemaOk ? 'pass' : 'fail',
    });
  }

  return { files: files.length, results };
}

try {
  const out = verify(snapDir, maxFiles | 0 || 10);
  parentPort.postMessage({ ok: true, ...out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
