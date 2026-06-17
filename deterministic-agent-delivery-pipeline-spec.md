# Snaffle — Spec

*Product name: **Snaffle**. This document records what the system is, why it exists, and the decisions already made. Items still undecided are not recorded here; they are being resolved in conversation and will be folded in as they close.*

---

## 1. Problem & Why

Coding agents are stochastic. Left to orchestrate themselves, they drift, silently widen their blast radius, grade their own work, and burn expensive model budget brute-forcing problems that were never model problems in the first place. The result is churn, unreviewable diff volume, and no audit trail.

The goal is a delivery pipeline that takes a change from intent through to a merged, traceable commit using **a deterministic control plane that calls stochastic models only where intent or novel synthesis is genuinely irreducible**, and that escalates to a human at decision points rather than at mechanical failures. Determinism is the default; the LLM is a subroutine; the human is the escalation valve for ambiguity, not for catching errors a script could catch for free.

## 2. Success Metrics

- Token spend per merged change trends down, because deterministic paths cost zero tokens and are tried first, and the failure classifier prevents looping expensive models on non-model failures.
- Budget is enforceable, not merely emergent: a runtime circuit breaker holds a hard ceiling with a kill-switch so a runaway loop is capped even when the average trend is healthy.
- Human time scales with the number of *decisions*, not the number of diffs (O(decisions), not O(diffs)).
- Every merged artifact is reproducible to the model, prompt, and context that produced it.
- Mechanical defects (type errors, contract breaks, scope violations) are caught with zero human involvement.
- No agent-authored change reaches `main` having graded its own correctness.
- Oracle escapes — changes that pass the deterministic gate but are caught wrong downstream (the mandatory one-way reviewer, the two-way sample, or post-launch metrics) — are logged and trend down, with clustering driving fixes to the criteria/test-author step rather than downstream patches.

## 3. Non-Goals

Stated first, because scope refused is the cheapest scope to cut.

- **Not** an autonomous "give it a ticket, get a PR" system with no human in the loop on irreversible changes.
- **Not** a replacement for human judgment on one-way-door decisions (spec intent, cut lines, production ramp).
- **Not** an LLM-orchestrated system. The orchestrator never reasons; it executes rules.
- **Not** a universal-process mandate. Trivial, reversible changes must be able to pass through with almost no ceremony.
- **Not** a model-benchmarking or eval harness (that is a separate, adjacent concern).

## 4. Context & Constraints

- The pipeline operates over a version-controlled codebase with a deterministic CI/test substrate as the source of truth.
- **Execution substrate is the Pi harness (pi.dev).** Agents are driven through Pi's runtime (`pi-agent-core`) over its unified provider API (`pi-ai`); reusable doctrine lives as Pi skills, project instructions via `AGENTS.md`. Pi's provider-agnostic API is the single integration point through which any model (Anthropic, OpenAI, Google, Bedrock, self-hosted, etc.) is reachable without changing an agent definition.
- **Distributed as an open-source tool.** Gate commands, the door taxonomy, model-tier mapping, and capability scopes are project configuration, not hardcoded. Governance policy (e.g. SR 11-7-style model-risk expectations) ships as an optional, pluggable policy pack rather than a core assumption.
- **Operates on both greenfield repositories and existing codebases.**
- Deterministic logic must be ordinary, unit-tested executables, callable without an LLM in the loop.

## 5. Requirements

### Functional
- Carry a change through phases: spec → plan → (spike) → implement → validate → commit/PR — the minimal (two-way) regime collapsing spec+plan into an inline target and reusing existing tests as the oracle when they cover the change (D25).
- Classify every change deterministically as a one-way or two-way door and set the process regime accordingly.
- Classify every failure deterministically and route it to retry, single-tier escalation, hard stop, or human — per failure type.
- Freeze the test oracle for a requirement before the implementing agent runs.
- Emit expand/contract migration choreography automatically for any change touching persisted state or a public contract.
- Maintain a batched human decision queue.
- Log content-addressed provenance for every model generation.
- Drive Pi agents programmatically (SDK/RPC) and consume their structured output.
- Capture a baseline ("characterization") of gate state for existing codebases and fail only on regressions relative to it; bootstrap a gate harness for greenfield repos.
- Run up to a configured number of lineages in parallel in isolated worktrees, back-pressuring only lineages whose declared scopes conflict.

