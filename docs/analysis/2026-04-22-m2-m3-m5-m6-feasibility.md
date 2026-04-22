# M2/M3/M5/M6 Feasibility Review (post-M1/M4)

*2026-04-22 read-only review. Pre-reqs confirmed live: M1 (6101359), M4 (7c2f88b), B-wiring (28fa60a), correction detection (4d50259), LLM enrichment (b5d9a49).*

## 0. Proof-of-read + commit context

**Spec read in full**: `/Users/mitsuru_nakajima/skills/docs/handoff/2026-04-23-aios-self-steering-spec.md` — 118 lines (verified via `wc -l`). Sections: observed gap, 5 design principles, M1–M6 inventory, proposed ordering, hard constraints, non-goals, metrics, dependencies, kickoff.

**15 commits since 2026-04-22 14:00** (for dependency tracking):

```
b5d9a49 feat(hooks): LLM-enriched correction analysis (mlx-generate primary)
4d50259 feat(hooks): auto-detect user correction events + surface at bootstrap
e78d91c fix(anomaly,hooks): post-review corrections from M1/M4 audits
7c2f88b feat(hooks): M4 bootstrap surfacing of anomaly skill-triggers
6101359 feat(hooks): M1 passive skill-invocation audit at session-end
606192d feat(anomaly): route async launchd-unhealthy probe → respondToAnomalies
79871d3 fix(ai-status): split embedding_backlog into eligible / skipped / raw
42215e3 docs(handoff): AIOS self-steering meta-loop spec (M1-M6)
28fa60a feat(anomaly): wire 6 unconnected alerts → skill-trigger reactive
85f8d55 docs(analysis): phase review + vcontext incompleteness audit
ea6ed8d docs(analysis): 2026-04-22 pre-existing MLX pipeline issues
bd4cdeb observability(vcontext): prepend ISO-8601 timestamps to console.*
3356d68 feat(mlx): standalone .app — jetsam cat=daemon→cat=app (pri 40→100)
41f205c fix(miner): graceful skip when no LLM available (A-alt, same as watcher)
9a7eee0 docs(handoff): 2026-04-23 kickoff + evolution-log
```

Infrastructure baseline:
- Hooks all route through `vcontext-hook-wrapper.sh` → `vcontext-hooks.js` (3401 lines). No `~/.claude/hooks/` dir.
- PreToolUse gate precedent: `hooks-gate.mts` emits `{continue:false, stopReason}` JSON.
- `recordEvent` L1589 dispatcher; session-end block L1721; UserPromptSubmit L1945; correction detection L2002; bootstrap M4 L2199.
- New entry types tonight: `skill-invocation-audit`, `skill-trigger`, `correction-event`, `correction-analysis`.
- `extractNewAssistantMessages` (L1380) is a reusable transcript-tail primitive — critical for M2/M3.

## 1. M2 — Pre-claim evidence gate

### D1 Feasibility
New PreToolUse hook (or augment `handlePreTool`) inspects latest assistant text. `extractNewAssistantMessages` handles transcript tailing. New entry type: `evidence-gate-event` (phase/verdict/reasoning). Phase-3 reuses `emitAiosBlock` JSON payload.

### D2 Dependency
- `skill-usage` (M1) NOT required — M2 reads transcript.
- `correction-event` (4d50259) is useful: the 4 silent catches (lesson ids 224681–224684) train the pattern list.
- LLM enrichment NOT hot-path (must be <100ms). Regex-only in phases 1–2.

### D3 Pitfalls
- **FP**: "complete the sentence", "once done", "100% CPU". Negative lookbehinds needed.
- **FN**: paraphrase ("no issues left", "問題なし"). Shadow sampling fixes.
- **Perf**: transcript tail <30ms (existing completion-check precedent); regex ≪10ms.
- **Override**: `force:` phrase → UserPromptSubmit writes `/tmp/vcontext-force-${sessionId}` w/ 2 min TTL.
- **vcontext down**: fail-open — matches existing AIOS-gate policy (L1428).

### D4 Ordering
Still optimal to start phase-1. M1 simulation: **234 matches / 0 invocations, rate=0.000** — discipline floor confirmed. Shadow phase yields FP distribution before promotion.

### D5 Scope-creep risk
Risk: "block claim without evidence" → "block all optimism". Guard: freeze pattern list to spec set (`完了|done|complete|100%|zero errors|fully verified`). Any expansion needs separate commit + retrospective citing FN data.

