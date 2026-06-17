# Snaffle — Build Plan

*Companion to the spec. **Snaffle** is the deterministic agent delivery pipeline — external spine, Pi agents, human escalation at decisions not diffs. Planning follows the spec's own doctrine: decompose along seams of uncertainty and risk (not file or org structure), retire the scariest unknowns first, give every work item a testable `done_when` rather than "implemented," estimate in bands, and decide cut lines up front. Each phase below is a unit to be planned in detail when reached; Phase 1 is planned in full here.*

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

---

## 3. Phase 2 — Deterministic Gate Hardened + Repo Modes (completed)

**Goal.** Replace the single stand-in check with the authoritative multi-stage gate (cheapest-first per D8), running through the **same** PRE/POST code path, with `--affected`/`--full` tiers, characterization-baseline (wrap mode) and greenfield bootstrap, and scope/oracle-integrity enforced as `lib` + a Pi extension. Prove it holds on a real already-red repo (regression-from-baseline) and on a fresh greenfield repo.

**Status.** Complete — commit `e38f352` on `main` (local). `bun run check` (135 tests) and `npm run check:node` green.

### What shipped (pointers)

| Area | Where |
|------|--------|
| Multi-stage gate (PRE/POST same path, fail-fast) | `src/lib/gate-runner.ts` |
| TOML config, `--affected` / `--full` tiers | `src/lib/gate-config.ts` |
| contract-diff stage | `src/lib/contract-diff.ts` |
| Wrap-mode baseline (D16) | `src/lib/gate-baseline.ts`, `src/domain/gate.ts` |
| Greenfield bootstrap | `src/lib/gate-bootstrap.ts` |
| Oracle freeze + scope grant (D7) | `src/lib/oracle-freeze.ts`, `src/lib/scope-guard.ts`, `src/extensions/oracle-protection.ts` |
| Node-compat (D17/D18) | `src/lib/spawn.ts`, `src/lib/sqlite.ts`, `scripts/guard-no-bun-native.mjs` |
| Dual CI | `.github/workflows/check.yml` |
| Adversarial AC checklist (manual) | `phase2-acceptance-checklist.md` |

Config shape changed from `{ command, checkKind }` to `{ tier, repoMode, stages[] }` with package.json fallback. Deferred per cut lines: `smoke_budget`, `spec_traceability` gate stages.

### Exit criteria (met)

W8 green in CI under Node; contract-diff catches a deliberately reshaped schema; both repo modes (wrap-regression and greenfield) proven; PRE/POST identity holds via `GATE_DETERMINISTIC_ENTRY` trace.

---

## 4. Phase 3 — Classifiers, Routing, Budget, Plan-Freeze (detailed)

**Status.** Complete — commit `fbabfc4` on `main`. `bun run check` (177 tests) and `npm run check:node` green; `phase3-acceptance-checklist.md` fully checked. Cut line 3 (automatic re-invocation/retry loop) deferred to Phase 4.

**Goal.** Wire the control-plane's decision layer: classify doors and failures deterministically, route retries and tier escalation without uncontrolled model spend, compile and freeze the execution plan before work runs (refusing drift), and enforce a budget circuit breaker between steps. The walking skeleton continues to use the stub agent; real agents and the phase pipeline remain Phase 4.

**Why this shape.** Domain types for door (D5), failure routing (D4), and provenance plan-hash (D21 thin slice) already exist in `src/domain/` — but the spine still hardcodes `classifyTwoWay()`, uses a constant `PHASE1_SKELETON_PLAN` for `planHash`, and has no failure classification or budget enforcement on the loop. The real risks are: (1) a config-driven door classifier that cannot miss one-way doors (Risks §9), (2) failure evidence mapping to the full D4 taxonomy including `apply_failure` and the malformed-verdict guard, (3) plan drift making the control plane itself non-deterministic, and (4) tier routing that stays provider-neutral through `pi-ai` (D18) without hardcoded vendor logic in `lib/`. Front-load those; wiring into the spine is lower uncertainty once `lib/` owns the rules once (D12).

**Current-state anchors.**