### Non-Functional
- Determinism first: any step expressible as rules over declared facts must not call a model.
- Auditability: spec → plan → diff → commit must be fully traceable, and each diff traceable to its generation inputs.
- Reproducibility: pinned model versions and temperature 0 where the provider allows.
- Cost discipline: cheapest path first (deterministic > light model > heavier model); tiered gates (affected-tests inner loop, full suite at milestone boundaries).
- Containment: an agent's authority is bounded by the control plane and cannot be widened by anything the agent reads.
- Cache-efficiency: agent prompts are assembled stable-prefix-first with a cache breakpoint; per-invocation unique data is carried out-of-band, never in the prompt; the prefix for each agent type is byte-stable and asserted by a determinism test.
- Config-driven: gate commands, door taxonomy, tier mapping, and capability scopes are declared in project config; no project- or org-specific logic is hardcoded.

## 6. Architecture & Key Decisions

The system is **three orthogonal layers, not a nesting of one kind of thing**: a deterministic orchestrator (the spine), a flat reusable skill library (per-phase doctrine plus script wrappers), and a small set of isolated subagents that compose skills. Deterministic scripts are the shared substrate beneath all three, callable directly by the orchestrator and referenced by skills.

**D1 — Deterministic control plane; LLM as subroutine.**
The orchestrator owns the phase state machine, gates, routing, and the HITL queue, and contains no model calls. *Why:* putting control flow in an LLM is the core anti-pattern that produces drift and unauditability. *Rejected:* LLM-as-orchestrator.

**D2 — Three-layer topology; scripts as shared substrate.**
Orchestrator → invokes → agents → load → skills → wrap → scripts; and the orchestrator calls scripts directly with zero tokens. *Why:* agents are the heavy isolation/model boundary; skills are light, swappable knowledge that multiple agents reuse; binding them together kills reuse. *Rejected:* a single mega-skill owning subskills/subagents (god-object, breaks progressive disclosure); skills owning agents 1:1 (inverts isolation, forbids composition).

**D3 — Agents exist only where stochasticity is irreducible.**
Subagents: spec author, planner, spiker, implementer, test author. There is deliberately **no validation agent and no commit agent** — typecheck, tests, contract-diff, scope, and oracle integrity are deterministic scripts that alone decide pass/fail; no agent stands between a mechanical defect and its rejection. *Why:* an agent is a liability (cost, drift, attack surface); spend one only where intent or novel synthesis is required, and never let one own the acceptance verdict. *Rejected:* one agent per phase; an agent that owns the pass/fail verdict.

**D4 — Deterministic failure classifier drives escalation.**
Before any retry, the failure is classified, and only one verdict spends more model budget:
- *transient* → retry same model, bounded.
- *model_capability* → escalate one tier, once.
- *spec_defect / underspecified / contradictory* → route to human and back to the spec; do **not** bump the model.
- *scope_violation / oracle_tampering* → hard reject, zero retries, flag.
- *environment* → fix infra, not the diff.
- *apply_failure (control-plane fault)* → the agent emitted a legal result but the orchestrator failed while applying it → route to a control-plane repair path with explicit error context, **not** back to the model.
A classification is only actionable if its own emitted artifact validates: a verdict carried by a malformed handoff packet is itself a failure (route to human/repair) and is never acted on. *Why:* a stronger model cannot fix a wrong spec; it only fails more expensively, and a recovery agent acting on a malformed verdict diagnoses the wrong problem class. This also supplies the missing implementation→spec feedback edge. *Rejected:* uniform LIGHT→MID→HEAVY escalation on every failure; trusting an unvalidated classifier output.