### D6 First-commit concrete
```
File: vcontext-hooks.js (new function `checkEvidenceGate(sessionId, transcriptPath)`)
Trigger: PreToolUse, BEFORE handlePreToolGate (AIOS write-block still supreme)
Phase 1: regex-scan latest assistant message; if match AND prior turn had zero
         {Bash,Grep,Read} tool-use entries for this sessionId, log 'evidence-gate-event'
         with {phase:'shadow', would_have_blocked:true, tool:..., claim_snippet:...}.
         No stdout. No block.
Acceptance: after 48h, query `/recent?type=evidence-gate-event` — if FP rate <5%
           (verified by manual sampling of `claim_snippet`), promote to phase-2.
Effort: ~2 hours for phase-1. Single commit.
```

**Recommended START priority: 1st (highest-ROI remaining).**

## 2. M3 — Second-opinion forcing

### D1 Feasibility
Needs: (a) P2-debug skill match from `skill-usage` tags; (b) production-claim regex (M2 patterns + `本番|prod|cutover|deploy|成功`); (c) "auto-spawn". **Hooks can't spawn Agent tool-calls** — only inject system-reminders. So "auto-spawn" = **inject demand + optional PreToolUse block on next assertion**.

### D2 Dependency
- **Needs M1's `skill-usage`** to detect P2-debug matched — live.
- **Needs `subagent-start/stop`** (L2047, L3173) — already recorded.
- "User already spawned 2nd opinion" = query `/session?type=subagent-start&limit=5`.

### D3 Pitfalls
- **Can't truly force**: nudge only. Commit msg should reflect.
- **FP**: P2-debug matches any debug prompt. Conjoin with `careful` skill or prod keyword.
- **Perf**: one extra `/session` read; <50ms.
- **Override**: `skip-second-opinion:` or unified `force:`.
- **vcontext down**: fail-open.

### D4 Ordering
Pushed **after M5**. M2 phase-2 gives measured FP rate; M3's production-claim regex reuses M2's. M3 before M5 duplicates regex work.

### D5 Scope-creep risk
Non-goal: NOT auto-remediation. M3's "force" flirts with "AI can't conclude without agent". Guard: block only when prior 2 turns have P2-debug match AND prod keyword AND no `subagent-start` — tight conjunction.

### D6 First-commit concrete
```
File: vcontext-hooks.js new handler `checkSecondOpinion(sessionId)` run at UserPromptSubmit.
Trigger: after routeSkills, if matchedNames contains >=2 P2-debug skills
         AND last assistant message (via extractNewAssistantMessages) matches
         production regex AND no subagent-start in last 3 turns
Emit: stdout '[second-opinion] A read-only Explore agent verification is
       strongly recommended before the next production claim. Phrase:
       `Task(subagent_type=Explore, ...)` or use `skip-second-opinion:` to override.'
Entry: 'second-opinion-demand' {reason, production_keyword, skills_matched}
Effort: ~4 hours.
```

**Recommended priority: 3rd (after M2 phase-2, M5).**

## 3. M5 — Session-end retrospective

### D1 Feasibility
Extend session-end block L1721. Add `/store` with `type=session-retrospective` = {invocation_rate, correction_count, evidence_gate_violations, anomaly_triggers_surfaced}. All inputs already vcontext-readable.

### D2 Dependency
- **Unblocked by M1** — `skill-invocation-audit` IS the baseline.
- Correction data live (4d50259). Anomaly-trigger live (7c2f88b).
- `self-evolve` pickup = polish-phase separate concern.

### D3 Pitfalls
- **Minimal**: one extra DB write at session end.
- **FP/FN**: N/A — pure aggregation.
- **Perf**: 3–5 extra `/session` reads at end-of-session.
- **vcontext down**: fail-open via outer try/catch L1805.

### D4 Ordering
Elevate to **2nd after M2 phase-1** — cheap, compounds, pipeline half-built. Gives `self-evolve` real input before M3/M6.

### D5 Scope-creep risk
Minimal. Read-only aggregation, cannot auto-remediate. Guard: no prescriptive action items in body; `self-evolve` proposes, user approves.

### D6 First-commit concrete
```
File: vcontext-hooks.js — extend session-end block (after L1764).
Add: compute over this session
     - correction_events = /session?type=correction-event
     - evidence_gate_violations = /session?type=evidence-gate-event (phase≠shadow)
     - anomaly_triggers_surfaced = /session?type=skill-trigger count-at-bootstrap
Store: {type:'session-retrospective', content: JSON.stringify({...m1_audit, ...rest}),
        tags:['session-retrospective','auto','m5']}
Effort: ~2 hours. Smallest demonstrably-valuable: write the entry with M1 numbers + correction count only (evidence-gate row becomes zero until M2 ships).
```

