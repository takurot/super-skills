# AIOS OS-Layer Policy — Spec

**Date**: 2026-04-27
**Author**: Claude main, session `905f38bd`, Opus (post-2026-04-23 quality recovery)
**Parent**: [`docs/principles/AIOS-CONSTITUTION.md`](../principles/AIOS-CONSTITUTION.md) (Axioms 1-4, Principles P1-P6, HITL H1-H4)
**Sibling**: [`docs/handoff/2026-04-23-aios-self-steering-spec.md`](../handoff/2026-04-23-aios-self-steering-spec.md) (M1-M7 hooks)
**Trigger**: 50-finding source review (`docs/analysis/2026-04-27-aios-source-review.md`) revealed code-level patches alone cannot prevent recurrence — root cause is **policy gap between Constitution principles and implementation**.
**Decision tier**: HITL **H3** (architectural; user decides direction, AI implements)
**Status**: PROPOSAL (not implemented)

---

## 0. Why this spec exists

### 0.1 The triggering incident

Today's 50-finding source review identified `maxTokens=40960` × 8 callers as a memory-pressure root cause and recommended reducing them to 600/1000/2000. Worker W1 implemented the reduction. **It violated standing directive id=229441/229438 (`maxTokens=40960 は品質保持の意図的設計`) — the third occurrence of the same anti-pattern** (id=244419 records the second). The violation went undetected through 3 review agents + main approval because none consulted vcontext lesson-learned. W1-REVERT restored 40960 after user prompt.

### 0.2 What this reveals

- Code-level review without policy-level review **systematically misses standing directives**.
- Constitution principles (P6 "Observe before act") are normative but lack concrete enforcement.
- The existing M7 spec ("config-value standing-directive recall") was never implemented — direct cost: 2 violations × user correction labor.
- Memory ↔ Quality trade-offs have no documented resolution; each session re-derives (incorrectly).

### 0.3 What this spec produces

**Eight operational policies** that translate Constitution principles into runtime contracts, plus **two enforcement mechanisms** (M7 promotion to gate; agent-led review must cite lesson-learned).

---

## 1. Phase 1 — Requirements

### 1.1 Goal

> Codify AIOS as a coherent operating system: every runtime decision (scheduling, budgeting, retention, degradation, role) has an explicit, machine-checkable policy, and every code change against a budget/limit/timeout consults the standing-directive ledger before landing.

### 1.2 Acceptance Criteria

Each AC is testable. The spec is complete when **all 14 AC pass** in CI / manual verification.

#### Group A — Time and load
- **AC-A1**: No two `com.vcontext.*.plist` LaunchAgents have the same `(StartCalendarInterval.Hour, Minute)` tuple. Verifiable: `python3 scripts/audit-cron-clusters.py` returns exit 0.
- **AC-A2**: chunk-summary L2/L3 inner loops carry an initial offset env-overridable. Already partially addressed by W4; this AC formalizes.
- **AC-A3** (forward-looking): Background loops accept a global `MLX_BUSY` signal and yield. No code change yet, AC documents the interface.

#### Group B — Resource budgets
- **AC-B1**: Every `mlxGenerate` caller specifies a budget kind (`caller: 'discovery' | 'auto-trigger' | …`). Verifiable: `grep "mlxGenerate(" | grep -v "caller:" | wc -l` == 0.
- **AC-B2**: A central `mlxBudget` module owns aggregate token-per-minute capacity. Callers `await mlxBudget.acquire(kind, tokens)` before invocation. Verifiable: code reference.
- **AC-B3**: When budget is exceeded, callers receive `Error('budget exceeded')` with retry-after; no silent queueing beyond `_MLX_QUEUE_MAX`. Verifiable: integration test.
- **AC-B4** (Quality > Memory under N=1): All `maxTokens` values default to **40960** for Qwen3-8B-4bit. Reductions require explicit `acknowledged_directive: id=229441` tag in the commit/PR description. Verifiable: pre-commit hook.

#### Group C — Data and retention
- **AC-C1**: `data/snapshots/` enforces retention `last 7 days + first-of-month for last 12 months`. Older snapshots auto-deleted by maintenance cron. Verifiable: `node scripts/audit-snapshot-retention.cjs` returns exit 0.
- **AC-C2**: `entries-wal.jsonl` rotates at 100 MB to `entries-wal.<ISO>.jsonl.gz`, retains last 5. Verifiable: file listing.
- **AC-C3**: Total `data/` size ≤ 30 GB at steady state. Watchdog warns at 25 GB. Verifiable: dashboard widget + cron alert.