**D5 — Deterministic door classifier sets the regime.**
Touches money, auth, persisted schema, a public contract, or an irreversible migration → one-way door → full regime + mandatory human sign-off. Otherwise → two-way door → minimal regime (D25), auto-merge on green. *Why:* process should track reversibility, not be uniform; this prevents heavyweight ceremony from taxing trivial work. *Rejected:* one uniform process for all changes.

**D6 — Authority comes from the control plane, never from content.**
Capability grants (write scope, allowed paths) are issued by the orchestrator and are not derivable from anything in the agent's context; untrusted context regions are segmented. *Why:* makes confused-deputy / prompt-injection containment structural rather than behavioral — an injected instruction still cannot widen blast radius. *Rejected:* agent self-determines its own scope.

**D7 — Oracle freeze and grader separation.**
Tests for a requirement are authored by a separate test-author agent, frozen and hashed before the implementer runs, and handed to the implementer read-only. Modifying the oracle is itself a one-way door. The acceptance target the oracle serves is likewise frozen and judged against an immutable snapshot, not the live editable source (D20). *Why:* if the agent writes both feature and tests, green proves nothing — the gradee can weaken the grader. *Rejected:* implementer authors its own tests.

**D8 — Deterministic acceptance gate, plus a post-launch metric gate.**
Pre-merge acceptance is a single deterministic gate, ordered cheapest-first (format/lint → types → affected tests → contract-diff → scope and oracle integrity → spec-traceability → smoke budgets); it is authoritative, the only thing that can block, and it judges against the frozen acceptance target (D20). Closure is a distinct, positive, lineage-scoped gate, not "queue empty" (D20). Post-launch: the real metric, measured behind a flag over real traffic, with an automated guardrail that auto-rolls-back the flag on threshold breach; a human owns the ramp. *Why:* mechanical defects are caught for free and deterministically, keeping a single source of acceptance truth; intent that a deterministic oracle cannot express is caught by the mandatory human on one-way doors (D5/D11) and by the post-launch metric, not by a second stochastic voice in the merge path. *Rejected:* an LLM that owns or shares the merge verdict; equating queue-drain with completion. (An additive stochastic grader was considered and deferred — see D24.)

**D9 — Stateful changes emit expand/contract by construction.**
Any change the door classifier marks as touching persisted state is forced to follow add-backward-compatible → dual-write/read → backfill → flip → contract. *Why:* once users create state under a new path, naive rollback is impossible. *Rejected:* "rollback" as a single revert.

**D10 — Deterministic provenance.**
Every generation is logged content-addressed: model, prompt, context hash, temperature/seed, tool versions. The frozen execution plan that produced the generation is itself a pinned, content-addressed input (D21), so provenance covers the control plane's configuration, not only the model call. *Why:* near-free audit trail and replay/diff capability; satisfies governance expectations. *Decision:* pin temperature to 0 and pin model versions where the provider allows.

**D11 — HITL as a batched decision queue.**
Humans own: door overrides, spec/cut-line approval for one-way doors, spike resolutions, the production ramp, and a risk-weighted *sample* of two-way-door diffs. Everything else is machine-gated. *Why:* converts review from O(diffs) to O(decisions), the only thing that scales against agent diff volume, and avoids per-item interrupt churn. *Rejected:* line-by-line human review of all agent output.

**D12 — Single source of truth for deterministic logic.**
Deterministic logic lives once in `lib/`, unit-tested; skills reference and wrap it, never reimplement it. The same gate code serves the agent's self-check (`--affected`) and the orchestrator's milestone gate (`--full`). *Why:* prevents script/skill duplication drift and guarantees the self-check and the authoritative gate agree.

**D13 — Execution substrate is the Pi harness (pi.dev).**
Agents run on Pi's runtime (`pi-agent-core`) over its unified provider API (`pi-ai`); reusable doctrine lives as Pi skills. *Why:* a minimal, primitives-first, MIT-licensed TypeScript harness whose single unified API reaches 20+ model providers (Anthropic, OpenAI, Google, xAI, DeepSeek, Bedrock, self-hosted) — giving model flexibility through one integration — and whose deliberately small core ("compose your own orchestration") is congruent with the external-spine design rather than fighting a built-in delegation loop. *Rejected:* Claude Code (capable, but its lead-agent loop and single-vendor model binding pull against D1 and the provider-flexibility goal); building a bespoke agent runtime.

