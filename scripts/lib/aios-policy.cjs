'use strict';
/**
 * aios-policy.js — Synchronous reader for config/aios-policy.json.
 *
 * W11' Phase 2.5 P0 (spec docs/specs/2026-04-27-aios-os-policy.md AC-H1).
 *
 * Loads the OS-layer policy file once at module require time and caches it.
 * Exposes `get(dotPath, fallback)` for safe nested-key reads. If the file
 * is missing or unparseable, falls back to a hard-coded minimal default
 * (mlx.max_concurrency=1, mlx.max_tokens_default=40960, mlx.queue_max=6)
 * so that the server never crashes on a missing/corrupt config.
 *
 * Standing directive: mlx.max_tokens_default=40960
 *   Source: vcontext lesson-learned id=229441/229438; user directive 2026-04-23.
 *   Reductions require `acknowledged_directive: id=229441` per AC-B4.
 */

const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', '..', 'config', 'aios-policy.json');
let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
  } catch (e) {
    console.error('[aios-policy] load failed, using defaults:', e.message);
    _cache = {
      version: 0,
      mlx: { max_concurrency: 1, max_tokens_default: 40960, queue_max: 6 },
    };
  }
  return _cache;
}

/**
 * Get a policy value by dot-separated path.
 * @param {string} dotPath e.g. 'mlx.max_concurrency'
 * @param {*} [fallback] returned if path missing
 * @returns {*} the value at dotPath, or fallback
 */
function get(dotPath, fallback = undefined) {
  const parts = dotPath.split('.');
  let cur = load();
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

/**
 * Drop the cache and re-read the policy file. Useful for tests and
 * for operators who want to hot-reload policy without restarting.
 * @returns {object} the freshly-loaded policy object
 */
function reload() {
  _cache = null;
  return load();
}

module.exports = { get, reload, _path: POLICY_PATH };
