# Q1-Q6 Adversarial Audit — Minimum-Viable Skepticism

*2026-04-23 READ-ONLY. Angle: "what if we don't need this at all?" — explicitly
distinct from the 1st audit's evidence-first CONCUR/CHALLENGE framing.
Each Q is stress-tested against three rubrics:*
*(A) minimum-viable alternative, (B) 6-month peak-load drift, (C) user-deference probe.*

*Grounding: spec `docs/handoff/2026-04-23-aios-self-steering-spec.md`,
feasibility `docs/analysis/2026-04-22-m2-m3-m5-m6-feasibility.md`,
skills `~/skills/skills/{careful,freeze,guard}/SKILL.md`,
CLAUDE.md `evidence-before-claim` lesson (ids 224681–224684).
Note: the "1st audit" file was absent at audit time; this review
uses the task-brief description of its framing.*

---

## Q1 — FP-rate denominator = hook firings (disposition: C, accepted)

**Adversarial frame**: Do we need a *numeric* FP threshold at all?
Both "per 100 assertions" and "per 100 firings" assume a threshold
gate. Cheaper: eyeball 50 entries, decide by inspection, no denominator.

**Counter-argument for minimum viable**: phase-1 is shadow-only. A
fixed `<5%` is arbitrary — no prior on true FP distribution. Risks
promotion-paralysis (5.3% → can't ship) or over-promotion (4.9% → ship
with visibly-nonsense FPs). Honest move: read first 100 by hand, judge.

**6-month drift**: once a denominator is codified, engineers optimise
for it. "Per firing" is cheap to goose (fewer firings ⇒ lower rate),
so pattern-tuning minimises firings not true-FPs. Goodhart.

**Revised recommendation**: **DOWNGRADE to "sampling + human review"**.
Keep denominator `C` as a fallback metric, but the *promotion gate* should
be "I read 50 random shadow entries and <3 made me wince", not a ratio.
Log the denominator for trend monitoring, don't treat it as a trigger.

---

## Q2 — Unified `force:` phrase + modifiers (disposition: A+, accepted)

**Adversarial frame**: Do we need a bypass phrase at all? Users
already override by starting a new session or passing `-p`. `force:`
solves a problem ("gate too aggressive") that doesn't yet exist
(no gate is shipped).

**Counter-argument for minimum viable**: principle #5 says override
always available — but "available" ≠ "ergonomic memorised one-liner".
Ship gates without a phrase; if ≥3 legitimate-bypass requests surface
in week 1, *then* add `force:` with observed friction baked in.

**6-month drift (CRITICAL)**: repetition builds muscle memory. After
6 months of shadow testing, phase-3 gating arrives with `force:` as
reflex — a thought-terminating shortcut, exactly what evidence-before-
claim was designed to prevent. Analog: `git commit --no-verify`,
originally rare, now reflexive.

**Revised recommendation**: **DOWNGRADE to "ship without phrase"**.
Start with zero bypass (fail-open if vcontext down is sufficient
safety-valve). Add `force:` in a follow-up commit *only* when real
friction materialises. Modifiers (`force:all`, `force:second-opinion`)
should not ship until the base `force:` has been live ≥2 weeks.

---

## Q3 — Tool-category abstraction (disposition: A', user OVERRODE)

**User's explicit reason**: "他のAIの種類に関係なくやるから、やる" —
cross-AI (Cursor, Copilot, generic) regardless of client type.

**Adversarial frame (user deference probe)**: stance is coherent but
the goal is premature. Today **zero** non-Claude AIs actually hit this
vcontext instance. A cross-AI registry serves a user-base of 1 AI
client — speculative YAGNI.

**6-month peak-load (HIGH RISK)**: a registry with no steward drifts:
- Cursor ships `ExecuteCommand` — nobody maps it, accumulates as
  `uncategorised`.