**D14 — External orchestrator over Pi's SDK/RPC, with Pi extensions as the enforcement layer.**
The spine is a standalone deterministic program that invokes each agent through Pi's SDK/RPC (scoped context in, structured result out) rather than relying on harness-side delegation. The gate runner and scope/capability guard are *also* installed as Pi extensions (permission gates, path protection) so the same `lib/` rules are enforced inside interactive dev sessions, not only under the orchestrator. *Why:* only an external spine removes LLM reasoning from control flow (satisfying D1); Pi's first-class server-shaped SDK is a cleaner contract than a CLI print mode, and its native path protection enforces D6 (authority issued outside the agent) directly. *Rejected:* harness-side delegation/plan-mode (leaves sequencing in the LLM, compromising D1); a constrained lead agent (LLM-as-orchestrator in disguise). *Cost accepted:* a dependency on Pi's SDK and extension API surface, pinned by version.

**D15 — Open-source ⇒ config-driven, governance pluggable.**
The door taxonomy, gate commands, tier mapping, and capability scopes are declared in project config; SR 11-7-style governance is an optional policy pack. This is structural, not merely asserted: domain behavior is dispatched only through compiled, declared interfaces, so the typed path is the only path and config-keyed branching has nowhere to live. A best-effort AST/lint guardrail (a custom ESLint or ts-morph rule in CI) backstops it by flagging the common regressions — control-plane code comparing against known stage/work-family name literals or matching path substrings — with the caveat that static analysis catches the obvious reintroductions, not every dynamic one. *Why:* a general tool cannot assume one organization's stack or regulatory posture, and "no hardcoded logic" is only real if the architecture, not vigilance, prevents it.

**D16 — Both repo modes ⇒ characterization baseline + gate bootstrap.**
Wrap mode captures a baseline and fails only on *new* red relative to it; the absolute "refuse on a red tree" precondition is relaxed to "refuse on regression." Greenfield bootstraps the gate harness from config. *Why:* existing repos are frequently already red or untested, so an absolute-green precondition would make wrap mode unusable.

**D17 — Implemented in TypeScript/Node.**
The orchestrator and `lib/` are TypeScript on Node. *Why:* Pi itself is TypeScript and npm-distributed, so the orchestrator sits natively alongside `pi-agent-core` and `pi-ai`, shares its SDK types, and distributes via npm/`npx` into the same contributor ecosystem. *Rejected:* a Rust/Go single binary (better distribution, but introduces an FFI/process boundary to Pi's TS SDK for no benefit); Python (faster to prototype, heavier install friction and a second-class path to Pi's API).

**D18 — Default infrastructure (config-overridable).**
Project config in TOML. Pipeline state, the HITL queue, and provenance in SQLite, with diff artifacts on the filesystem (no daemon; queryable; OSS-friendly). HITL surface is GitHub PR checks and review comments in CI, with a local CLI/TUI for dev, behind a pluggable adapter. Model tiers are provider-neutral through Pi's `pi-ai` API — each tier (light/mid/heavy) maps to a configured model from any provider (Anthropic, OpenAI, Google, Bedrock, self-hosted), with no hardcoded vendor default. VCS/CI is GitHub-first through a `gh`/Actions adapter. *Why:* sensible zero-dependency defaults for an open-source tool, every one of them swappable via config so no choice is load-bearing.

**D19 — Results are evidence; the control plane derives every state transition.**
An agent result, even a successful one, never mutates authoritative state directly; the orchestrator inspects the validated result and applies the consequent transition itself. A green check does not move the item; an "approved" verdict does not close anything — the control plane does. *Why:* D6 stops content from widening *scope*; this stops a well-formed-but-wrong result from being trusted as a *transition*. Containment of authority and containment of state-change are separate guarantees, and both must be structural. *Rejected:* agents emitting state transitions directly.