- Door/regime/failure routing: pure functions in `src/domain/door.ts`, `src/domain/failure.ts` — tested in `src/domain/domain.test.ts`.
- Gate config TOML: `src/lib/gate-config.ts` — stage commands only; no door taxonomy or tier mapping yet.
- Plan hash: `PHASE1_SKELETON_PLAN` constant in `src/lib/provenance-hash.ts` — D21 placeholder.
- Spine admission: `classifyTwoWay()` hardcoded in `src/spine/phase1-cli.ts`, `skeleton-run.ts`.
- Pi invocation: faux provider stub in `src/pi/invoke-stub-agent.ts`; tier resolution not yet config-driven.

### Spikes (retire uncertainty first; throwaway-ish code)

**S1 — Config-driven door signals.** (M) Map declared write scope + optional path/tag hints to `OneWayTrigger[]` via TOML-declared patterns (D15), with ambiguous → one-way conservative default. *done_when:* a fixture repo with config declaring `auth`/`money`/etc. path patterns classifies known scopes correctly; an undecidable scope becomes one-way; no trigger literals hardcoded in `lib/` dispatch (only in config fixtures).

**S2 — Failure evidence → verdict.** (M) Deterministically classify gate reds, scope/oracle violations, apply errors, agent `failed`, and infra faults into the full D4 taxonomy; validate the emitted verdict artifact (malformed packet → `malformed` verdict, never acted on). *done_when:* one fixture per category classifies to the expected `FailureCategory`; a deliberately malformed classifier packet routes to human via `routeVerdict`; `apply_failure` routes to `control_plane_repair`, not retry.

**S3 — Plan compile + drift.** (M) Compile gate config + door taxonomy + tier mapping + capability defaults into a single content-addressed `ExecutionPlan`; detect drift when source inputs change after freeze; retain last-good plan. *done_when:* plan hash recomputes from stored inputs; mutating `.orchestrator/gate.toml` (or equivalent) after freeze yields a typed stale-plan error; last-good plan is queryable for inspection/rollback.

**S4 — Provider-neutral tier resolution.** (S) Resolve `light`/`mid`/`heavy` → `{ provider, model, version? }` from TOML through one `lib/` function consumed by the Pi adapter; faux provider proves shape in tests. *done_when:* each tier resolves from config; `escalate_one_tier` bumps exactly one step and stops at heavy; no vendor string appears in `lib/` outside config parsing.

### Work items

**W1 — Orchestrator config loader (D18, D15).** (M; S1, S4) Extend project config beyond gate stages: door path patterns, model tier table, budget limits. Single TOML (e.g. `.orchestrator/config.toml`) or documented sections; fail-closed parse errors. *done_when:* valid TOML yields typed config; absent sections fall back to documented defaults; invalid config returns typed errors, never partial config.

**W2 — Door classifier in `lib/` (D5, D15; S1).** (M; W1) `classifyDoor(scope, hints, config) → DoorClassification` using config patterns; call domain constructors (`classifyOneWay`, `classifyTwoWay`, `classifyAmbiguousAsOneWay`). *done_when:* tests cover each trigger type, two-way default, and ambiguous→one-way; classifier is the only door entry point used by the spine.

**W3 — Failure classifier in `lib/` (D4; S2).** (M) `classifyFailure(evidence) → FailureVerdict` over a typed evidence union (gate report, scope violation, apply error, agent outcome, environment fault). *done_when:* each D4 category has a passing fixture; malformed emitted verdict validates to `malformed`; classifier output always passes through `routeVerdict` before any retry/escalation decision.

**W4 — Failure router + retry policy (D4; W3).** (S; W3) Compose classifier + `routeVerdict` + bounded transient retry (same tier) + single `model_capability` escalation. *done_when:* transient retries cap and stop; second `model_capability` on same lineage does not escalate again; categories that must not spend model budget never invoke the stub/model path.

**W5 — Execution plan compiler + freezer (D21; S3).** (M; W1) `compileExecutionPlan(sources) → FrozenPlan` with content hash; `assertPlanFresh(frozen, liveSources)` refuses stale execution. *done_when:* hash recomputes from canonical JSON; drift after freeze is refused with typed error; last-good plan retained on disk under `.orchestrator/`.

**W6 — Plan hash in provenance (D10, D21; W5).** (S; W5) Replace `PHASE1_SKELETON_PLAN` / `computePlanHash()` with the frozen plan from W5; generation records carry the real plan hash. *done_when:* provenance round-trip stores and recomputes plan hash from frozen plan inputs; skeleton run logs the compiled plan, not the Phase 1 constant.

