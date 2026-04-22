# AIOS Self-Steering Meta-Loop — Spec & Handoff

*2026-04-22 evening. Authored during session 28d38f34 as the "C" item
of the A→B→C queue the user set after observing I needed user
intervention 6+ times in a single session to apply skills that had
**already matched** via infinite-skills routing. User articulation:*

> 「今回 MLX approach は正しかったが、私の指摘や方向修正が必要だった」
> 「AIOS に、こういう動きを期待している」

This document specifies how to close that gap — move "skill match →
skill application" from agent-discipline (soft) to system-enforced
(hard), so the AI can't forget / defer / water-down the applied skill
without the system noticing.

## Observed gap (tonight's evidence)

| Event | User had to prompt | What *should* have happened |
|---|---|---|
| Post-cutover "zero errors" claim | `こういう時にも別観点チェックと調査をしましょう、別エージェントで` × 6 times | When `investigate` + `quality-gate` matched, system forces second-opinion agent before the "zero errors" claim is accepted |
| Chained misreport ("45件") | User: `これはカットオーバー後の話？` | `evidence-before-claim` lesson auto-blocks claims with no verifying tool call in the same turn |
| Skipped skill workflows | User: `多分、無限スキルも活用してないと思う` | System counts `Skill` tool invocations; an end-of-turn gate logs an anomaly if 0 in a session where skills matched |
| Decision-point inflation | User: `いつもこう聞いてきますが...解決を先延ばししてません？` | `phase-gate` trigger-guard enforces: don't ask when queue can be done sequentially |

Quantitative floor: this session had **0 `Skill` tool calls** despite `[infinite-skills] Matched skills:` firing every UserPromptSubmit. Discipline-only enforcement = 0% actual invocation under adversarial load.

## Design principles

1. **Hard enforcement beats soft discipline**. Hooks that fail-closed, not reminders that can be acknowledged-but-ignored.
2. **Observer/actor separation**. The thing that notices a skill match MUST NOT be the same thing that decides whether to apply it. vcontext-side observation, hook-side enforcement.
3. **Graduated severity**. Blocker / gate / nudge — calibrated so 1st violation nudges, 3rd consecutive blocks. No binary.
4. **Measurable**. Every gate produces a structured entry (`skill-invocation-audit`) so drift over sessions can be detected.
5. **User override always available**. Any gate can be bypassed by an explicit user phrase (e.g. `force:`), so deadlocks are impossible.

## Mechanism inventory (ordered by effort, ascending)

### M1 — Passive audit (2h effort, no blocking)
- **What**: Add a UserPromptSubmit hook in `~/.claude/hooks/` that counts Skill-tool invocations vs skill matches per session, writes to vcontext as `skill-invocation-audit` entry at session end.
- **Why first**: Zero blast radius; gives us the baseline data needed for M2/M3 gate thresholds.
- **Acceptance**: after 1 week of operation, we have a distribution of `skills_matched / skills_invoked` ratios; we can pick thresholds empirically instead of guessing.

### M2 — Pre-claim evidence gate (4-6h, soft then hard)
- **What**: Pre-ToolUse hook that intercepts `"完了"|"done"|"complete"|"100%"|"zero errors"|"fully verified"` in agent messages. If matched AND no `Bash`/`Grep`/`Read` tool call in the same turn, inject a system-reminder requiring one.
- **Why**: implements the CLAUDE.md `evidence-before-claim` lesson (ids 224681-224684) as a *runtime* rule, not a prose guideline.
- **Phased rollout**:
  - Phase 1 (soft): log-only; count how often it would have fired.
  - Phase 2 (nudge): inject reminder; AI can still proceed.
  - Phase 3 (gate): block the message until the rule is satisfied.
- **Acceptance**: false-positive rate < 5% in shadow mode before promotion.

### M3 — Second-opinion forcing (1d)
- **What**: When multiple `[P2 debug]` skills match AND the AI's response makes a factual claim about production state, a hook auto-spawns a read-only Explore agent to verify. The agent's verdict is injected into the NEXT turn as a system-reminder.
- **Why**: tonight the user explicitly had to say "別エージェントで" 6 times. M3 automates that request.
- **Key challenge**: deciding WHEN to auto-spawn. Proposal: spawn if (a) previous 2 turns were production-critical + (b) user didn't already spawn a second opinion. Threshold tuned via M1 data.
- **Acceptance**: user never needs to say "別エージェントで" in a production-critical session.

