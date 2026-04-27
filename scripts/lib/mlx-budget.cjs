'use strict';
/**
 * mlx-budget.js — Token-budget allocator for mlxGenerate.
 *
 * W11' Phase 2.5 P0 (spec docs/specs/2026-04-27-aios-os-policy.md AC-B2, B3).
 *
 * Tracks per-caller-kind token consumption in a sliding 1-minute window.
 * Callers `await acquire(kind, tokens, opts)` before issuing an MLX call;
 * receive a release() function to call on completion (success or failure).
 *
 * If `policy.mlx.tokens_per_min` is null (the default), there is no cap
 * — acquire always succeeds — but the in-flight ledger is still maintained
 * so /ai/status can surface aggregate consumption and per-kind breakdown.
 *
 * If a cap is configured AND would be exceeded, acquire throws an Error
 * with `code === 'BUDGET_EXCEEDED'` and `retryAfterSec` set to the window
 * duration in seconds. Per AC-B3, no silent queueing beyond the existing
 * _MLX_QUEUE_MAX cap in the dispatcher.
 *
 * Standing directive: maxTokens=40960 per lesson-learned id=229441/229438.
 * The budget RESERVES the maximum possible (40960 by default) so that
 * worst-case completions cannot retroactively exceed the per-minute cap.
 */

const policy = require('./aios-policy.cjs');

const _windowMs = 60_000; // 1 min sliding window
const _events = []; // [{ at: ts, kind, tokens, released: bool }]

function _prune(now) {
  const cutoff = now - _windowMs;
  while (_events.length > 0 && _events[0].at < cutoff) _events.shift();
}

function _aggregate(kind = null) {
  const now = Date.now();
  _prune(now);
  let total = 0;
  for (const e of _events) {
    if (e.released) continue;
    if (kind == null || e.kind === kind) total += e.tokens;
  }
  return total;
}

/**
 * Acquire budget for an MLX call.
 * @param {string} kind caller-kind, e.g. 'discovery', 'auto-trigger'
 * @param {number} tokens token count being requested (typically maxTokens)
 * @param {object} [opts]
 * @param {number} [opts.budgetPerMin] override per-min cap
 *   (default: policy.mlx.tokens_per_min, or null = unlimited)
 * @returns {Promise<() => void>} release function — MUST be called when done
 * @throws {Error} with code='BUDGET_EXCEEDED', retryAfterSec set
 */
async function acquire(kind, tokens, opts = {}) {
  const cap = opts.budgetPerMin || policy.get('mlx.tokens_per_min', null);
  if (cap != null) {
    const current = _aggregate();
    if (current + tokens > cap) {
      const err = new Error(
        `mlx budget exceeded: ${current}+${tokens} > ${cap} per ${_windowMs / 1000}s`,
      );
      err.code = 'BUDGET_EXCEEDED';
      err.retryAfterSec = Math.ceil(_windowMs / 1000);
      throw err;
    }
  }
  const event = { at: Date.now(), kind, tokens, released: false };
  _events.push(event);
  return () => {
    event.released = true;
  };
}

/**
 * Snapshot of in-flight budget for /ai/status surfacing.
 * @returns {{total_in_flight_tokens:number, cap:number|null,
 *            by_kind:Object<string,number>, window_ms:number,
 *            in_flight_count:number}}
 */
function status() {
  const now = Date.now();
  _prune(now);
  const byKind = {};
  let inFlightCount = 0;
  for (const e of _events) {
    if (e.released) continue;
    byKind[e.kind] = (byKind[e.kind] || 0) + e.tokens;
    inFlightCount += 1;
  }
  return {
    total_in_flight_tokens: _aggregate(),
    cap: policy.get('mlx.tokens_per_min', null),
    by_kind: byKind,
    window_ms: _windowMs,
    in_flight_count: inFlightCount,
  };
}

module.exports = { acquire, status, _events_for_test: _events };
