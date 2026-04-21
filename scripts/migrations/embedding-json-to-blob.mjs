#!/usr/bin/env node
/**
 * embedding-json-to-blob.mjs
 *
 * Migrate `entries.embedding` from JSON-text (TEXT affinity, JSON-encoded
 * array of 4096 floats, ~42 KB/row) to binary BLOB (16 KB/row, Float32Array
 * contents). Saves ~2.6 GB at N=103,981 rows and eliminates JSON.parse on
 * the hot cosine-search path.
 *
 * Target column: `entries.embedding` in:
 *   - ~/skills/data/vcontext-primary.sqlite
 *   - ~/skills/data/vcontext-ssd.db     (if present)
 *   - ~/skills/data/vcontext-backup.sqlite (NOT touched by this script;
 *     backup is rebuilt from primary via doBackupAndMigrate)
 *
 * Safety properties:
 *   - IDEMPOTENT: detects already-BLOB rows (typeof === 'object') and skips.
 *   - VALIDATES: length must equal EXPECTED_DIM (4096) before convert;
 *     rows with wrong length or bad JSON are logged and skipped.
 *   - NO DDL: column stays TEXT-affinity; SQLite stores BLOBs in a TEXT
 *     column via type affinity rules (no schema change needed).
 *   - NO SERVER INTERACTION: call this while vcontext-server.js is
 *     stopped. Handles WAL via better-sqlite3's normal checkpoint.
 *
 * Usage:
 *   node scripts/migrations/embedding-json-to-blob.mjs
 *   VCTX_DB_PATH=/tmp/test.sqlite node scripts/migrations/embedding-json-to-blob.mjs
 *
 * Exit code: 0 on success, non-zero on any UPDATE error.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXPECTED_DIM = 4096;
const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 5000;

const DEFAULT_PRIMARY = join(homedir(), 'skills', 'data', 'vcontext-primary.sqlite');
const DEFAULT_SSD = join(homedir(), 'skills', 'data', 'vcontext-ssd.db');

const PRIMARY_DB_PATH = process.env.VCTX_DB_PATH || DEFAULT_PRIMARY;
const SSD_DB_PATH = process.env.VCTX_SSD_DB_PATH || DEFAULT_SSD;

/**
 * Migrate one DB file from JSON-text embeddings to Float32 BLOBs.
 * Returns { converted, skippedAlreadyBlob, skippedBadLength, skippedBadJson, errors }.
 */