- Claude Code adds 3 new tools; miss one ⇒ gate silently fail-opens.
  Exactly the "invisible regression" AIOS hard-gate was built for.
- `Bash` categorised `destructive` in 2026-04, but by 2026-10 users
  expect `readonly` when just running `echo`. Drift without review.

**Cross-decision ripple**: Q3 registry must align with Q2's
`force:all` — but if lookup fails for an uncategorised tool, does
`force:all` cover it? **Undefined today.**

**Does "cross-AI regardless" hold up?** Partially. The principle is
right (hooks shouldn't hard-code Claude tool names), but the
*implementation* doesn't need a registry. Alternative: regex
`/(Write|Edit|Delete|Bash.*rm|mv|cp)/` ⇒ `mutation`, else `readonly`.
Ship registry when non-Claude clients actually appear.

**Revised recommendation**: **DOWNGRADE from "ship A' now" to
"ship A' skeleton with only 2 categories (mutation / readonly),
defer per-tool registry to when non-Claude clients appear"**. Surface
to user: "do you want a registry today, or the regex heuristic
today and a registry when the 2nd AI client actually hits?"

---

## Q4 — Backfill M5 retrospective, timed after M2 (disposition: B, accepted)

**Adversarial frame**: Backfill creates **phantom baselines**. An M5
retrospective for 2026-04-20 will have `evidence_gate_violations: 0`
(M2 wasn't live). A reader in 2026-06 sees "zero violations in April",
concludes discipline was high — false. Data lies by omission.

**6-month drift**: once `backfilled: true` is stripped or forgotten,
engineers run analytics and conclude "April was our best month!" —
same class as training-era price quote (lesson 224683).

**Minimum-viable alternative**: don't backfill. Start clean. If
someone wants pre-M5 aggregation, compute on demand from raw data.

**Revised recommendation**: **DOWNGRADE to "backfill OFF by default,
explicit opt-in per-session"**. If backfill happens, every backfilled
entry must carry `backfilled: true` **AND** null-out fields that
can't be retroactively computed (don't default to 0 — use `null`).

---

## Q5 — `careful` skill precision for M6 (NOT YET DECIDED)

**Main's proposed A+B hybrid**: A = keep routing table narrow,
B = M6 hook adds `hasProduction && hasMutation` conjunction.

**Adversarial frame (ABANDON candidate)**: **does M6 need to exist?**
Grounding:
- `guard` skill already says "production-like systems are involved" +
  combines `careful` + `freeze`.
- `freeze` skill specifies scoped-edit boundaries.
- `evidence-before-claim` is a live CLAUDE.md lesson with hard-gate
  hook (commit `e0bafb5`).

**M6's "freeze overlay" literally shares the name of an existing
skill.** Duplication, not coincidence. The gap M6 claims to fill
(10-min cutover monitor) is a gap in *applying* `guard` +
`evidence-before-claim`, not a missing mechanism.

**Minimum-viable alternative**: strengthen `guard` *application*,
not add M6:
- `guard` auto-matches on `careful`-keyword (already does).
- AIOS hard-gate blocks writes when `guard`-applicable context has
  no evidence tool call (already designed for this).

**6-month drift**: M6 as separate mechanism = parallel enforcement.
When `guard` says "OK, evidence gathered" but M6's 30-min TTL
hasn't elapsed, which wins? Undefined. Two gates, two bypass phrases
(`force:` + `release:freeze`), two failure modes.

**Revised recommendation for Q5**: **ABANDON M6 as a new mechanism.**
Fold its intent into (a) tightening `guard` skill's match, (b) M2
phase-3's PreToolUse gate already covers the mutation-block case.
If shipped anyway: **DOWNGRADE to A-only** (tighten routing table,
drop the new hook). The AND-conjunction in B is a symptom of trying
to build precision into a gate that shouldn't exist.

---

## Q6 — Evidence-gate log retention policy (NOT YET TOUCHED)

**Adversarial frame (the killer question)**: **retaining for what?**
Debug FPs during shadow → 30 days. Long-term drift analysis → not 7.
Compliance → vcontext isn't the right store. Options a-e are
solutions seeking a problem.

**Minimum-viable alternative**: **ride existing vcontext tier policy**
(RAM → SSD → Cloud per global CLAUDE.md). Don't invent a new TTL. If
evidence-gate is "another entry type", same tiering as `skill-usage`.
If special, the specialness needs justifying before the retention does.

**What does retention mean for debugging?** If we never re-read
entries post-promotion, retention = 0. Honest move: retain until
phase-3 ships, **archive + stop generating shadow entries**. Phase-3
logs verdicts only, not would-have-fired.

**6-month drift**: "log everything" = silent growth. ≈1 entry per
PreToolUse firing ≈ 1000/day = 180k/6mo that nobody queries.
`skill-usage` is infinite-retention by design; evidence-gate is a
development artifact, not skill-usage.

**Revised recommendation for Q6**: **Option (e) aggregate-then-prune,
with a twist**: retain raw entries only until promotion to next phase
(typically 2–4 weeks), then prune raw and keep aggregate
(count per day, top-5 claim-snippets). After phase-3 ship, stop
logging shadow entries entirely; the gate's verdict itself becomes
the record.

---

## Meta: TOP 3 questions for user to reconsider

If decision fatigue is real (and the user's accept-recommendation
pattern on Q1/Q2/Q4 is consistent with it), the **highest-leverage
reopens** are:

**#1 — Q5 (M6 existence)**: Before implementing A+B hybrid, ask:
"are you SURE you want a new mechanism, or is this a gap in applying
`guard` + `evidence-before-claim`?" Cost of reopening: 10min discussion.
Cost of getting it wrong: parallel enforcement paths for 6+ months.

**#2 — Q3 (tool-category registry scope)**: User's "cross-AI
regardless" stance is principled but builds for a user-base of 1.
Ask: "do you want a 2-category regex heuristic today + full
registry when the 2nd AI client actually appears?" User may still
choose full registry, but the question surfaces the YAGNI cost.

**#3 — Q2 (`force:` phrase timing)**: Ask: "do you want `force:`
shipped day-1, or only after we observe real friction?" The
6-month muscle-memory risk is exactly the class of drift the user
has been warning about (see lessons 224681-224684). Shipping it
pre-friction creates the reflex we don't want.

**Low-leverage reopens** (not worth user attention):
- Q1 (denominator choice) — either works; the real issue is human
  review, which doesn't need user sign-off.
- Q4 (backfill timing) — can be toggled later; minor risk if the
  `backfilled: true` tag is enforced.

---

## Summary disposition table

| Q | 1st-audit/user decision | Adversarial revision | Reason |
|---|---|---|---|
| Q1 | C (hook firings) | **DOWNGRADE** to human sampling | Avoids Goodhart on denominator |
| Q2 | A+ (force: + modifiers) | **DOWNGRADE** — ship without phrase | Muscle-memory drift |
| Q3 | A' (tool-category registry) | **DOWNGRADE** — 2-cat regex until 2nd client | YAGNI + steward-drift |
| Q4 | B (backfill OK) | **DOWNGRADE** — opt-in + null non-computable | Phantom baselines |
| Q5 | (undecided, A+B proposed) | **ABANDON M6** or A-only | Duplicates `guard` + evidence-gate |
| Q6 | (undecided) | Aggregate-then-prune; stop shadow at phase-3 | "Retention for what?" test |

Net adversarial message: **5 of 6 decisions are candidates for
downgrade or abandonment under minimum-viable skepticism**. That
rate is too high to be coincidence — it suggests the design pass
under-weighted the "do we need this at all?" question relative to
"how should this be implemented?".

*End of adversarial audit. READ-ONLY. No files modified outside
this analysis doc.*