### M4 — vcontext push: anomaly→skill→next-session (1d)
- **What**: vcontext's `skill-trigger` entries (now emitted by `respondToAnomalies` per commit 28fa60a) are surfaced at session bootstrap. If an entry has `anomaly_kind: backlog-growing` and the AI starts a new session, the first system-reminder includes "vcontext observed X anomaly, `investigate` strongly suggested".
- **Why**: closes the "next-session recency" gap; anomalies don't wait 24h for the user to notice.
- **Acceptance**: a crashed anomaly is addressed within the session it fires, not days later.

### M5 — Session-end retrospective (4h)
- **What**: End-of-session hook (`SessionEnd` or equivalent) runs a mini-retrospective: skill invocation rate, user-steering events, any assertion made without evidence tool. Output stored as `session-retrospective` entry. `self-evolve` skill picks it up and proposes hook/policy adjustments.
- **Why**: compounds over months — weak enforcement in week 1 becomes strong by week 10.

### M6 — Production-critical freeze (2h)
- **What**: When the `careful` skill matches (production / critical), automatically add a read-only `freeze` overlay until a matching 2nd agent opinion is logged. Prevents "act first, think after" on production.
- **Why**: tonight, cutover was on a 10-min monitor basis — narrow. M6 would have required an explicit 2nd-opinion before Phase N+1.

## Implementation order (proposal, not decision)

Best ROI ordering given the user's articulated pain:

1. **M1 (passive audit)** — baseline, no risk, 2h
2. **M4 (vcontext push)** — leverages commit 28fa60a; highest immediate value
3. **M2 phase 1 (shadow evidence gate)** — start capturing "would have fired" data
4. **M3 (second-opinion forcing)** — directly addresses "別エージェントで" labor
5. **M2 phase 3** (promote to gate) — after 1 week shadow data
6. **M6, M5** — polish phase

## Hard constraints

- **No network dependency in hooks**. They must work offline.
- **No external services**. All state in vcontext (local SQLite).
- **No user prompt required during hook execution**. Hooks run in-band and must be deterministic.
- **Rollback = delete the hook file**. Every mechanism must be single-file reversible.

## Explicit non-goals

- **NOT an attempt to make the AI "perfect"**. Humans override mechanism; the goal is to reduce user cognitive load, not replace user judgment.
- **NOT auto-remediation of production issues**. M1-M6 route skills *to* the AI; the AI still decides what to do. Auto-remediation (like `respondToAnomalies` launchctl kickstart) is separate scope.
- **NOT about the specific skill catalogue**. The routing table is a separate concern from the enforcement layer.

## Metrics to track (post-implementation)

- `skills_matched_per_session` — should stay constant
- `skills_invoked_per_session` — target: > 50% of matched
- `user_steering_events` — count of "別エージェントで" / "違うよ" / corrective phrases; target: decreasing over weeks
- `second_opinion_agent_spawns` — target: > 3× baseline (= previous agent-only)
- `hook_false_positives` — per M2 shadow mode; target: < 5%

## Dependencies / predecessors

- Commit `28fa60a` (reactive `skill-trigger` from anomaly response) is the first brick of M4.
- Commit `bd4cdeb` (timestamped vcontext log) is required for M1/M5 to correlate events.
- `~/.claude/hooks/` infrastructure assumed to exist; verified empirically via previous sessions.

## Proposed next session kickoff

1. Start M1 (passive audit hook). Merge-blocking test: runs without crashing on 3 sample sessions.
2. Implement M4 (bootstrap skill-trigger surfacing). Test by planting a fake skill-trigger entry and starting a session.
3. Draft M2 shadow-mode rule set. No enforcement yet.

Each M is a single commit with evidence file showing counterfactual ("if this hook had been active 2026-04-22 it would have fired N times").

---

*End of spec. Handoff to next session via docs/handoff/ convention.*