#### Group D — Failure modes
- **AC-D1**: vcontext-server defines 4 explicit operating tiers: `green` (all 4 services up), `yellow-mlx` (MLX down, embed/recall continue), `yellow-embed` (embed down, recall+store continue), `red` (vcontext alone). `/admin/health-report` returns the current tier. Verifiable: state machine in vcontext-server.js with handler dispatch tier-aware.
- **AC-D2**: SIGKILL/exit=137 events trigger a `tier:downgrade` entry in vcontext within 60s of restart. Verifiable: log search.

#### Group E — Single source of truth
- **AC-E1**: Handler dispatch is canonical. OpenAPI YAML is **generated** by `node scripts/generate-openapi.cjs` from handler routes; manual edits forbidden. Verifiable: generate script idempotent + pre-commit gate.
- **AC-E2**: skill registry is canonical from FS (`skills/*/SKILL.md`). `manifests/install-components.json` is generated by `node scripts/generate-manifest.cjs`; manual edits flagged. Verifiable: gen script + pre-commit gate.
- **AC-E3**: README skill count is templated (`{{ skill_count }}`) and rendered by build. Verifiable: rendered README matches `find skills -maxdepth 2 -name SKILL.md | wc -l`.

#### Group F — Self-knowledge (M7 promotion)
- **AC-F1**: PreToolUse hook intercepts `Edit`/`Write`/`NotebookEdit` against config-like numerical constants (`max_tokens`, `heap_size`, `timeout`, etc.) and queries vcontext lesson-learned for matching directives. Already specified as M7; this AC promotes from "shadow phase 1" to **"phase 2 nudge enabled by default"**.
- **AC-F2**: Agents launching from main MUST include in their prompt: "Before any code change against a numerical config value, query vcontext for matching `directive` tags." Already in CLAUDE.md per `subagent-preamble.md` template; this AC formalizes verification.
- **AC-F3**: Code review agents (security/stability/QA) MUST consult vcontext lesson-learned before recommending value changes. Verifiable: agent prompt template.

#### Group G — Role boundary
- **AC-G1**: Admin endpoints split into 3 ledgers in code: `OPS_ENDPOINTS` (replay-wal, vacuum, fts-rebuild, ...), `DEV_ENDPOINTS` (dedup-migration, adopt-idea, ...), `DANGEROUS_ENDPOINTS` (stop-aios, wipe-user, restart-aios, shell-command). Verifiable: source grep.
- **AC-G2**: `validateApiKey` returns scopes `{ops, dev, dangerous}` based on token classification. Default token has `ops` only. Verifiable: integration test.
- **AC-G3**: `DANGEROUS_ENDPOINTS` require an additional confirmation token issued via the CLI (extending W6 pattern: token via terminal prompt, not header). Verifiable: attack-test.sh case.

#### Group H — N=1 policy
- **AC-H1**: A new file `config/aios-policy.json` declares `mlx.max_concurrency: 1`. Read at vcontext-server startup; logged on boot. Verifiable: log line.
- **AC-H2**: The mlxGenerate dispatcher refuses to dispatch a 2nd item until the 1st completes (already enforced by `_mlxRunning` flag; this AC documents and gates by `aios-policy.json`).
- **AC-H3**: A `policy:violation` entry is stored if any caller bypasses `withMlxLock`. Verifiable: vcontext entry on violation.

### 1.3 Out of Scope (explicit)

- **NOT** a rewrite of vcontext-server.js. All changes are additive (new modules, hooks, gen scripts).
- **NOT** auto-tuning of `max_tokens` based on observed truncation rates (could be future iteration).
- **NOT** a new dashboard UI. Tier and policy state surface via existing `/admin/health-report` and `/ai/status`.
- **NOT** multi-user or multi-tenant. AIOS remains single-user.
- **NOT** a replacement for AIOS-CONSTITUTION. This spec implements the Constitution; doesn't supersede it.

---

## 2. Phase 2 — Design

### 2.1 Eight policy modules

| Module | File path | Owns |
|---|---|---|
| `mlxBudget` | `scripts/lib/mlx-budget.js` | per-kind token/min budgets, `acquire(kind, tokens)` API |
| `aiosPolicy` | `scripts/lib/aios-policy.js` | reads `config/aios-policy.json`, exposes `policy.mlx.max_concurrency` etc. |
| `aiosTier` | `scripts/lib/aios-tier.js` | computes operating tier (green/yellow-*/red) from /health responses |
| `directiveRecall` | `~/.claude/hooks/directive-recall.mts` (M7 phase 2) | PreToolUse hook for config-value edits |
| `endpointClassifier` | `scripts/lib/endpoint-classifier.js` | classifies admin endpoints into ops/dev/dangerous; consumed by `validateApiKey` |
| `retentionPolicy` | `scripts/audit-snapshot-retention.cjs` + `scripts/audit-wal-retention.cjs` | enforces AC-C1, C2, C3 |
| `cronAuditor` | `scripts/audit-cron-clusters.py` | enforces AC-A1 across all `com.vcontext.*.plist` |
| `truthGenerators` | `scripts/generate-openapi.cjs`, `scripts/generate-manifest.cjs`, `scripts/generate-readme.cjs` | enforces AC-E1, E2, E3 |

