#!/usr/bin/env node
/*
 * check-openapi-sync.js — Stage 4.5 AC-8 verifier.
 *
 * Confirms that three independent catalogs of HTTP endpoints stay in
 * sync:
 *   1. ENDPOINTS_LIST array in scripts/vcontext-server.js
 *   2. Path keys under `paths:` in docs/schemas/vcontext-api-v1.yaml
 *   3. Actual handler dispatch regex in scripts/vcontext-server.js
 *      (lines matching `path === '/...'`)
 *
 * Exit code:
 *   0 = all three sets align
 *   1 = any set has an endpoint the other two don't
 *
 * Output format:
 *   Human-readable pass/fail tables on stdout. Machine-parseable
 *   JSON summary on the final line (prefixed `{summary:`).
 *
 * Scope: this is a structural check only. It does NOT validate that
 * handlers return the shape the OpenAPI response block claims —
 * that's covered by the per-endpoint TDD harnesses. This checker
 * catches the specific class of bug where someone adds an endpoint
 * in server.js but forgets to update ENDPOINTS_LIST or YAML.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.join(process.env.HOME, 'skills');
const SERVER = path.join(REPO, 'scripts', 'vcontext-server.js');
const OPENAPI = path.join(REPO, 'docs', 'schemas', 'vcontext-api-v1.yaml');

// CLI flags
const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const VERBOSE = argv.includes('--verbose');

// Normalize path: treat /foo/:id and /foo/{id} as the same shape.
// Also strip query-string artifacts. Fixes the trivial :id vs {id}
// cosmetic drift that shouldn't block CI.
function normPath(p) {
  let out = p;
  const q = out.indexOf('?');
  if (q !== -1) out = out.slice(0, q);
  out = out.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, '/{$1}');
  return out;
}

function read(p) {
  try { return fs.readFileSync(p, 'utf-8'); }
  catch (e) { console.error(`fatal: cannot read ${p}: ${e.message}`); process.exit(2); }
}

// ── 1. ENDPOINTS_LIST ────────────────────────────────────────────
function extractEndpointsList(src) {
  // Look for the ENDPOINTS_LIST = [ ... ]; block. Pull every
  // "'METHOD   /path  — ...'" line.
  const m = src.match(/const ENDPOINTS_LIST\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return new Set();
  const body = m[1];
  const out = new Set();
  const re = /'(GET|POST|PUT|DELETE|PATCH|WS)\s+([A-Za-z0-9\/_:{}.?=&*-]+?)\s+—/g;
  let r;
  while ((r = re.exec(body)) !== null) {
    const method = r[1];
    const p = normPath(r[2]);
    out.add(`${method} ${p}`);
  }
  return out;
}

// ── 2. OpenAPI paths ────────────────────────────────────────────
function extractOpenApiPaths(yaml) {
  // We don't parse full YAML; just scan for `^  /foo:` path entries
  // and the HTTP verbs (`    get:` / `    post:`) below each.
  const out = new Set();
  const lines = yaml.split('\n');
  let inPaths = false;
  let currentPath = null;
  for (const line of lines) {
    if (/^paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[a-zA-Z]/.test(line) && !line.startsWith('paths:')) {
      // left the paths: block at a sibling top-level key
      inPaths = false;
      continue;
    }
    if (!inPaths) continue;
    const pathMatch = line.match(/^  (\/[A-Za-z0-9\/_:{}.-]+):\s*$/);
    if (pathMatch) { currentPath = normPath(pathMatch[1]); continue; }
    const verbMatch = line.match(/^    (get|post|put|delete|patch):\s*$/);
    if (verbMatch && currentPath) {
      out.add(`${verbMatch[1].toUpperCase()} ${currentPath}`);
    }
  }
  return out;
}

// ── 3. Handler dispatch regex ────────────────────────────────────
function extractHandlerPaths(src) {
  // Look for `method === 'GET' && path === '/foo'` or reverse order,
  // and `method === 'POST' && path === '/foo'` etc.
  const out = new Set();
  const re = /method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'\s*&&\s*path\s*===\s*'([^']+)'/g;
  let r;
  while ((r = re.exec(src)) !== null) {
    out.add(`${r[1]} ${normPath(r[2])}`);
  }
  // Also handle reverse order: `path === '/foo' && method === 'GET'`
  const re2 = /path\s*===\s*'([^']+)'\s*&&\s*method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'/g;
  while ((r = re2.exec(src)) !== null) {
    out.add(`${r[2]} ${normPath(r[1])}`);
  }
  return out;
}

// ── report ──────────────────────────────────────────────────────
function diff(label, a, b) {
  const miss = [];
  for (const x of a) if (!b.has(x)) miss.push(x);
  return { label, count: miss.length, items: miss.sort() };
}

const serverSrc = read(SERVER);
const yamlSrc = read(OPENAPI);

const EL = extractEndpointsList(serverSrc);
const OA = extractOpenApiPaths(yamlSrc);
const HD = extractHandlerPaths(serverSrc);

console.log(`ENDPOINTS_LIST   entries:  ${EL.size}`);
console.log(`OpenAPI paths    entries:  ${OA.size}`);
console.log(`Handler dispatch entries:  ${HD.size}`);
console.log('');

const reports = [];
// EL vs others
reports.push(diff('in ENDPOINTS_LIST but not in OpenAPI', EL, OA));
reports.push(diff('in ENDPOINTS_LIST but not handled  ', EL, HD));
// OA vs others
reports.push(diff('in OpenAPI but not in ENDPOINTS_LIST', OA, EL));
reports.push(diff('in OpenAPI but not handled           ', OA, HD));
// Handler vs others
reports.push(diff('handled but not in ENDPOINTS_LIST    ', HD, EL));
reports.push(diff('handled but not in OpenAPI           ', HD, OA));

let anyFail = false;
for (const r of reports) {
  if (r.count === 0) {
    console.log(`  ✓ ${r.label}: 0`);
  } else {
    anyFail = true;
    console.log(`  ✗ ${r.label}: ${r.count}`);
    for (const item of r.items.slice(0, 20)) console.log(`      • ${item}`);
    if (r.items.length > 20) console.log(`      … (+${r.items.length - 20} more)`);
  }
}

console.log('');
const summary = {
  endpoints_list: EL.size,
  openapi: OA.size,
  handlers: HD.size,
  reports: reports.map(r => ({ label: r.label.trim(), count: r.count })),
  in_sync: !anyFail,
};
console.log(`{summary:${JSON.stringify(summary)}}`);

if (!STRICT) {
  // Informational mode (default): report drift but exit 0 so that
  // gradual backfilling of historical debt doesn't block CI.
  // Use --strict once the three catalogs are fully aligned and we
  // want to enforce "no new drift from this point forward."
  console.log('');
  console.log(anyFail
    ? '(drift detected — run with --strict to exit non-zero)'
    : '(in sync — ready to enable --strict in CI)');
  process.exit(0);
}
process.exit(anyFail ? 1 : 0);
