#!/usr/bin/env node
/**
 * embedding-blob-to-json.mjs
 *
 * REVERSE of embedding-json-to-blob.mjs — convert binary Float32 BLOBs
 * in `entries.embedding` back to JSON-text arrays. Used for rollback if
 * the BLOB migration has to be undone (e.g. a reader-side bug surfaces
 * after deploy).
 *
 * Target column: `entries.embedding` in:
 *   - ~/skills/data/vcontext-primary.sqlite
 *   - ~/skills/data/vcontext-ssd.db     (if present)
 *
 * Safety properties:
 *   - IDEMPOTENT: detects already-TEXT rows (typeof === 'text') and skips.
 *   - VALIDATES: BLOB byteLength must equal EXPECTED_DIM * 4 before
 *     decode; rows with wrong size are logged and skipped.
 *   - NO DDL / NO SERVER INTERACTION: same constraints as forward script.
 *
 * Usage:
 *   node scripts/migrations/embedding-blob-to-json.mjs
 *   VCTX_DB_PATH=/tmp/test.sqlite node scripts/migrations/embedding-blob-to-json.mjs
 *
 * Exit code: 0 on success, non-zero on any UPDATE error.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EXPECTED_DIM = 4096;
const EXPECTED_BLOB_BYTES = EXPECTED_DIM * 4; // 16384
const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 5000;

const DEFAULT_PRIMARY = join(homedir(), 'skills', 'data', 'vcontext-primary.sqlite');
const DEFAULT_SSD = join(homedir(), 'skills', 'data', 'vcontext-ssd.db');

const PRIMARY_DB_PATH = process.env.VCTX_DB_PATH || DEFAULT_PRIMARY;
const SSD_DB_PATH = process.env.VCTX_SSD_DB_PATH || DEFAULT_SSD;

/**
 * Migrate one DB file from Float32 BLOBs back to JSON-text embeddings.
 * Returns { converted, skippedAlreadyText, skippedBadLength, errors }.
 */
function migrateDb(dbPath) {
  console.log(`\n[rollback] Opening ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const totalRow = db.prepare(
    "SELECT count(*) AS c FROM entries WHERE embedding IS NOT NULL;"
  ).get();
  const total = totalRow?.c || 0;
  console.log(`[rollback] Non-NULL embedding rows: ${total}`);

  if (total === 0) {
    db.close();
    return { converted: 0, skippedAlreadyText: 0, skippedBadLength: 0, errors: 0 };
  }

  const selectBatch = db.prepare(
    `SELECT id, embedding, typeof(embedding) AS etype
       FROM entries
      WHERE embedding IS NOT NULL
        AND id > ?
        AND typeof(embedding) = 'blob'
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE};`
  );
  const updateStmt = db.prepare(`UPDATE entries SET embedding = ? WHERE id = ?;`);

  const alreadyTextRow = db.prepare(
    "SELECT count(*) AS c FROM entries WHERE embedding IS NOT NULL AND typeof(embedding) = 'text';"
  ).get();
  const alreadyText = alreadyTextRow?.c || 0;
  if (alreadyText > 0) {
    console.log(`[rollback] ${alreadyText} rows already TEXT (will be skipped)`);
  }

  let converted = 0;
  let skippedBadLength = 0;
  let errors = 0;
  let lastId = 0;

  while (true) {
    const batch = selectBatch.all(lastId);
    if (batch.length === 0) break;

    const tx = db.transaction((rows) => {
      for (const row of rows) {
        lastId = row.id;
        if (row.etype !== 'blob') continue;

        const buf = row.embedding; // Buffer from better-sqlite3
        if (!Buffer.isBuffer(buf) || buf.byteLength !== EXPECTED_BLOB_BYTES) {
          skippedBadLength++;
          console.log(`[rollback] skip id=${row.id} reason=wrong-bytes size=${buf?.byteLength ?? 'not-buffer'}`);
          continue;
        }

        // Decode: view the Buffer bytes as a Float32Array. Note: Node
        // Buffer may share memory with a larger pool, so we use
        // buf.buffer + buf.byteOffset + buf.byteLength explicitly.
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, EXPECTED_DIM);
        // Array.from copies; the JSON output must not be tied to the
        // pool-backed ArrayBuffer after the transaction commits.
        const arr = Array.from(f32);
        const jsonStr = JSON.stringify(arr);

        try {
          updateStmt.run(jsonStr, row.id);
          converted++;
        } catch (e) {
          errors++;
          console.error(`[rollback] UPDATE FAILED id=${row.id}: ${e.message}`);
          throw e;
        }
      }
    });

    try {
      tx(batch);
    } catch (e) {
      console.error(`[rollback] Batch transaction aborted (lastId=${lastId}): ${e.message}`);
      db.close();
      return { converted, skippedAlreadyText: alreadyText, skippedBadLength, errors };
    }

    if (converted > 0 && converted % PROGRESS_EVERY < batch.length) {
      console.log(`[rollback] Converted ${converted} / ${total}`);
    }
  }

  const post = db.prepare(
    `SELECT typeof(embedding) AS etype, count(*) AS c
       FROM entries WHERE embedding IS NOT NULL
      GROUP BY etype;`
  ).all();
  console.log(`[rollback] Post-run storage distribution:`);
  for (const p of post) console.log(`  ${p.etype}: ${p.c}`);

  db.close();
  return { converted, skippedAlreadyText: alreadyText, skippedBadLength, errors };
}

// ── Main ────────────────────────────────────────────────
let globalErrors = 0;

if (!existsSync(PRIMARY_DB_PATH)) {
  console.error(`[rollback] Primary DB not found: ${PRIMARY_DB_PATH}`);
  process.exit(2);
}
const primaryResult = migrateDb(PRIMARY_DB_PATH);
console.log(`[rollback] Primary summary: converted=${primaryResult.converted} already-text=${primaryResult.skippedAlreadyText} bad-length=${primaryResult.skippedBadLength} errors=${primaryResult.errors}`);
globalErrors += primaryResult.errors;

if (existsSync(SSD_DB_PATH)) {
  const ssdResult = migrateDb(SSD_DB_PATH);
  console.log(`[rollback] SSD summary: converted=${ssdResult.converted} already-text=${ssdResult.skippedAlreadyText} bad-length=${ssdResult.skippedBadLength} errors=${ssdResult.errors}`);
  globalErrors += ssdResult.errors;
} else {
  console.log(`[rollback] SSD DB not found at ${SSD_DB_PATH} — skipping`);
}

if (globalErrors > 0) {
  console.error(`[rollback] FAILED with ${globalErrors} UPDATE errors`);
  process.exit(1);
}
console.log(`[rollback] OK`);
process.exit(0);