**D20 — Frozen acceptance target; a lineage is a spec requirement; bounded, conflict-scoped concurrency.**
A *lineage* is a single spec requirement and its frozen acceptance target, including any remediations of failed attempts. On entry, the target's criteria are snapshotted to an immutable, hashed store, and all acceptance judges against that snapshot, not the live editable source. Up to *N* lineages (N configured) run in parallel in isolated worktrees under the single writer (D23); a new lineage is admitted unless its *declared* scope conflicts with an in-flight lineage, in which case it is back-pressured behind only the conflicting one — non-conflicting work is never blocked. Conflict is detected deterministically as overlap of declared write-scope / allowed paths or touched contracts (available up front because authority is declared, D6), not inferred after the fact. Completion is evaluated per lineage; same-lineage remediation stays actionable, and closure is a positive decision, not the incidental emptying of a queue. *Why:* generalizes the oracle-freeze rationale (D7) to intent itself; bounds blast-radius collisions without serializing the pipeline; and "queue empty" is not "goal met." *Rejected:* judging against mutable source; serializing all unrelated work behind one open target; equating backlog drain with completion.

**D21 — The execution plan is compiled, frozen, and drift-checked.**
Config, tier mapping, gate commands, door taxonomy, and capability scopes are compiled into a single frozen, inspectable plan before work runs; the orchestrator refuses to execute a stale plan once its inputs drift, while retaining the last-good plan for rollback and inspection. *Why:* reproducibility and audit must cover the control plane's own configuration, not only model generations (D10); a spine running on silently drifted config is itself non-deterministic. *Rejected:* interpreting loose config live on every step.

**D22 — Runtime budget is an enforced circuit breaker, not an emergent trend.**
Token/cost budgets (rolling window, session, per-change) are evaluated between steps and can pause work and auto-resume when blockers clear; pauses carry a source, so a budget pause never erases an operator pause and auto-resume clears only budget-owned pauses. *Why:* "deterministic-first" makes spend trend down on average, but a runaway loop still needs a hard ceiling with a kill-switch; cost discipline must be enforceable, not hoped for. *Rejected:* treating cheap-path-first as sufficient cost control.

**D23 — Single-writer control-plane ownership.**
Exactly one orchestrator owns a given workspace, enforced by an ownership lock; a second instance fails fast, read-only observers may attach without taking the lock, and "running" is a verifiable runtime claim rather than durable state. *Why:* a long-running spine that two processes can mutate concurrently corrupts the very state that makes the pipeline auditable. *Rejected:* leaving orchestrator concurrency undefined.

**D24 — Acceptance is deterministic-only; oracle escapes are instrumented; a grader is deferred.**
No stochastic grader sits in the acceptance path. When a passed-the-gate-but-wrong change is caught downstream — by the mandatory one-way-door reviewer, the risk-weighted two-way sample (D11), or a post-launch metric (D8) — it is logged as an *oracle escape* with its lineage and the missed criterion. Clustered escapes drive fixes to the criteria templates or the test-author step (the cause), not downstream patches. A grader is reintroduced only if a residual class of escapes proves irreducibly non-expressible as deterministic criteria, and then only scoped to one-way doors, off by default, with a precision target derived from the collected escape data. *Why:* one-way doors already carry a mandatory human intent-check (D5/D11), and a grader's only non-redundant coverage is two-way changes that passed a separately-authored frozen oracle and fell outside the sample — exactly the changes where a miss is cheapest and reversible; a standing stochastic component with unbounded precision and a constant draw on human attention does not earn that. *Rejected:* an additive stochastic acceptance grader in v1 (deferred to a measured, data-driven decision); replacing any deterministic check with a model.