**W7 — Tier router + Pi adapter wiring (D18; S4, W1).** (M; W4, W6) `resolveModelTier(tier, config) → ModelRef`; spine passes resolved model into stub invocation (faux in tests). Escalation path uses W4's one-step bump. *done_when:* stub invocation metadata reflects config-resolved tier; escalation test proves light→mid (or equivalent) on `model_capability`; provider-neutral — config swap changes model without code change.

**W8 — Budget governor (D22).** (M) In-memory circuit breaker: rolling window, session, and per-change token/cost ceilings evaluated between spine steps; pause carries `source: "budget" | "operator"`; auto-resume clears only budget-owned pauses; kill-switch on hard ceiling. *done_when:* exceeding a limit pauses the lineage; operator pause survives budget auto-resume; runaway retry loop hits kill-switch in a test.

**W9 — Spine integration loop (W2–W8).** (M) Extend skeleton run (or thin Phase 3 CLI): compile+freeze plan at pre-gate; classify door at admission; check budget between steps; on hold/reject classify failure and route (retry/escalate/human/repair/reject) without acting on malformed verdicts. *done_when:* integration test drives a post-gate-red hold through failure classification → transient retry (same tier) and separately → `model_capability` escalation; budget pause stops a looping variant; stale plan blocks start.

**W10 — Phase 3 acceptance + checklist.** (S; W9) Adversarial AC file mirroring Phase 2 pattern; CI green under Node. *done_when:* checklist file exists; `bun run check` and `npm run check:node` green; at least one test per spike S1–S4 and work items W2–W8.

### Cut lines (shed in this order if time runs short)

1. SQLite persistence for budget counters — keep in-memory governor; defer durable spend ledger to Phase 5/6.
2. Separate `.orchestrator/config.toml` — fold door/tier/budget into existing `gate.toml` sections first.
3. Full retry loop in W9 — keep classify+route observable in spine; defer automatic re-invocation to Phase 4 when real agents exist.
4. Operator pause UX — keep budget pause + source tagging; defer CLI/TUI for operator pause to Phase 5 HITL.

**Non-cuttable integrity floor (D25):** config-driven door with ambiguous→one-way default (S1/W2), full D4 taxonomy including `apply_failure` and malformed-verdict guard (S2/W3), plan compile+drift refusal (S3/W5), provider-neutral tier resolution (S4/W7), budget kill-switch with pause-source separation (W8).

### Exit criteria

W9/W10 green in CI under Node; S1–S4 each demonstrated by a passing test; spine no longer hardcodes `classifyTwoWay()` or `PHASE1_SKELETON_PLAN`; failure on post-gate red produces a classified verdict and correct routing action; mutating config after plan freeze refuses execution. At that point escalation and control-plane config are deterministic and Phase 4 (real agents) can build on the router and plan freezer.

### Estimate

Four spikes (one M door, one M failure, one M plan, one S tier) plus roughly two S and eight M work items. Cost is dominated by door signal correctness (S1/W2), failure evidence mapping (S2/W3), and plan drift (S3/W5) — not the spine wiring.

---

## 5. Phase 4 — Real Agents, Skills, Phase Pipeline (detailed)

Realizes spec **D2, D3, D7, D25** (and fills in the §8 control-flow phases). Builds on the Phase 1–3 integrity floor: lock (D23), gate (D8/D12/D16), scope + oracle-freeze (D6/D7), provenance (D10/D21), classifiers + router + budget + tier resolution (D4/D5/D18/D22), control-plane transitions (D19).

**Goal.** Replace the single stub invocation with the five real subagents (spec, planner, spiker, implementer, test-author) composed over a flat Pi skill library, driven through the spec → plan → (spike) → implement → validate pipeline, with the D7 oracle-authoring handoff (test-author freezes the oracle before the implementer runs, handed read-only) and the D25 minimal/full regime split — *without* yet adding lineage concurrency or the batched HITL queue (Phase 5), expand/contract (Phase 6), or a stochastic grader (D24, deferred). Tests use the **faux** provider (AGENTS.md): they prove the SDK/skill/composition shape, not live model quality.

**Why this shape.** The scariest remaining bet is the roadmap's own: *do composed agents over real skills produce gate-passing work through the SDK?* Everything else — phase sequencing, regime branching, checklist — is deterministic spine wiring that is lower risk once two contracts are proven: (1) agent⊕skill composition + invocation, and (2) the D7 oracle handoff that keeps the gradee away from the grader. So front-load those plus the byte-stable prefix (D26) and regime selection; the pipeline runner and per-agent definitions are assembly on top.

