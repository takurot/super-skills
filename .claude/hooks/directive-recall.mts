#!/usr/bin/env node
/**
 * directive-recall.mts — M7 phase 2 (nudge mode) PreToolUse hook
 *
 * Spec:
 *   - Parent: docs/specs/2026-04-27-aios-os-policy.md (AC-F1, F2, F3, B4)
 *   - Sibling: docs/handoff/2026-04-23-aios-self-steering-spec.md (M7 §lines 70-119)
 *   - Constitution: P3 fail-open (infra errors → allow), P6 observe-before-act
 *
 * Why this hook exists:
 *   2026-04-27 session reproduced the W1 anti-pattern for the THIRD time —
 *   8 callers of `mlxGenerate(..., maxTokens=40960)` were silently reduced
 *   to 600/1000/2000 by a "memory pressure fix" review, in violation of
 *   standing directive id=229441/229438 ("maxTokens=40960 は品質保持の意図的設計").
 *   User caught + W1-REVERT restored 40960. This hook catches the 4th occurrence
 *   at PreToolUse time by inspecting Edit/Write/NotebookEdit diffs for
 *   numerical config-value changes and querying vcontext lesson-learned/decision
 *   entries tagged with directive markers.
 *
 * Phase contract (per spec §2.4):
 *   - Phase 1 (shadow):  log only, never alter output
 *   - Phase 2 (nudge):   inject system-reminder via hookSpecificOutput.additionalContext
 *                        — DO NOT block (continue stays true)
 *   - Phase 3 (gate):    block unless caller has acknowledged_directive: id=N tag
 *
 * Runtime: Node 25+ strips types natively. Node 22-24 needs --experimental-strip-types.
 *
 * Reversibility (Constitution P5): delete this file + revert settings.json entry.
 */

import { request } from 'node:http';
import { writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────
// Section A — Configuration
// ─────────────────────────────────────────────────────────────────────

const VCONTEXT_PORT = process.env['VCONTEXT_PORT'] ?? '3150';
const VCTX_URL_RAW  = process.env['VCTX_URL'] ?? `http://127.0.0.1:${VCONTEXT_PORT}`;
const VCTX_URL      = VCTX_URL_RAW.replace(/\/+$/, '');

// Per task spec: hook budget is conceptually <100ms, but HTTP RTT to vcontext
// is realistically 50-300ms — and under MLX/embed load the SQLite query path
// can spike to 1-2s. 2500ms is the absolute cap; on timeout we fail-open (P3).
// Override via env DIRECTIVE_RECALL_TIMEOUT_MS for tuning under sustained load.
const RECALL_TIMEOUT_MS = parseInt(
  process.env['DIRECTIVE_RECALL_TIMEOUT_MS'] ?? '2500',
  10,
) || 2500;
const STORE_TIMEOUT_MS  = 1500;

const ERROR_LOG = '/tmp/directive-recall-errors.jsonl';
const DEBUG_LOG = '/tmp/directive-recall-debug.jsonl';

// Claude Code mutate-file tools (Q3 A' tool-category from sibling spec).
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// Identifiers we treat as "config-like" — narrow whitelist, not a denylist.
// Includes both snake_case and camelCase forms; matched case-insensitively
// against the captured identifier. False-positive guard: ports, lengths,
// indices, IDs are NOT here. (See task spec §4 step "exclude obvious non-config".)
const CONFIG_IDENTIFIERS = [
  // primary M7 target
  'max_tokens', 'maxtokens',
  // sibling categories enumerated in task spec §4 + sibling-spec M7
  'heap_size', 'heapsize', 'heap',
  'timeout', 'timeoutms', 'timeout_ms',
  'mmap_size', 'mmapsize', 'mmap',
  'batch_size', 'batchsize',
  'concurrency', 'max_concurrency', 'maxconcurrency',
  'cache_size', 'cachesize', 'cache_max', 'cachemax',
  'retention_days', 'retentiondays',
  'mtu',
];

// Markers identifying an entry as a standing directive (any one is enough).
// `directive` is the spec §2.2 canonical tag; the historical entries
// (id=229441/229438) actually use `design-intent`+`quality-preserving`+
// `max-tokens` — accept all forms so existing data still triggers the hook.
const DIRECTIVE_TAGS = new Set([
  'directive',
  'design-intent',
  'value-preservation',
  'quality-preserving',
]);

// Types that can carry a directive (lesson-learned, decision, design-doc).
const DIRECTIVE_TYPES = new Set(['lesson-learned', 'decision', 'design-doc']);

// ─────────────────────────────────────────────────────────────────────
// Section B — Types
// ─────────────────────────────────────────────────────────────────────

type IdentifierCandidate = {
  identifier: string;
  value: number;
  // The matched substring, for snippet context in the warning.
  source_snippet: string;
};

type DirectiveMatch = {
  identifier: string;
  attempted_value: number;
  directive_value: number;
  directive_id: number;
  snippet: string;
  matched_lesson_ids: number[];
};

type RecallEntry = {
  id: number;
  type?: string;
  tags?: string[] | string;
  content?: string;
  rank?: number;
};

type RecallResponse = {
  results?: RecallEntry[];
};

type Warning = {
  kind: 'directive_match';
  identifier: string;
  attempted_value: number;
  directive_value: number;
  directive_id: number;
  snippet: string;
  action_required: 'acknowledge or override with reasoning';
};

type HookOutput = {
  allowed: true;
  warnings: Warning[];
  // Claude Code wire-format: anything in hookSpecificOutput.additionalContext
  // is injected as a system-reminder visible to the agent. continue:true
  // (default) means the tool is NOT blocked — we are in nudge mode.
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    additionalContext: string;
  };
};