### 2.2 Data Model

**`config/aios-policy.json`** (new file):
```json
{
  "version": 1,
  "mlx": {
    "max_concurrency": 1,
    "max_tokens_default": 40960,
    "queue_max": 6,
    "rationale_ref": "lesson-learned id=229441/229438; user directive 2026-04-23"
  },
  "data": {
    "snapshot_retention_days": 7,
    "snapshot_retention_monthly": 12,
    "wal_rotate_size_mb": 100,
    "wal_keep_count": 5,
    "data_dir_warn_gb": 25,
    "data_dir_max_gb": 30
  },
  "tier": {
    "downgrade_warn_after_sec": 60,
    "auto_recover_attempts": 3
  },
  "endpoints": {
    "default_token_scope": ["ops"],
    "dangerous_require_cli_token": true
  }
}
```

**Standing-directive marker** (added to entries):
```json
{ "kind": "lesson-learned", "tags": ["directive", "value-preservation", "max_tokens"], "value": 40960, "identifier": "max_tokens", "supersedes": null }
```

### 2.3 API / Interface

**`mlxBudget.acquire(kind, tokens)`** — async; resolves with release fn or rejects with `BudgetExceededError`. Sample callers:
```js
const release = await mlxBudget.acquire('discovery', 40960);
try { result = await mlxGenerate(prompt, opts); } finally { release(); }
```

**`aiosPolicy.get(path)`** — synchronous; reads from cached `config/aios-policy.json`. Sample:
```js
if (concurrent > aiosPolicy.get('mlx.max_concurrency')) refuse();
```

**`aiosTier.current()`** — returns one of `green | yellow-mlx | yellow-embed | red`. Sample handler integration:
```js
if (aiosTier.current() === 'red') return sendJson(res, 503, { tier: 'red', error: 'storage-only' });
```

**Directive-recall hook output** (PreToolUse):
```json
{
  "allowed": true,
  "warnings": [{
    "kind": "directive_match",
    "identifier": "max_tokens",
    "attempted_value": 600,
    "directive_value": 40960,
    "directive_id": 229441,
    "snippet": "maxTokens=40960 は品質保持の意図的設計",
    "action_required": "acknowledge or override with reasoning"
  }]
}
```

### 2.4 Sequence (typical edit guarded by directive recall)

1. Agent issues `Edit` against `vcontext-server.js`, changing `max_tokens: 40960` → `max_tokens: 600`.
2. PreToolUse hook fires; `directiveRecall` extracts `(identifier=max_tokens, value=600)` from the diff.
3. Hook queries vcontext: `GET /search/semantic?q=max_tokens directive` filtered by `tags: directive`.
4. Match found: `id=229441 value=40960`.
5. **Phase 2 (nudge)**: hook emits a system-reminder to the agent: `id=229441 says max_tokens=40960 (lesson: ...). You wrote 600. Justify or revert.` Edit is **not blocked**.
6. Agent must respond either with explicit override `acknowledged_directive: id=229441; reason: <text>` OR revert the edit.
7. **Phase 3 (gate, future)**: Edit blocked unless override tag present.

### 2.5 Constraints

- All hook code runs offline (no network).
- All policy state is local (vcontext SQLite + JSON config).
- Hook execution time budget: <100 ms (hooks must not stall ToolUse).
- Pre-commit gates may be slower (~5 s) but cached.
- Reversibility: every new file is single-file deletable.

---

## 3. Phase 3 — Tasks (replacing W8-W12)

The remaining Phase 2 worker chain is re-planned. **W8-W12 (langfuse, OpenAPI sync, manifest sync, README, tsconfig)** were originally implementation-only; now they become spec-derived with explicit AC refs.

### W8' (P1 Security HIGH continued — langfuse hardening)
- **AC**: G3 (extends to docker secrets), C3 (the langfuse data dir is part of `data/` quota)
- **Tasks**:
  - W8.1 Generate per-install secrets at `docker compose up`. Satisfies AC-G3 partially.
  - W8.2 Bind langfuse-web to 127.0.0.1:9091 only.
  - W8.3 Document the langfuse data path in `data/` accounting (AC-C3).