**Current-state anchors.**
- `AgentKind` already enumerates `spec | planner | spiker | implementer | test_author | stub` (`src/domain/agent.ts`); `stub` stays as the fallback/contract stand-in.
- `Regime`, `regimeForDoor`, `lineageRegime` exist (`src/domain/door.ts`, `src/domain/lineage.ts`); regime is derived from the door, never stored.
- Stub invocation, faux provider, scoped-write tool, and prompt-cache hints exist (`src/pi/invoke-stub-agent.ts`, `src/pi/prompt-cache.ts`).
- Oracle freeze, scope guard, and the Pi path-protection extension exist (`src/lib/oracle-freeze.ts`, `src/lib/scope-guard.ts`, `src/extensions/`).
- Tier resolution is config-driven and wired into invocation metadata (Phase 3 W7); `resolveModelTier` is the entry point.
- The single-shot loop `runSkeletonLineage` does lock → invoke → apply → PRE/POST gate → transition → provenance; Phase 4 generalizes it to a multi-phase runner.
- **Missing:** skills layer, per-agent definitions, context assembler, regime branching, multi-phase sequencing.

### Spikes (retire uncertainty first; throwaway-ish code)

**S1 — Agent⊕skill composition + invocation contract.** (M) Define one real agent (the implementer) as a Pi agent that loads a flat skill (a `SKILL.md` referencing a `lib/` script) and produces a scoped edit through the SDK, faux-backed. *done_when:* a faux-backed test invokes the implementer with a composed skill, the skill's doctrine is present in the assembled context, the agent emits a scoped edit, the result validates to the existing `AgentResult` shape, and the skill *references* (does not reimplement) the `lib/` script.

**S2 — Oracle authoring handoff (D7).** (M) The test-author writes only frozen-test paths; the spine freezes + hashes the oracle and hands it to the implementer read-only. *done_when:* a test shows the test-author output is frozen + hashed before the implementer runs, an implementer write to a frozen-test path is denied by scope/oracle integrity, and modifying the oracle classifies as a one-way door.

**S3 — Byte-stable prefix per agent type (D26).** (S) A context assembler produces a stable, ordered prefix (role/doctrine → skill(s) → tool defs → stable project context) with volatile data excluded. *done_when:* a determinism test asserts two different tasks for the same agent type produce byte-identical prefixes, and lineage/scope/ids appear only out-of-band, never in the prefix.

**S4 — Regime branch selection (D25).** (S) From the door, select full vs minimal regime and the phase sequence each runs; the integrity floor is identical in both. *done_when:* a one-way lineage's compiled phase list includes spec + planner + oracle-authoring and an await-human hold before merge; a two-way lineage collapses to inline target + reused oracle and auto-merges on green; a test asserts both share the same gate/scope/provenance floor.

### Work items

**W1 — Skill library + loader (D2, D12).** (M; S1) A flat skill registry — spec-authoring, planning, implementation, test-authoring, commit-pr `SKILL.md` docs that reference `lib/` scripts — and a loader that composes named skills onto an agent. *done_when:* each skill loads by name; a guard test asserts a skill body references the relevant `lib/` entry point and reimplements none of it; the loader composes ≥1 skill onto an agent invocation.

**W2 — Agent definitions (D3, D6, D18).** (M; S1, W1) Each of the five agents defined with model tier (spec = heavy; others per config), composed skills, and a declared path scope; invoked through the same SDK adapter as the stub. *done_when:* each agent resolves its tier via config (Phase-3 `resolveModelTier`), composes its skills, and runs faux-backed returning a validated result; the spiker's scope is throwaway and the test-author writes only frozen-test paths.

**W3 — Context assembler (D26, Risks §9).** (M; S3) `assembleAgentContext(agentType, skillVersions, task) → { prefix, tail, cacheHint }` with the cache breakpoint at the prefix boundary; all volatile data carried out-of-band. *done_when:* prefix is a pure function of `(agentType, skillVersion)`; the determinism test passes; a provider-neutral cache hint is emitted and integrates with `prompt-cache.ts`.