// ─────────────────────────────────────────────────────────────────────
// Section C — Logging (best-effort; failure must never block)
// ─────────────────────────────────────────────────────────────────────

function log(file: string, entry: Record<string, unknown>): void {
  try {
    writeFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      { flag: 'a' }
    );
  } catch { /* swallow */ }
}

function debugLog(entry: Record<string, unknown>): void {
  if (process.env['DIRECTIVE_RECALL_DEBUG'] === '1') log(DEBUG_LOG, entry);
}

function errorLog(kind: string, detail: unknown): void {
  log(ERROR_LOG, { kind, detail: detail instanceof Error ? detail.message : detail });
}

// ─────────────────────────────────────────────────────────────────────
// Section D — Stdin reading
// ─────────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
    // Safety timeout — Claude Code always closes stdin, but be defensive.
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf-8')), 1200);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Section E — HTTP helpers (fail-open)
// ─────────────────────────────────────────────────────────────────────

function httpGet(url: string, timeoutMs: number): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, body: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, body });
    };
    try {
      const req = request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end',  () => finish((res.statusCode ?? 0) < 500, Buffer.concat(chunks).toString()));
      });
      req.on('error',   () => finish(false, ''));
      req.on('timeout', () => { req.destroy(); finish(false, ''); });
      req.end();
    } catch { finish(false, ''); }
  });
}

function httpPost(url: string, payload: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const body = JSON.stringify(payload);
      const req = request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      }, (res) => { res.resume(); res.on('end', finish); });
      req.on('error',   finish);
      req.on('timeout', () => { req.destroy(); finish(); });
      req.write(body);
      req.end();
    } catch { finish(); }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Section F — Identifier extraction from diff/content
// ─────────────────────────────────────────────────────────────────────
//
// Three regex passes cover the common shapes:
//   1. `name: 40960`            (object literal, YAML, kwargs)
//   2. `name = 40960`           (assignment)
//   3. `'NAME' || '40960'`      (env-var fallback idiom)
//   4. `"max_tokens": 40960`    (JSON-literal — covered by pass 1's quote-tolerant variant)
//
// Pass criteria: identifier must be in CONFIG_IDENTIFIERS (case-insensitive,
// underscores/camel matched). Value must be a positive integer 1-9 digits
// (avoid catching version strings, hashes, timestamps).