**D25 — Two regimes (minimal/two-way and full/one-way) sharing one integrity floor.**
The door classifier (D5) selects a regime per lineage. The *full* regime (one-way doors) runs the formal spec-author and planner agents, a dedicated frozen-oracle authoring pass (D7), expand/contract where stateful (D9), and mandatory human sign-off before merge (D11). The *minimal* regime (two-way doors) collapses that ceremony: the acceptance target is an inline lightweight snapshot rather than an authored spec/plan, and the oracle is the existing frozen test set when it demonstrably covers the change's criteria — falling back to a test-author pass only when it does not. Both regimes share a non-collapsible integrity floor: the deterministic gate (D8) as sole acceptance authority, capability scoping (D6), oracle integrity (the implementer never authors or edits its grader, D7), provenance (D10), the budget breaker (D22), lineage conflict admission (D20), and control-plane-derived transitions (D19). The spike is orthogonal to regime — it runs in either, and only when an open question must be retired, never as a fixed phase. *Why:* process must track reversibility (D5) without ever trading away the guarantees that make a change safe to merge; ceremony scales down, integrity does not. *Rejected:* a uniform path that taxes trivial changes; a "fast path" that also drops the integrity floor.

**D26 — Prompt caching via stable-prefix assembly; cache-affinity is a scheduling tiebreak.**
Every agent invocation is assembled as a stable, ordered prefix (role/doctrine → skill(s) → tool definitions → stable project context) followed by a variable task tail, with a cache breakpoint at the prefix boundary. All per-invocation unique data (run/lineage ids, granted scope, nonces, timestamps) stays out of the prompt and is carried out-of-band via Pi extensions and metadata — the same discipline D6 already requires, so containment and cache-friendliness are one choice, not competing ones. The prefix for a given agent type is a pure function of agent-type and skill-version, asserted by a determinism test (two different tasks for the same agent produce byte-identical prefixes); volatile content is never interleaved ahead of doctrine. Because the acceptance target is frozen per lineage (D20), same-lineage remediation reuses the lineage's cached context across attempts. Caching is expressed provider-neutrally: the invoker emits a cache-hint that each `pi-ai` adapter realizes in its own mechanism (explicit breakpoints, automatic prefix caching, or explicit context caching), with per-provider cache settings in the tier config (D18). The scheduler treats cache-affinity as a *tiebreak only* — among ready, non-conflicting, equal-priority lineages it prefers grouping same-agent-type work, but risk/priority order and lineage conflict admission (D20) always win. *Why:* caching is real savings but strictly secondary to retiring risk in the right order; a cache-maximizing scheduler would subordinate the architecture's whole point to a cost optimization, and a wrong order wastes far more than cache misses save. *Rejected:* injecting scope/ids into the prompt (busts cache and weakens D6); a cache-maximizing scheduler that can delay higher-risk work; ignoring caching in scheduling entirely.

## 7. Component Responsibilities

- **Orchestrator (spine, deterministic):** phase state machine; invokes each agent through Pi's SDK/RPC (scoped context in, structured result out) rather than via harness-side delegation; runs the door and failure classifiers; enforces gates; issues capability grants as per-invocation tool/path scope; owns the HITL queue and the provenance log; compiles and freezes the execution plan and refuses stale plans (D21); derives every state transition from validated results (D19); holds the single-writer ownership lock (D23); enforces the budget circuit breaker (D22); schedules up to N parallel lineages and back-pressures conflicting ones by declared-scope overlap (D20).
- **`lib/` (deterministic scripts, no LLM, unit-tested, single copy):** door classifier, failure classifier, router, gate runner (typecheck/test/lint/contract-diff/perf-smoke), scope guard, oracle freeze, expand/contract emitter, context assembler (retrieval; produces a stable, ordered prompt prefix with a breakpoint and a provider-neutral cache hint, volatile data excluded from the prefix), commit scaffolder, provenance writer, baseline/characterization capture, plan compiler/freezer, acceptance-target snapshotter, result applier, budget governor, ownership lock, oracle-escape logger, lineage scheduler / declared-scope conflict detector.
- **Extensions (deterministic, Pi):** the gate runner and scope/capability guard installed as Pi extensions (permission gates, path protection), enforcing the same `lib/` rules inside interactive dev sessions.
- **Config (project-level):** declares gate commands, door taxonomy, model-tier mapping, and capability scopes; optional governance policy pack.
- **Skills (Pi skills — flat, reusable, per phase):** doctrine for spec-authoring, planning, implementation, test-authoring, commit-pr; each tells an agent how to invoke the relevant `lib/` scripts. Loaded on-demand and composed onto agents explicitly by the orchestrator.
- **Agents (Pi; isolation + model tier + path scope):** spec (heavy), planner, spiker (throwaway scope), implementer (write-scoped), test-author (writes only frozen test paths).