### W9' (P2 Single Source of Truth — OpenAPI)
- **AC**: E1
- **Tasks**:
  - W9.1 Write `scripts/generate-openapi.cjs` reading handler dispatch from vcontext-server.js.
  - W9.2 Run once, commit generated `docs/schemas/vcontext-api-v1.yaml`.
  - W9.3 Add `pre-commit` gate via `.githooks/`: refuse commit if `generate-openapi.cjs` output diffs from committed YAML.
  - W9.4 Delete the `ENDPOINTS_LIST` constant; replace with autogen.

### W10' (P2 Single Source of Truth — Skill manifest)
- **AC**: E2, E3, F2
- **Tasks**:
  - W10.1 Write `scripts/generate-manifest.cjs` reading `skills/*/SKILL.md` frontmatter.
  - W10.2 Replace `manifests/install-components.json` with generated output.
  - W10.3 Add pre-commit gate.
  - W10.4 Update README via templating (AC-E3).
  - W10.5 Add subagent-preamble check that all delegated agents reference vcontext lesson-learned (AC-F2).

### W11' (P0 Resource Budget — `mlxBudget` module)
- **AC**: B1, B2, B3, B4, H1, H2, H3
- **Tasks**:
  - W11.1 Create `scripts/lib/mlx-budget.js` and `scripts/lib/aios-policy.js`.
  - W11.2 Add `caller:` field requirement to all `mlxGenerate` callers (currently 80% have it; bring to 100%).
  - W11.3 Wrap `mlxGenerate` to call `await mlxBudget.acquire(kind, tokens)` before dispatch.
  - W11.4 Create `config/aios-policy.json`; load at startup (AC-H1).
  - W11.5 Add `policy:violation` entry persistence (AC-H3).

### W12' (P0 Directive Recall — M7 phase 2)
- **AC**: F1, F2, F3, B4
- **Tasks**:
  - W12.1 Implement `~/.claude/hooks/directive-recall.mts` per handoff M7 spec.
  - W12.2 Move from "shadow log only" → "phase 2 (nudge with system-reminder)".
  - W12.3 Add identifier-extraction regex for `max_tokens`, `heap_size`, `timeout`, `mmap_size`, `batch_size`, `concurrency`.
  - W12.4 Implement `acknowledged_directive: id=N` parsing in commit messages.

### W13' (NEW — Operating tiers)
- **AC**: D1, D2
- **Tasks**:
  - W13.1 Create `scripts/lib/aios-tier.js` — state machine.
  - W13.2 Modify `/admin/health-report` to return tier explicitly.
  - W13.3 Modify watchdog to detect SIGKILL/exit=137 and store `tier:downgrade` entry.

### W14' (NEW — Retention enforcement)
- **AC**: A1, C1, C2, C3
- **Tasks**:
  - W14.1 `scripts/audit-snapshot-retention.cjs` — enforces last-7-daily + first-of-month-12.
  - W14.2 `scripts/audit-wal-retention.cjs` — rotates at 100 MB, gzip, keeps 5.
  - W14.3 `scripts/audit-cron-clusters.py` — flag conflicting `(Hour, Minute)` tuples.
  - W14.4 Wire into `com.vcontext.maintenance.plist` to run daily.
  - W14.5 Add dashboard widget: `data/` size + tier + clustered-cron count.

### W15' (NEW — Endpoint role classification)
- **AC**: G1, G2, G3
- **Tasks**:
  - W15.1 Classify all 36 `/admin/*` endpoints into `OPS_ENDPOINTS / DEV_ENDPOINTS / DANGEROUS_ENDPOINTS`.
  - W15.2 Modify `validateApiKey` (W5 work) to return scopes; `hasRole` becomes `hasScope`.
  - W15.3 Define `DANGEROUS_ENDPOINTS` confirmation token issuance (CLI-side).
  - W15.4 Update `aios-task-cli.js` to issue dangerous tokens.

### W16' (NEW — Spec compliance audit)
- **AC**: meta — verifies all 14 AC pass
- **Tasks**:
  - W16.1 Write `scripts/audit-os-policy.cjs` running all AC checks.
  - W16.2 Add to `npm test` smoke suite.
  - W16.3 Document in RECOVERY.md as part of post-restart checks.

---

## 4. Verification Plan (post-implementation)