function migrateDb(dbPath) {
  console.log(`\n[migrate] Opening ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Count total candidate rows (excludes NULL). "candidate" here means
  // embedding IS NOT NULL — we still need to inspect each to distinguish
  // TEXT vs BLOB at the value level (SQLite typeof() helps).
  const totalRow = db.prepare(
    "SELECT count(*) AS c FROM entries WHERE embedding IS NOT NULL;"
  ).get();
  const total = totalRow?.c || 0;
  console.log(`[migrate] Non-NULL embedding rows: ${total}`);

  if (total === 0) {
    db.close();
    return { converted: 0, skippedAlreadyBlob: 0, skippedBadLength: 0, skippedBadJson: 0, errors: 0 };
  }

  // Prepared statements
  // NOTE: we use typeof(embedding) to distinguish 'blob' from 'text'
  //       — SQLite reports the *storage class*, not just the declared
  //       affinity. Already-migrated rows return 'blob' and are skipped.
  const selectBatch = db.prepare(
    `SELECT id, embedding, typeof(embedding) AS etype
       FROM entries
      WHERE embedding IS NOT NULL
        AND id > ?
        AND typeof(embedding) = 'text'
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE};`
  );
  const updateStmt = db.prepare(`UPDATE entries SET embedding = ? WHERE id = ?;`);

  // Separate count of already-blob rows (idempotency report)
  const alreadyBlobRow = db.prepare(
    "SELECT count(*) AS c FROM entries WHERE embedding IS NOT NULL AND typeof(embedding) = 'blob';"
  ).get();
  const alreadyBlob = alreadyBlobRow?.c || 0;
  if (alreadyBlob > 0) {
    console.log(`[migrate] ${alreadyBlob} rows already BLOB (will be skipped)`);
  }

  let converted = 0;
  let skippedBadLength = 0;
  let skippedBadJson = 0;
  let errors = 0;
  let lastId = 0;

  // Wrap the whole pass in a series of small transactions — one per batch
  // — so a crash mid-run leaves a consistent DB and restart is idempotent.
  while (true) {
    const batch = selectBatch.all(lastId);
    if (batch.length === 0) break;

    const tx = db.transaction((rows) => {
      for (const row of rows) {
        lastId = row.id;
        // Defensive: etype must be 'text' (filter already enforces) but
        // double-check and skip if SQLite reported something unexpected.
        if (row.etype !== 'text') continue;

        let parsed;
        try {
          parsed = JSON.parse(row.embedding);
        } catch (e) {
          skippedBadJson++;
          console.log(`[migrate] skip id=${row.id} reason=bad-json (${e.message?.slice(0, 60)})`);
          continue;
        }

        if (!Array.isArray(parsed) || parsed.length !== EXPECTED_DIM) {
          skippedBadLength++;
          console.log(`[migrate] skip id=${row.id} reason=wrong-length len=${Array.isArray(parsed) ? parsed.length : 'not-array'}`);
          continue;
        }

        // Float32Array → Buffer view over the same underlying ArrayBuffer.
        // Buffer.from(ab) without offset/length uses the whole buffer,
        // which is exactly EXPECTED_DIM * 4 bytes = 16384 bytes for 4096 f32.
        const f32 = new Float32Array(parsed);
        const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

        try {
          updateStmt.run(buf, row.id);
          converted++;
        } catch (e) {
          errors++;
          console.error(`[migrate] UPDATE FAILED id=${row.id}: ${e.message}`);
          throw e; // abort this batch transaction so nothing partial commits
        }
      }
    });

    try {
      tx(batch);
    } catch (e) {
      console.error(`[migrate] Batch transaction aborted (lastId=${lastId}): ${e.message}`);
      db.close();
      return { converted, skippedAlreadyBlob: alreadyBlob, skippedBadLength, skippedBadJson, errors };
    }

    if (converted > 0 && converted % PROGRESS_EVERY < batch.length) {
      console.log(`[migrate] Converted ${converted} / ${total}`);
    }
  }

  // Post-run verification: count BLOBs vs TEXT.
  const post = db.prepare(
    `SELECT typeof(embedding) AS etype, count(*) AS c
       FROM entries WHERE embedding IS NOT NULL
      GROUP BY etype;`
  ).all();
  console.log(`[migrate] Post-run storage distribution:`);
  for (const p of post) console.log(`  ${p.etype}: ${p.c}`);

  db.close();
  return { converted, skippedAlreadyBlob: alreadyBlob, skippedBadLength, skippedBadJson, errors };
}

// ── Main ────────────────────────────────────────────────
let globalErrors = 0;

// 1. Primary
if (!existsSync(PRIMARY_DB_PATH)) {
  console.error(`[migrate] Primary DB not found: ${PRIMARY_DB_PATH}`);
  process.exit(2);
}
const primaryResult = migrateDb(PRIMARY_DB_PATH);
console.log(`[migrate] Primary summary: converted=${primaryResult.converted} already-blob=${primaryResult.skippedAlreadyBlob} bad-length=${primaryResult.skippedBadLength} bad-json=${primaryResult.skippedBadJson} errors=${primaryResult.errors}`);
globalErrors += primaryResult.errors;

// 2. SSD (if exists)
if (existsSync(SSD_DB_PATH)) {
  const ssdResult = migrateDb(SSD_DB_PATH);
  console.log(`[migrate] SSD summary: converted=${ssdResult.converted} already-blob=${ssdResult.skippedAlreadyBlob} bad-length=${ssdResult.skippedBadLength} bad-json=${ssdResult.skippedBadJson} errors=${ssdResult.errors}`);
  globalErrors += ssdResult.errors;
} else {
  console.log(`[migrate] SSD DB not found at ${SSD_DB_PATH} — skipping`);
}

if (globalErrors > 0) {
  console.error(`[migrate] FAILED with ${globalErrors} UPDATE errors`);
  process.exit(1);
}
console.log(`[migrate] OK`);
process.exit(0);
