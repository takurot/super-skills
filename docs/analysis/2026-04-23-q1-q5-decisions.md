# Q1-Q5 Design Decisions — AIOS self-steering M2/M5/M6

*2026-04-23 morning. Session 905f38bd (continuation). Decisions made
with user input after 2 independent-agent audits. Q6 deferred. All
5 decisions are gates for M2 phase-1 shadow implementation start.*

## Audit trail (2 agent audits + Step C verification)

1. **1st audit** (evidence-first, CONCUR/CHALLENGE):
   `docs/analysis/2026-04-23-q1-q4-independent-audit.md`
2. **2nd audit** (adversarial, minimum-viable skepticism):
   `docs/analysis/2026-04-23-q1-q6-adversarial-audit.md`
3. **Step C** live-reading of `~/skills/skills/guard/SKILL.md`,
   `careful/SKILL.md`, `freeze/SKILL.md`: all are **prose-only skills
   (no runtime enforcement)**. 2nd audit's "M6 duplicates guard"
   claim FALSIFIED — guard is guidance, M6 is enforcement. They are
   complementary layers.

## Q1 — M2 FP-rate denominator

**Decision: C (PreToolUse hook firings)**

FP-rate = FP / (TP + FP) = `1 − precision` on hook decisions.
- Alternative A (all AI assertions): too dilutive
- Alternative B (keyword matches): TN contamination from "correct
  non-blocks" (keyword matched but evidence existed)
- C measures the gate's own behavior directly

**Caveat accepted**: entry schema records `denominator_basis:
"hook-firings"` so future analyses can't reinterpret the number.

**Revisit trigger**: Goodhart's law — if teams start optimizing the
ratio by reshaping regex to reduce hook fires instead of improving
claim quality, switch to human-sampling (2nd audit's suggestion).

## Q2 — Bypass phrase

**Decision: Deferred — no `force:` phrase until Phase 3 gate ships**

Phase 1 shadow is log-only, so no bypass needed.
Phase 2 nudge is reminder-injection, still non-blocking, bypass
unnecessary.
Phase 3 gate introduces real blocking — **only then introduce**
`force:` unified phrase + modifiers (`force:evidence`, `force:freeze`,
`force:all`).

**Rationale**: 2nd audit flagged pre-friction shipping as creating
muscle-memory escape habit (like `git commit --no-verify`
normalization). Deferral preserves evidence-before-claim lesson's
intent.

## Q3 — PreToolUse gate scope

**Decision: A' (tool-category abstraction, day 1)**

Each AI client registers tool→category mapping in vcontext
`tool-category-registry` entry. Hook dispatches on
`category ∈ {mutate-file, delegate}` for M2, extended scope for M6.

**User rationale (explicit, overriding 1st audit's CHALLENGE)**:
> 「繋ぎたいが安定しないので繋げていないだけ、どんどん繋いでいきたい」
— infrastructure should be AI-agnostic from day 1 to not require
cutover when 2nd AI client stabilizes.

**Phase α (now)**: Claude Code mapping hardcoded inline + registered
as first row of registry. Each new AI adds 1 registry row.

## Q4 — M5 backfill

**Decision: B (backfill) executed AFTER M2 phase-2 ships**

Backfill script writes `session-retrospective` entries for existing
sessions using M1 audit + correction-event data. Non-computable
fields (M2 violations) set to `null` with `source: "backfill"` tag.

**Timing gate**: deferred until post-M2-phase-2 so backfilled entries
have evidence-gate-violation data fill capability. Avoids phantom
baseline risk 1st audit flagged.

## Q5 — M6 freeze + careful precision

**Decision: A+B hybrid — keep current `careful` match, M6 hook adds
AND mutation-intent condition**

The existing `careful` skill is prose-only (confirmed Step C), so M6
provides the first **runtime enforcement** of freeze-like semantics.

**Implementation**:
- `careful` skill matches via infinite-skills routing table (current
  patterns: destructive ops + infra keywords). Leave unchanged.
- M6 hook additionally requires: last user prompt contains
  mutation-intent keyword (`apply|deploy|execute|commit|push|削除|
  実行|反映|cutover`) AND PreToolUse tool is in `{mutate-file,
  delegate, execute-shell}` category.
- On trigger: freeze `/tmp/vcontext-freeze-${sid}` with 30-min TTL.
- Release paths: `force:freeze` (user) / Agent verdict entry (auto).

**User rationale**:
> 「動かないから必要、できていたら要らない、でもできていない」
— existing guard/careful/freeze prose skills don't prevent the
decision-fatigue pattern observed. Runtime enforcement needed.

**1st audit CHALLENGE rejected** based on Step C reading: guard is
not an active mechanism, it's guidance.

## Q6 — evidence-gate log retention

**DEFERRED**. Candidates: infinite / 30-day / 7-day / rolling /
aggregate-then-prune. 2nd audit recommended aggregate-then-prune +
stop shadow at phase-3 promotion. Decision pending.

## Implementation order (confirmed from feasibility doc)

1. M2 phase-1 (shadow, ~2h) — highest-ROI remaining
2. M5 retrospective (~2h, compounds)
3. M2 phase-2 (nudge, ~4h) → enables Q4 backfill trigger
4. M3 (second-opinion, ~4h)
5. M2 phase-3 (gate, ~2h) → Q2 force: phrase introduced
6. M6 (freeze, ~3h)

Total ~17h / 6 commits over multi-session scope.

## Open for next decision batch

- Q6 retention
- Which new AI client to target for 2nd tool-category registry entry
  (Cursor? Codex? Gemini?) — not urgent but informs test scenarios