| AC | Verification |
|---|---|
| A1 | `python3 scripts/audit-cron-clusters.py` returns 0 |
| A2 | `grep -c "VCTX_CHUNK_SUMMARY_L[23]_OFFSET_MS" scripts/vcontext-server.js` ≥ 2 |
| A3 | (interface only — verified when implemented) |
| B1-B4 | `node scripts/audit-os-policy.cjs --group b` passes |
| C1-C3 | `node scripts/audit-os-policy.cjs --group c` passes; disk usage check |
| D1, D2 | curl `/admin/health-report` returns `{tier: ...}`; log search after simulated kill |
| E1-E3 | pre-commit gates trigger on diff; CI uses `--strict` |
| F1-F3 | shadow-then-nudge mode; agent prompts contain mandate |
| G1-G3 | `node scripts/audit-os-policy.cjs --group g` passes; `bash scripts/attack-test.sh` covers |
| H1-H3 | startup log contains `[policy] mlx.max_concurrency=1`; violation test |

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `mlxBudget.acquire` adds latency to legitimate calls | M | M | Cache budget state; <5ms overhead target |
| Directive-recall false positives (non-config numbers flagged) | M | L | Phase-2 = nudge only; agent can override |
| OpenAPI gen drift (handler change not regen'd) | H | M | Pre-commit gate is non-bypassable |
| Tier state machine flip-flopping under transient errors | L | L | 60s debounce per AC-D2 |
| Per-install langfuse secret rotation breaks running container | L | M | Generate at first-up, persist; document migration |
| Worker chain re-execution risk (W11'-W16' re-run partially) | L | M | Each task is idempotent; AC checker catches partial state |

---

## 6. Reconciliation with Constitution

| Constitution principle | This spec satisfies via |
|---|---|
| P1 Loose coupling | Existing (W11' adds `mlxBudget` as lib not in core) |
| P2 Contract-first | AC-E1, E2, E3 (truth generators) |
| P3 Fail-open infra / fail-closed policy | AC-D1 (operating tiers) ; M7 phase 2 = soft initially |
| P4 Machine-readable contracts | `config/aios-policy.json` + JSON schema |
| P5 Reversibility | Every new file is deletable; commits granular |
| P6 Observe before act | M7 phase 2 (W12') is the direct enforcement |
| H1 Autonomous | W14' retention runs unattended |
| H2 Propose-then-execute | This spec itself; W11', W15' are H2 |
| H3 Propose-and-wait | This spec asks user before W11' onward |
| H4 Stop and escalate | Tier downgrade triggers user notification |

---

## 7. Implementation order

Recommended sequence (single sequential worker chain, ~1-2 days):

```
W12'  (M7 directive-recall)        — prevents regression of today's incident
W11'  (mlxBudget + aios-policy)    — formalizes today's N=1 commitment
W13'  (operating tiers)            — observability
W9'   (OpenAPI gen)                — single source of truth
W10'  (manifest gen + README)      — single source of truth
W15'  (endpoint role classify)     — completes W5 security
W14'  (retention enforcement)      — long-term sustainability
W8'   (langfuse hardening)         — leftover from original P1
W16'  (audit-os-policy.cjs)        — gating compliance
```

Total: 9 workers. Each ≤ 90min effort with clear AC. Sequential per supervisor-worker rule.

---

## 8. User verdicts (2026-04-27)

| Q | Verdict | Effect on spec |
|---|---|---|
| 1. AC-B4 (Quality > Memory under N=1) | **OK** | Locked: maxTokens=40960 default, reductions require `acknowledged_directive: id=229441` tag |
| 2. Tier names | **OK for now** | Locked: green / yellow-mlx / yellow-embed / red |
| 3. Default token scope | **B (segmented migration)** | AC-G2 amended: loopback callers get effective scope=`["ops","dev","dangerous"]` during transition (1-2 weeks), with `console.warn('[ws-auth][deprecated] scope-less loopback call to /admin/X — migrate by YYYY-MM-DD')` per call. After transition, default = `["ops"]`. |
| 4. Implementation order | **Delegated** | Locked: W12' → W11' → W13' → W9' → W10' → W15' → W14' → W8' → W16' |

### AC-G2 amendment

```
- Phase 1 (W15' delivery): loopback (127.0.0.1) caller defaults to scope=["ops","dev","dangerous"] (compat).
  Each call to /admin/* logs `[scope-deprecated] loopback X without explicit scope; migrate by 2026-05-15`.
- Phase 2 (after 2026-05-15 OR client migration confirmed): default loopback scope = ["ops"].
  /admin/dedup-migration / dev-class endpoints require explicit scope=["dev"] grant.
- Phase 3 (always): dangerous endpoints require TTY-issued confirmation token regardless of phase.
```

---

*End of spec. User-approved 2026-04-27. Implementation begins with W12'.*
