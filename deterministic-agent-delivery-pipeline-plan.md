# Deterministic Agent Delivery Pipeline — Build Plan

*Companion to the spec. Planning follows the spec's own doctrine: decompose along seams of uncertainty and risk (not file or org structure), retire the scariest unknowns first, give every work item a testable `done_when` rather than "implemented," estimate in bands, and decide cut lines up front. Each phase below is a unit to be planned in detail when reached; Phase 1 is planned in full here.*

---

## 1. Phase Roadmap (high-level)

Ordered so that each phase retires the largest remaining architectural risk before the next depends on it. Phase 1 is the walking skeleton — the thinnest end-to-end path that touches every integration boundary — and everything after hangs off it.

**Phase 1 — Walking skeleton / spine.** Prove the central architectural bet: an external deterministic orchestrator can drive a (stub) Pi agent over the SDK, enforce one deterministic gate, contain authority through a Pi extension, derive the state transition itself, and log provenance — under a single-writer lock. *Retires:* the Pi SDK/extension contract risk (the dependency cost accepted in D14), plus D6/D19/D23 mechanics. *Realizes (thin):* D8 floor, D10, D13, D14, D19, D23.

**Phase 2 — Deterministic gate hardened + repo modes.** Replace the single stand-in check with the real gate runner (typecheck/test/lint/contract-diff/perf-smoke), `--affected`/`--full` tiers, scope guard and oracle-freeze as `lib` + Pi extension, plus characterization baseline and greenfield bootstrap. *Retires:* "does the authoritative gate actually hold on real repos, in both modes." *Realizes:* D7, D8, D12, D16.

**Phase 3 — Classifiers, routing, budget, plan-freeze.** Door classifier, failure classifier (full verdict taxonomy incl. `apply_failure` and the malformed-verdict guard), provider-neutral tier routing through `pi-ai`, the budget circuit breaker, and the compiled/frozen/drift-checked execution plan. *Retires:* uncontrolled escalation and runaway cost; control-plane config nondeterminism. *Realizes:* D4, D5, D18, D21, D22.

**Phase 4 — Real agents, skills, phase pipeline.** The Pi skills and the five agents (spec, planner, spiker, implementer, test-author), the spec→plan→(spike)→implement→validate pipeline, dedicated oracle authoring, and the minimal/full regime split. *Retires:* "do composed agents over real skills produce gate-passing work." *Realizes:* D2, D3, D7, D25.

**Phase 5 — Lineage concurrency + HITL.** Lineage scheduler with bounded-N parallelism, declared-scope conflict detection, worktree isolation, the acceptance-target snapshotter, and the batched human decision queue over a GitHub PR adapter plus local CLI. *Retires:* throughput and collision behavior under parallelism; the O(decisions) human surface. *Realizes:* D11, D20.

**Phase 6 — Stateful changes, rollout, governance, escapes.** Expand/contract emitter, the post-launch metric gate with auto-rollback guardrail, oracle-escape instrumentation, the governance policy pack with the name-branching AST/lint guardrail, and full span-level observability. *Retires:* irreversible-change safety and long-loop acceptance. *Realizes:* D8 (post-launch), D9, D10 (spans), D15, D24.

Dependency spine: 1 → {2, 3} → 4 → 5 → 6. Phases 2 and 3 can overlap once the skeleton exists; 4 needs both; 5 needs 4; 6 needs 5.

---

## 2. Phase 1 — Walking Skeleton (detailed)

**Goal.** A single command takes one trivial two-way change through the entire loop — lock → invoke stub agent → apply in an isolated worktree → deterministic gate PRE and POST → control-plane-derived transition → provenance → release — and merges it, while an out-of-scope variant is blocked and a gate-failing variant is rejected. Real agents, real multi-check gate, classifiers, parallelism, and the phase pipeline are all explicitly out of scope here.

**Why this shape.** It is the thinnest path that still crosses every integration boundary the architecture depends on: spine↔Pi (SDK), spine↔Pi (extension enforcement), spine↔gate, spine↔state, spine↔provenance, spine↔lock. If any of those boundaries is wrong, this phase fails cheaply and early.

### Spikes (retire uncertainty first; throwaway code)