**Recommended priority: 2nd.**

## 4. M6 — Production-critical freeze

### D1 Feasibility
(a) `careful` skill match at UserPromptSubmit; (b) session-scoped flag `/tmp/vcontext-freeze-${sessionId}`; (c) PreToolUse gate for Edit/Write/Bash-writes until `verdict` subagent-stop entry or `release:freeze` phrase.

### D2 Dependency
- **Depends on M3** nudge phase — otherwise "verdict" release never produced.
- M1 not required.
- Reuses M2 phase-3's PreToolUse block payload → ship after M2 phase-3.

### D3 Pitfalls
- **FP**: `careful` matches any "production" mention. Conjoin with mutation intent (apply/deploy/cutover).
- **FN**: paraphrased prod prompts — M6 is backstop, not catch-all.
- **Perf**: flag check = stat(); <1ms.
- **Override**: `release:freeze`; also expires on session-end.
- **Deadlock**: 2nd-opinion crash → 30-min TTL auto-downgrade to warning.
- **vcontext down**: fail-open (no flag → no block).

### D4 Ordering
**Last**. Before M3 = verdict-producer missing → permanent manual override = net negative UX.

### D5 Scope-creep risk
HIGH. Closest to "make AI perfect" non-goal. Guards: (a) 30-min TTL; (b) phrase override; (c) write-tools only; (d) commit ships with documented release protocol user signs off on.

### D6 First-commit concrete
```
File: vcontext-hooks.js + hooks-gate.mts (for PreToolUse integration).
1. handleUserPrompt: on `careful` match + production keyword, write
   /tmp/vcontext-freeze-${sessionId} with {created_at, ttl_ms:1800000}.
2. hooks-gate.mts: PreToolUse for Edit/Write/Bash-mutation checks the flag;
   if present and no `verdict` subagent-stop entry this session, emit
   continue:false with stopReason '本番 freeze 中: 2nd-opinion 待ち (release:freeze で解除)'.
Effort: ~3 hours. Reuse hooks-gate.mts patterns.
```

**Recommended priority: 4th (last).**

## 5. Refined implementation sequence (post-tonight data)

Original spec order: M1 → M4 → M2(shadow) → M3 → M2(gate) → M6, M5.

**Tonight's changes**:
- M1, M4, correction-event detection, LLM enrichment ALL live.
- Real data: 234 matches / 0 invocations in the simulation session = discipline floor confirmed.
- 134 "silent catches" referenced by the user → M5's aggregation will immediately surface.

**Proposed new sequence** (ranked):

1. **M2 phase-1 (shadow)** — 2h, highest-ROI remaining; uses already-shipped correction patterns.
2. **M5 (retrospective)** — 2h, compounds, unblocked.
3. **M2 phase-2 (nudge)** — 4h, promote when FP<5%.
4. **M3 (second-opinion forcing)** — 4h, after M2 regex is battle-tested.
5. **M2 phase-3 (gate)** — 2h, promotion only; no new code beyond phase-2.
6. **M6 (production freeze)** — 3h, LAST; requires M3 as verdict-producer.

**Total remaining effort**: ~17h across 6 commits. Parallelizable slots: M2 phase-1 + M5 (both at session-end boundary, no conflict).

## 6. Open questions for user before M2 phase-2 (gate)

1. **FP-rate threshold**: spec says <5%, but what denominator? Per 100 assertions, or per 100 shadow-log entries? (I'd suggest "per 100 PreToolUse firings where the regex matched").
2. **`force:` vs `skip-second-opinion:` etc. — single unified bypass phrase?** Spec mentions `force:` generically; multiple phrases risk cognitive load. Unified phrase preferable.
3. **Phase-3 gate on Edit/Write only, or all tools including Bash?** Bash is noisy (pipes, echo); recommend Edit|Write|Task only.
4. **Retroactive application**: should M5 retrospective backfill for sessions before M2 shipped (using only M1 + correction data)? Lower priority but the data exists.
5. **careful-skill definition**: M6 depends on `careful` skill's match precision. Is its current keyword set (`production|critical|live|prod|deploy|cutover|本番`) acceptable for freeze-level consequences, or does it need tightening before M6 ships?
6. **Evidence-gate log storage**: shadow entries could be high-volume. Accept same namespace/session targeting as `skill-usage`? Or separate retention policy?

---

*End of feasibility review. All items within existing infrastructure. No new endpoints required.*
