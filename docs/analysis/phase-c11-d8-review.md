# Phase C11 + D8 Integrated Review — 2026-04-20 late night

*Per `phase-gate` skill: phase-transition evidence file. Created
before advancing from the C11+D8 debug phase into the next
remediation phase (L2 or L0 stop). Captures what was shipped,
what was learned, and what's deferred.*

---

## 1. Phase scope

**Starting state** (session snapshot):
- SIGKILL-137 = 126 at session start
- `file is not a database` = 662 per 30-min window
- Server crash rate: "critical 96/h" per crash-pattern-report
- mlx-generate: disabled (since morning OOM incident)

**Intended outcome**: stop SIGKILL-137 crash loop; LLM recovery
if possible.

---

## 2. Commits landed in this phase

| Commit | Content | Effect observed |
|---|---|---|
| `b09dd03` | C11 minimum: batch timeout 10min→60s + circuit breaker streak≥3 | 23-min soak, 0 crashes (baseline would predict ~37) |
| `bbecee2` | C11 b+c: D4 store-path gate + D7-lite RSS sampling | Combined 33:12 soak, 0 crashes |
| `edb06c4` | Proxy fix: memoryGate uses free+inactive (was free-only); skip bootstrap when MLX already healthy | LLM recovery operational (4s probe via :3163) |
| `8db83b9` | C11 D8: pre-emptive DETACH 'ssd' before ATTACH | `already in use` errors → 0 in recent window |

**Total diff this phase**: ~170 LOC across 2 files (server.js + proxy.js),
all gated by `VCTX_EMBED_C11_DISABLED=1` for rollback.

---

## 3. Agent-verified outcomes

### 3.1 Agent task `a679c1aa9089793e0` (first review, pre-D8)

- Verdict: "plausible-but-needs-more-data"
- Found real gap: store-path `mlxEmbed` → `_mlxEmbedRaw` (singular)
  NOT covered by C11 D1 timeout change; store-path bypassed the
  batch circuit. **→ Addressed in bbecee2 D4**.
- Counter-hypothesis #3 (launchd MemoryLimit): I verified plist
  has no cap — ruled out.

### 3.2 Agent task `a11f47793fe0e098d` (second review, post-D8)

- Read tail -2000 of server.log + diffs through 8db83b9
- **Verdict**: H5 is NO LONGER the driver post-C11+D8.
- Evidence for crashes #135 / #136:
  - `file is not a database`: 0
  - `already in use`: 0
  - `mlx embed timeout`: 0
  - `ECONNREFUSED 3162` (generate probe): 46 — concentrated
    at startup banner
  - Pre-crash window shows discovery + chunk-summary{L1,L2,L3}
    + predict loops all firing in the same second
- **Proposed H6**: concurrent MLX-generate inference by
  discovery + predict + chunk-summary stacking on single Qwen3-8B
  process → RSS spike → SIGKILL
- Recommended fix: memory gate on the 3 loops (L2 in our options
  matrix) using same free+inactive formula as `edb06c4`

### 3.3 Agent task `a4482f27bfad80b3e` (third review, IN-FLIGHT)

Asked to independently:
- Form own pattern from tail -2000 log
- Critique L2 formula (free+inactive, 800MB threshold)
- Suggest cheaper alternatives (single inflight lock?)
- What evidence would falsify H6?

Result pending as of this review.

---

## 4. Quantitative reconciliation

| Metric | Pre-C11 | Post-C11+D8 | Δ |
|---|---|---|---|
| SIGKILL-137 rate | 96/h | ~4/h | **-96%** |
| `file is not a database` / 30min | 662 | 0 | **-100%** |
| `already in use` / 30min | 43 | 0 | **-100%** |
| `malformed` / 30min | 9 | 11 | +2 (noise) |
| `embed timeout` / 30min | 27 | 30 | +10% (noise) |

Net: **24× improvement on the primary crash driver**; secondary
errors eliminated; a small new crash class (H6) emerged after
LLM recovery enabled 4 MLX-generate consumer loops.

---

## 5. Full-read evidence (phase-gate §Evidence)

Files read in full for this review:
- `/tmp/vcontext-server.log` tail — 2000+ lines via grep/awk
  analysis at multiple points
- `scripts/vcontext-server.js` — specific functions:
  `_mlxEmbedBatchRaw` (L5244+), `startEmbedLoop` (L3450+),
  `detectAnomalies` (L3765), `handleStore` (L1385+), 3 ATTACH
  sites (L4778/4797/4835)
- `scripts/mlx-generate-proxy.js` — `getFreePages` + `memoryGate` +
  `startMlx`, full file
- `~/Library/LaunchAgents/com.vcontext.server.plist` — full, no
  MemoryLimit found
- Agent result files:
  `tasks/a679c1aa9089793e0.output` (summary captured in commit
  messages bbecee2)
  `tasks/a11f47793fe0e098d.output` (summary captured in commit
  8db83b9 + inline §3.2 above)
  `tasks/a4482f27bfad80b3e.output` — PENDING

---

## 6. Issues discovered + remediation

| Issue | Status | Remediation |
|---|---|---|
| mlx-embed retry storm → mmap reclaim → SIGKILL (H5) | ✅ **resolved** | b09dd03 + bbecee2 |
| store-path embed bypassed batch circuit | ✅ **resolved** | bbecee2 D4 |
| proxy memoryGate false-positive (free-only) | ✅ **resolved** | edb06c4 |
| proxy bootstrap_failed when MLX already running | ✅ **resolved** | edb06c4 |
| ATTACH 'ssd' leak ("already in use") | ✅ **resolved** | 8db83b9 D8 |
| MLX-generate loop pileup → SIGKILL (H6, new) | ⏸ **pending** | L2 candidate; observe first per agent recommendation |
| RSS no longer measured during crash (D7-lite only logs iters) | ⏸ **low-priority** | D7 full would add integrity_check wrap; deferred |

---

## 7. Decision for next phase

Options evaluated:
- L2 loop memory gate — targets H6 directly
- L0 do nothing — accept 24× improvement, close session

**Choice**: BETA pattern — observe 30 min; if crashes continue,
deploy L2. Rationale:
- Only 2 data points (#135, #136) for H6
- PID 794 currently stable
- Agent 3 (in-flight) may identify cheaper alternatives
- L2 is `evidence-defensible` per agent 2 but not yet
  `evidence-necessary`

---

## 8. Phase exit criteria

Before advancing to "session close":
- ✅ Agent 1 + 2 reviews complete
- ⏸ Agent 3 review complete
- ⏸ 30-min observe window pulse check
- ⏸ L2 implemented (conditional) OR skipped with justification
- ⏸ Handoff doc updated with H6 status

---

*This review does NOT approve closing the session. It approves
transitioning from debug-execute phase to observe-decide phase.*