**S1 — Pi SDK headless invocation shape.** (M) Drive a single Pi agent non-interactively via `pi-agent-core`/SDK with a pinned model, returning a parseable structured result. *done_when:* a test asserts that invoking a stub task yields a deterministically-shaped result object (status, edits, metadata) from a pinned model version, with no interactive session.

**S2 — Pi extension enforcement.** (M) A Pi extension (permission gate / path protection) denies a write outside a spine-supplied allowed-paths set. *done_when:* a test shows an attempted write outside the granted scope is denied and the denial is observable to the orchestrator, while an in-scope write succeeds.

These two retire the entire D14/D6 Pi-integration risk. Everything below is lower-uncertainty engineering and depends on them.

### Work items

**W1 — Project scaffold.** (S) TS/Node npm workspace; pinned `pi-agent-core` and `pi-ai`; the repo's own typecheck/lint/test harness wired in CI (dogfooding the gate substrate). *done_when:* typecheck, lint, and an empty test suite run green in CI on a clean checkout.

**W2 — Single-writer ownership lock (D23).** (M; W1) A workspace lock with fail-fast on a second writer, read-only observer attach, and release on normal exit and on crash. *done_when:* a test starts one orchestrator, asserts a second on the same workspace fails fast, attaches a read-only observer without taking the lock, and confirms the lock is freed after a simulated crash.

**W3 — Capability grant + path-protection extension (D6; S2, W1).** (M) The spine issues a per-invocation allowed-paths scope; the Pi extension from S2 enforces it; the scope is not derivable from agent context. *done_when:* an in-scope write succeeds and an out-of-scope write is blocked for the same agent run, both surfaced to the spine, with the scope supplied only by the orchestrator.

**W4 — Stub-agent invocation (D14; S1, W1).** (S) The spine invokes a stub Pi agent that performs one scoped edit and returns a validated structured result. *done_when:* for a trivial edit task the spine receives and validates a well-formed result object; a malformed result is rejected rather than acted on.

**W5 — Single deterministic gate, PRE and POST (D8 floor, D12 seed; W1).** (M) Run one project-configured check (the repo's own test command) before starting and after applying, in an isolated worktree, via a single shared code path. *done_when:* the gate refuses to start on a non-green PRE state, runs the identical check POST-apply, and the PRE and POST invocations call the same gate code.

**W6 — Control-plane transition derivation (D19; W4, W5).** (S) The orchestrator inspects the validated result and the POST-gate and applies the one state transition itself; the agent result never mutates state. *done_when:* a test proves a well-formed result whose POST-gate is red does **not** advance state, and that the merge transition occurs only via the control-plane decision, never from the result directly.

**W7 — Minimal provenance (D10; W4).** (S) Log the single generation content-addressed — model, prompt, context hash, temperature, tool/SDK versions — to SQLite. *done_when:* after a run the generation record is queryable and its recorded context hash recomputes from the stored inputs.

**W8 — End-to-end skeleton wiring.** (M; W2–W7) Compose the loop behind one command for a single lineage and a trivial two-way change. *done_when:* one integration test drives a trivial change all the way to merge, a second variant attempting an out-of-scope write is blocked (W3), and a third variant failing the POST-gate is rejected (W5/W6) — all in CI.

### Cut lines (shed in this order if time runs short)

1. Contract-diff / perf-smoke in the gate — keep only the repo's test command (deferred to Phase 2).
2. Read-only observer attach in W2 — keep only fail-fast single-writer.
3. Crash-release semantics in W2 — keep clean-exit release; harden later.
4. SQLite for provenance (W7) — fall back to an append-only JSONL log, migrate in Phase 3.

The lock's fail-fast guarantee, the gate's PRE/POST identity, control-plane-derived transitions, and capability enforcement are **not** cuttable — they are the integrity floor (D25) the skeleton exists to prove.

### Exit criteria

W8's integration test is green in CI, and S1, S2, D19, and D23 are each demonstrated by a passing test. At that point the architecture's riskiest bets are retired and Phases 2 and 3 can begin in parallel.

### Estimate

Two M spikes plus roughly three S and four M work items — a small, single-developer phase whose cost is dominated by the two Pi-integration spikes, not the spine plumbing.