**W4 — Oracle-authoring phase (D7).** (M; S2) Wire test-author → `oracle-freeze` → implementer-read-only into the pipeline; the implementer's grant excludes frozen-test paths. *done_when:* in a full-regime run the oracle is frozen + hashed before the implementer is invoked; an implementer edit to a frozen path is hard-rejected as a scope/oracle violation; provenance records the frozen oracle hash.

**W5 — Phase pipeline runner (D §8, D19).** (L; W2, W4) Generalize `runSkeletonLineage` into a phase sequencer: spec → plan → (spike) → implement → validate, each phase an agent invocation plus deterministic checks, transitions derived in the control plane, budget checked between phases. *done_when:* an integration test drives a two-way change (minimal, spec-less) through implement → validate → merge, and a one-way change through spec → plan → oracle → implement → validate → await-human; Phase-3 failure routing fires between phases.

**W6 — Regime orchestration (D25).** (M; S4, W5) The runner selects the phase sequence from the lineage's regime; minimal reuses the existing frozen test set when it covers the criteria, else falls back to a test-author pass; full always authors spec/plan/oracle and holds for human. *done_when:* the coverage check decides reuse-vs-author deterministically; minimal-with-coverage skips test-author; minimal-without-coverage invokes it; full never collapses oracle-authoring or the human hold.

**W7 — Deterministic-first generate (D §8 step 2).** (S) Before invoking a model, attempt a registered deterministic path (codemod/template) for the task class; invoke the agent only if none applies. *done_when:* a task with a registered codemod produces the edit with zero model tokens; a task without one falls through to the agent; provenance distinguishes the two. *(Cut-line candidate.)*

**W8 — Spiker phase trigger (D25, D §8).** (S; W5) The spike runs in either regime only when an open question is declared; the spiker runs in a throwaway scope and its output never merges directly. *done_when:* a lineage with a declared open question runs the spiker before implement; the spiker's writes are confined to a throwaway scope and are not applied as the change. *(Cut-line candidate.)*

**W9 — Phase 4 acceptance + checklist.** (S; W1–W6) Adversarial AC file mirroring Phase 2/3; CI green under Node. *done_when:* `phase4-acceptance-checklist.md` exists; `bun run check` and `npm run check:node` green; ≥1 test per spike S1–S4 and work items W1–W6; the spine drives both regimes end-to-end with the stub retired from the default path.

### Cut lines (shed in this order if time runs short)

1. **W7 deterministic-first generate** — keep agent-always generate; add the codemod/template fast path later. Not load-bearing for proving composed agents.
2. **W8 spiker phase trigger** — keep the spiker *defined* (W2) but defer the in-pipeline trigger; spikes run manually until a lineage declares an open question.
3. **commit-pr skill body** — keep the other four skills; commit scaffolding stays the Phase-1 path until Phase 5's PR adapter lands.
4. **W6 minimal-regime oracle-reuse coverage check** — default to always running test-author when coverage is uncertain. Integrity (separate authoring + freeze) holds either way; only the ceremony-collapse optimization is deferred.

**Non-cuttable integrity floor (D25):** separate test-author authoring + oracle freeze before the implementer (D7); the implementer never authors or edits its grader (scope/oracle integrity); the deterministic gate as sole acceptance authority (D8); capability scoping from the control plane (D6); control-plane-derived transitions (D19); provenance incl. frozen oracle + plan hash (D10/D21); budget breaker between phases (D22); one-way doors hold for human and never auto-merge (D5/D11); byte-stable prefix and out-of-band scope (D26/D6).

### Exit criteria

W5/W6/W9 green in CI under Node; S1–S4 each demonstrated by a passing test; the spine drives a two-way change through the minimal regime to auto-merge and a one-way change through the full regime to an await-human hold, both over real (faux-backed) composed agents; the implementer provably cannot author or edit its oracle; the per-agent prefix is byte-stable. At that point composed agents over skills produce gate-passing work, and Phase 5 (concurrency + HITL) and Phase 6 (stateful rollout) can build on the pipeline.

### Estimate

Four spikes (two M agent/oracle, two S prefix/regime) plus roughly four S and four M/L work items. Cost is dominated by the agent⊕skill composition contract (S1/W1/W2), the D7 oracle handoff (S2/W4), and the multi-phase runner (W5) — not the regime branching or the checklist.

### Dependency order

S1 → W1 → W2 ; S2 → W4 ; S3 → W3 ; S4 → W6 | W2 + W4 → W5 → W6 → W9 ; W7 and W8 are parallel/cut.