## 8. Control Flow (per work item)

The steps below are the shared integrity floor and run in both regimes. The full (one-way) regime additionally runs the spec/plan and dedicated oracle-authoring phases before step 1; the minimal (two-way) regime enters with an inline target and a reused oracle (D25). The one-way HITL pause at step 9 is the other regime difference.

1. **Pre-gate:** acquire the workspace ownership lock (D23); compile and freeze the execution plan (D21); admit the lineage only if its declared scope does not conflict with an in-flight lineage, else back-pressure it (D20); refuse to start on a regression from the captured baseline (or, greenfield, a red tree); assemble and validate context; resolve the door regime; snapshot the acceptance target (D20); issue scoped capabilities.
2. **Generate:** deterministic path first (codemod/template, zero tokens); invoke the appropriately-tiered subagent only if no deterministic path exists.
3. **Self-check:** agent runs the affected-tests gate on its own diff.
4. **Apply** in an isolated worktree/sandbox.
5. **Post-gate (deterministic, authoritative):** the same deterministic gate runs independently; scope and oracle integrity verified. Only this tier can block.
6. **Classify on failure** and route per D4; on scope/oracle violation, hard reject; on an orchestrator-side apply failure, route to control-plane repair; a verdict whose own artifact is malformed is itself a failure.
7. **Verify against the frozen spec** (`done_when` assertion) and **derive the transition in the control plane** (D19), then merge; full suite runs at milestone boundaries. Budget is checked between steps (D22).
8. **Closure** is a positive, lineage-scoped decision, not queue-emptiness (D20).
9. **One-way doors** pause at the HITL queue before merge; two-way doors auto-merge on green.

## 9. Risks & Mitigations

- **Garbage context → confident garbage.** The context assembler is the highest-leverage place for deterministic rigor and validation; treat retrieval quality as a first-class investment.
- **Cache fragmentation.** Interleaving per-task or per-run content into the prompt prefix silently destroys cache hits and inflates cost; the prefix byte-stability test (D26) and out-of-band scope (D6) prevent it.
- **Door miscategorization.** A one-way door wrongly tagged two-way bypasses the human gate. The door taxonomy is the other place to invest most, with conservative defaults (ambiguous → treat as one-way).
- **Provider nondeterminism.** Mitigated but not eliminated by temperature 0 and pinned versions; provenance enables replay/diff to detect drift.
- **Review-sample blind spots.** Risk-weight the sampled two-way diffs so the sample is not uniform.
- **Silent oracle escapes.** With no grader backstop, intent gaps a deterministic oracle cannot express rely on the mandatory one-way human and post-launch metrics to surface; instrument escapes (D24) so a real, irreducible gap becomes a measured signal rather than a silent miss, and fix the cause (criteria/test-author) rather than the symptom.
- **Malformed verdicts.** A recovery verdict or classifier output carried by an invalid artifact misroutes work; validate every classifier output before acting on it (D4, D19).
- **Concurrent control planes.** Two orchestrators on one workspace corrupt auditable state; single-writer ownership is mandatory (D23).

## 10. Rollout & Observability

- Each gate invocation is a span; pre/post deltas are visible as traces, so any new red is attributable to exactly one change.
- The contract-diff stage detects silently reshaped interfaces/tool schemas.
- Post-launch metrics feed the automated flag guardrail; dashboards are the acceptance oracle for D8.
- Oracle escapes are logged with lineage and missed criterion (D24); clustering triggers a fix at the criteria/test-author step.
- Rollback is rehearsed (dry-run) before it is needed; release tags are the rollback anchors.