const RE_KV   = /(?<![\w])([A-Za-z_][A-Za-z0-9_]{2,32})\s*[:=]\s*(\d{1,9})\b/g;
const RE_ENV  = /['"]([A-Z][A-Z0-9_]{2,32})['"]\s*\|\|\s*['"](\d{1,9})['"]/g;
const RE_JSON = /["']([A-Za-z_][A-Za-z0-9_]{2,32})["']\s*:\s*(\d{1,9})\b/g;

function normalizeIdentifier(raw: string): string {
  // Lowercase + strip underscores/dashes for whitelist comparison.
  return raw.toLowerCase().replace(/[_-]/g, '');
}

function isConfigIdentifier(raw: string): boolean {
  const norm = normalizeIdentifier(raw);
  for (const id of CONFIG_IDENTIFIERS) {
    if (normalizeIdentifier(id) === norm) return true;
  }
  return false;
}

function extractCandidates(text: string): IdentifierCandidate[] {
  if (!text || text.length < 5) return [];
  const candidates: IdentifierCandidate[] = [];
  const seen = new Set<string>();

  const tryRegex = (re: RegExp) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const ident = m[1];
      const valStr = m[2];
      if (!ident || !valStr) continue;
      if (!isConfigIdentifier(ident)) continue;
      const value = parseInt(valStr, 10);
      if (!Number.isFinite(value) || value <= 0) continue;
      const key = `${normalizeIdentifier(ident)}=${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Snippet: 60 chars of surrounding context.
      const start = Math.max(0, m.index - 20);
      const end   = Math.min(text.length, m.index + m[0].length + 20);
      candidates.push({
        identifier: ident,
        value,
        source_snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
    }
  };

  tryRegex(RE_KV);
  tryRegex(RE_ENV);
  tryRegex(RE_JSON);

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────
// Section G — Tool-input → text-to-scan extraction
// ─────────────────────────────────────────────────────────────────────

type ToolName = 'Edit' | 'Write' | 'NotebookEdit' | 'MultiEdit' | string;

function extractScanText(toolName: ToolName, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Edit':
      return String(toolInput['new_string'] ?? '');
    case 'Write':
      return String(toolInput['content'] ?? '');
    case 'NotebookEdit':
      return String(toolInput['new_source'] ?? '');
    case 'MultiEdit': {
      const edits = toolInput['edits'];
      if (!Array.isArray(edits)) return '';
      return edits.map((e) => String((e as Record<string, unknown>)?.['new_string'] ?? '')).join('\n');
    }
    default:
      return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Section H — vcontext directive lookup
// ─────────────────────────────────────────────────────────────────────
//
// Strategy: query /recall with FTS-friendly q="<identifier> design-intent
// directive value", then post-filter to entries with a directive marker
// tag and a numeric value in content. Compare attempted_value to extracted
// directive_value: if they differ, that's a match.
//
// Why post-filter on the client instead of server-side tag query: the /recall
// endpoint does not support tag-equality filtering directly; tags are
// indexed via FTS, so q-words match them, but the FTS rank does NOT
// guarantee tag presence. We re-check tags client-side. This is one
// extra pass over ≤5 entries — well under budget.

function entryHasDirectiveMarker(entry: RecallEntry): boolean {
  const tags = parseTags(entry.tags).map((t) => t.toLowerCase());

  // Self-loop guard: never treat directive-recall events themselves as
  // directives. Otherwise the hook's own logged history becomes a
  // perpetual self-match for the same identifier.
  if (tags.includes('directive-recall-event')) return false;

  // Primary: explicit directive-marker tag.
  for (const t of tags) {
    if (DIRECTIVE_TAGS.has(t)) return true;
  }

  // Secondary fallback: type=decision/lesson-learned/design-doc with a
  // strong "intentional design" content signature. Tightened from prior
  // version (which over-matched on any 'directive' substring) to require
  // an explicit phrase that's only in genuine standing-directive entries.
  if (entry.type && DIRECTIVE_TYPES.has(entry.type)) {
    const c = String(entry.content ?? '');
    // Japanese: "意図的設計" / "意図的に設定" / "品質保持". English:
    // "intentional design", "standing directive", "do not lower / 軽率に下げない".
    if (
      c.includes('意図的設計')
      || c.includes('意図的に設定')
      || c.includes('品質保持')
      || c.includes('軽率に下げ')
      || /\bintentional\s+design\b/i.test(c)
      || /\bstanding\s+directive\b/i.test(c)
    ) {
      return true;
    }
  }
  return false;
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

// Pull the most likely "directive value" out of content. For id=229441 the
// content includes literally `maxTokens=40960`; for id=229438 same. Strategy:
// scan content with same identifier-extraction regex; pick the first
// occurrence whose identifier matches the candidate identifier.
function extractDirectiveValue(content: string, identifier: string): number | null {
  const cands = extractCandidates(content);
  const norm = normalizeIdentifier(identifier);
  for (const c of cands) {
    if (normalizeIdentifier(c.identifier) === norm) return c.value;
  }
  // Fallback: any 4-5 digit number after the identifier name in content
  // (loose match, last-resort).
  const re = new RegExp(`${identifier}[^0-9]{0,8}(\\d{2,9})`, 'i');
  const m  = re.exec(content);
  return m && m[1] ? parseInt(m[1], 10) : null;
}

// Build the queries per candidate. Empirical findings 2026-04-27:
//   - vcontext SQLite is single-threaded → parallel queries serialize.
//     1 query at a time = lower wall-clock under load.
//   - The current session's pre-tool/tool-use entries crowd out historical
//     directive entries when no `type` filter is applied (FTS rank rewards
//     freshness + content overlap with the actively-running session).
//   - With `type=decision`: q="<identifier> design-intent" reliably returns
//     id=229441/229438 in top-2 even under MLX load (verified live).
//   - With `type=lesson-learned`: same q targets the future-spec schema.
// Strategy: 2 sequential queries, ≤ ~300ms total typical, ~5s worst-case.
// Returned in the order we want to evaluate them; the consumer stops on
// the first match per candidate.
function queriesFor(identifier: string): string[] {
  const out: string[] = [];
  // Historical schema (id=229441/229438 are type=decision).
  out.push(
    `/recall?q=${encodeURIComponent(`${identifier} design-intent`)}&limit=8&type=decision`,
  );
  // Future schema per parent-spec §2.2.
  out.push(
    `/recall?q=${encodeURIComponent(`${identifier} directive`)}&limit=8&type=lesson-learned`,
  );
  return out;
}

async function findDirectiveMatches(cands: IdentifierCandidate[]): Promise<DirectiveMatch[]> {
  if (cands.length === 0) return [];
  const matches: DirectiveMatch[] = [];

  for (const cand of cands) {
    const queries = queriesFor(cand.identifier);

    // Sequential execution + early-exit on first directive match.
    // Rationale: vcontext SQLite is single-threaded; parallel queries
    // serialize anyway. Sequential lets us bail after the historical
    // schema (type=decision) hits, saving the second roundtrip.
    const seenIds = new Set<number>();
    const lessonIds: number[] = [];
    let firstMatch: DirectiveMatch | null = null;
    const tCandStart = Date.now();

    for (const path of queries) {
      const tQ = Date.now();
      const { ok, body } = await httpGet(`${VCTX_URL}${path}`, RECALL_TIMEOUT_MS);
      const dtQ = Date.now() - tQ;
      debugLog({ kind: 'recall_call', path, ok, dt_ms: dtQ });
      if (!ok || !body) continue;

      let parsed: RecallResponse;
      try { parsed = JSON.parse(body) as RecallResponse; }
      catch { continue; }
      const results = Array.isArray(parsed.results) ? parsed.results : [];

      for (const entry of results) {
        if (!entry || typeof entry.id !== 'number') continue;
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);

        if (!entryHasDirectiveMarker(entry)) continue;

        const directiveValue = extractDirectiveValue(
          String(entry.content ?? ''), cand.identifier,
        );
        if (directiveValue === null) continue;
        if (directiveValue === cand.value) continue; // values agree → no nudge

        lessonIds.push(entry.id);
        if (!firstMatch) {
          let snippet = String(entry.content ?? '');
          const titleMatch = /"(?:title|rule)"\s*:\s*"([^"]{5,200})"/i.exec(snippet);
          if (titleMatch && titleMatch[1]) {
            snippet = titleMatch[1];
          } else {
            snippet = snippet.replace(/\s+/g, ' ').slice(0, 200);
          }
          firstMatch = {
            identifier: cand.identifier,
            attempted_value: cand.value,
            directive_value: directiveValue,
            directive_id: entry.id,
            snippet,
            matched_lesson_ids: [entry.id],
          };
        }
      }

      // Early exit: once we have at least one match from this query,
      // skip remaining queries — they would only add to matched_lesson_ids
      // but the warning already carries the canonical directive.
      if (firstMatch) break;
    }

    debugLog({
      kind: 'candidate_done',
      identifier: cand.identifier,
      attempted_value: cand.value,
      matched: !!firstMatch,
      dt_ms: Date.now() - tCandStart,
    });

    if (firstMatch) {
      firstMatch.matched_lesson_ids = lessonIds;
      matches.push(firstMatch);
    }
  }

  return matches;
}

// ─────────────────────────────────────────────────────────────────────
// Section I — Output composition
// ─────────────────────────────────────────────────────────────────────

function buildAdditionalContext(matches: DirectiveMatch[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('[directive-recall] Standing directive(s) detected for value(s) you are about to write.');
  lines.push('Source: vcontext lesson-learned / decision entries tagged directive|design-intent.');
  lines.push('');
  for (const m of matches) {
    lines.push(`  - identifier=${m.identifier}`);
    lines.push(`    attempted_value=${m.attempted_value}  directive_value=${m.directive_value}`);
    lines.push(`    directive_id=${m.directive_id}  matched_ids=[${m.matched_lesson_ids.join(', ')}]`);
    lines.push(`    snippet: ${m.snippet}`);
  }
  lines.push('');
  lines.push('Action required: acknowledge with `acknowledged_directive: id=N; reason: <text>`');
  lines.push('OR revert the value to match the directive. Phase 2 = NUDGE only (not blocked).');
  lines.push('');
  return lines.join('\n');
}

function emitOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output) + '\n');
}

// ─────────────────────────────────────────────────────────────────────
// Section J — Best-effort vcontext logging (directive-recall-event)
// ─────────────────────────────────────────────────────────────────────

async function logRecallEvent(
  identifier: string,
  attemptedValue: number,
  matches: DirectiveMatch[],
): Promise<void> {
  const m0 = matches[0];
  const payload = {
    type: 'lesson-learned',
    content: JSON.stringify({
      kind: 'directive-recall-event',
      phase: 'nudge',
      identifier,
      attempted_value: attemptedValue,
      matched_lesson_ids: matches.flatMap((m) => m.matched_lesson_ids),
      directive_value: m0?.directive_value ?? null,
      directive_id:    m0?.directive_id ?? null,
      snippet:         m0?.snippet ?? null,
      session_id:      process.env['SESSION_ID'] ?? '',
      would_block:     true, // phase 3 would block; phase 2 nudge only
    }),
    tags: ['directive-recall-event', 'phase-2', identifier.toLowerCase()],
    session: process.env['SESSION_ID'] ?? 'directive-recall',
  };
  await httpPost(`${VCTX_URL}/store`, payload, STORE_TIMEOUT_MS);
}

// ─────────────────────────────────────────────────────────────────────
// Section K — Main
// ─────────────────────────────────────────────────────────────────────
//
// Contract:
//   Input  (stdin):  Claude Code PreToolUse JSON
//                    { tool_name, tool_input, session_id, ... }
//   Output (stdout): { allowed: true, warnings: [...], hookSpecificOutput? }
//   Exit code:       always 0 (fail-open per Constitution P3).
//   Side effects:    best-effort POST /store of directive-recall-event,
//                    optional debug log to /tmp/directive-recall-debug.jsonl.

async function main(): Promise<void> {
  const passthrough: HookOutput = { allowed: true, warnings: [] };

  let raw: string;
  try { raw = await readStdin(); }
  catch (e) { errorLog('stdin_read', e); emitOutput(passthrough); return; }

  if (!raw) { emitOutput(passthrough); return; }

  let payload: { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string };
  try { payload = JSON.parse(raw); }
  catch (e) { errorLog('payload_parse', e); emitOutput(passthrough); return; }

  const toolName = String(payload.tool_name ?? '');
  if (!MUTATE_TOOLS.has(toolName)) {
    debugLog({ kind: 'passthrough_non_mutate', tool_name: toolName });
    emitOutput(passthrough);
    return;
  }

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const text = extractScanText(toolName, toolInput);
  if (!text) { emitOutput(passthrough); return; }

  const cands = extractCandidates(text);
  debugLog({ kind: 'extract', tool_name: toolName, candidate_count: cands.length, candidates: cands });

  if (cands.length === 0) { emitOutput(passthrough); return; }

  let matches: DirectiveMatch[] = [];
  try {
    matches = await findDirectiveMatches(cands);
  } catch (e) {
    errorLog('directive_lookup', e);
    emitOutput(passthrough); // fail-open
    return;
  }

  if (matches.length === 0) {
    debugLog({ kind: 'no_match', candidates: cands.map((c) => `${c.identifier}=${c.value}`) });
    emitOutput(passthrough);
    return;
  }

  // Phase-2 nudge: build warnings + additionalContext, allowed:true.
  const warnings: Warning[] = matches.map((m) => ({
    kind: 'directive_match' as const,
    identifier: m.identifier,
    attempted_value: m.attempted_value,
    directive_value: m.directive_value,
    directive_id: m.directive_id,
    snippet: m.snippet,
    action_required: 'acknowledge or override with reasoning' as const,
  }));

  const out: HookOutput = {
    allowed: true,
    warnings,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: buildAdditionalContext(matches),
    },
  };

  // Best-effort log; do not await failure into the response budget.
  try {
    // Fire-and-forget — but we need to await briefly so the POST has a
    // chance before the process exits. STORE_TIMEOUT_MS already caps it.
    await logRecallEvent(matches[0]!.identifier, matches[0]!.attempted_value, matches);
  } catch (e) { errorLog('log_event', e); }

  emitOutput(out);
}

// ─────────────────────────────────────────────────────────────────────
// Entry point — never throw to the runtime (fail-open).
// ─────────────────────────────────────────────────────────────────────

main().catch((e) => {
  errorLog('uncaught', e);
  // Emit a passthrough so Claude Code doesn't kill the tool over a hook bug.
  try { process.stdout.write(JSON.stringify({ allowed: true, warnings: [] }) + '\n'); } catch { /* ignore */ }
  process.exit(0);
});
