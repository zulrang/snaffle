# Snaffle

**Snaffle** is a deterministic control plane (the **spine**) that drives stochastic coding agents over the [Pi](https://pi.dev) harness, calling models only where intent or novel synthesis is genuinely irreducible. Determinism is the default; the LLM is a subroutine; the human is the escalation valve for ambiguity, not for catching errors a script could catch for free.

See [`deterministic-agent-delivery-pipeline-spec.md`](./deterministic-agent-delivery-pipeline-spec.md) for the full spec and [`deterministic-agent-delivery-pipeline-plan.md`](./deterministic-agent-delivery-pipeline-plan.md) for the build plan.

> **Status:** Phase 2 (deterministic gate + repo modes) — complete. Phase 3 (classifiers, routing, budget, plan-freeze) — planned.

## Dependencies

Pinned Pi packages (`0.74.0`, `@earendil-works` scope):


| Package                           | Role                                                     |
| --------------------------------- | -------------------------------------------------------- |
| `@earendil-works/pi-agent-core`   | Agent loop, `beforeToolCall` enforcement                 |
| `@earendil-works/pi-ai`           | Unified model API; faux provider for deterministic tests |
| `@earendil-works/pi-coding-agent` | Pi extension API (`tool_call` gate)                      |


## Runtime & toolchain

- **Runtime (D17):** [Bun](https://bun.com) (`>= 1.3`) is the dev runtime — fast installs, native TS, `bun test`. The shipped artifact targets **Node (`>= 22`)** and uses no Bun-native APIs, so it sits natively alongside the npm-distributed Pi packages; `check:node` runs the suite under Node so the dev runtime cannot harden into a ship dependency.
- **Typechecker:** `tsc --noEmit` under a maximally strict `tsconfig` — illegal domain states should not typecheck.
- **Lint/format:** [Biome](https://biomejs.dev).
- **Tests:** Bun's built-in test runner.

## Getting started

```bash
bun install      # install dev dependencies
bun run check    # typecheck + lint + test (the local gate)
```

Individual scripts:


| Script              | What it does              |
| ------------------- | ------------------------- |
| `bun run typecheck` | `tsc --noEmit`            |
| `bun run test`      | `bun test`                |
| `bun run lint`      | `biome check .`           |
| `bun run lint:fix`  | `biome check --write .`   |
| `bun run format`    | `biome format --write .`  |
| `bun run check`     | all three gates, in order |


## CI

GitHub Actions runs `bun run check` on every push to `main` and on pull requests (`.github/workflows/check.yml`). This is the same gate the repo dogfoods locally — typecheck, lint, and the full test suite, including W8 integration tests that use git worktrees.

## Layout

```
src/
  domain/            Pure, runtime-agnostic core model (no I/O, no Pi SDK)
    shared/          Kernel: Result, Brand (nominal types), value objects
    ids.ts           Branded identifiers for every aggregate
    scope.ts         Capability grants & write-scope containment   (D6, D20)
    door.ts          Door classification & process regime           (D5, D25)
    lineage.ts       Lineage & frozen acceptance target             (D7, D20)
    agent.ts         Agent kinds & structured results (evidence)    (D3, D14, D19)
    gate.ts          Deterministic acceptance gate (PRE/POST)       (D8, D12)
    failure.ts       Failure classification & routing               (D4)
    transition.ts    Control-plane-derived state transitions        (D19, §8)
    provenance.ts    Content-addressed generation records           (D10, D21)
  lib/
    scope-guard.ts       Single copy of write-scope enforcement (D12) — shared by spine, Agent, extension
    capability-grant.ts  Per-invocation grant issuance (D6, W3)
    validate-agent-result.ts  Agent result artifact validation (D14, W4)
    gate-config.ts       Project gate command loading (D8, W5)
    gate-runner.ts       Shared PRE/POST deterministic gate runner (D8, D12, W5)
    transition-derivation.ts  Control-plane merge outcome from validated evidence (D19, W6)
    provenance-hash.ts   Content-addressed generation hashing (D10, W7)
    provenance-store.ts  SQLite provenance persistence (D10, D18, W7)
    skeleton-gate-fixture.ts  Non-recursive worktree gate fixture (W8)
    worktree-writes.ts   Apply orchestrator-known content into a worktree (W8)
    worktree.ts          Detached git worktrees for isolated gate runs (W5)
    ownership-lock.ts    Single-writer workspace lock (D23) — writer fail-fast, observer attach, stale reclaim
  spine/
    scoped-invocation.ts W3: grant → beforeToolCall guard → scope events surfaced to orchestrator
    stub-invocation.ts   W4: stub agent → validate result before control-plane inspection
    gate-invocation.ts   W5: isolated worktree PRE/POST gate via shared lib/ runner
    control-plane-transition.ts W6: review evidence and derive state transitions (D19)
    provenance-invocation.ts W7: log stub generation provenance to SQLite
    skeleton-run.ts    W8: end-to-end walking skeleton command
  pi/
    invoke-stub-agent.ts   S1: headless stub invocation via pi-agent-core + faux model
  extensions/
    path-protection.ts     S2: Pi extension factory over lib/scope-guard
  spikes/
    s1-headless-invocation.test.ts
    s2-path-protection.test.ts
  index.ts           Package entry point
```

## Phase 1 spikes (done)

**S1 — Pi SDK headless invocation.** `invokeStubAgent` drives `pi-agent-core`'s `Agent` non-interactively with a pinned faux model (`orchestrator-stub-v1`). No network, no interactive session. Returns a structured result: `status`, `edits`, `metadata` (model + SDK versions), mappable to domain `AgentResult`.

**S2 — Pi extension path protection.** `lib/scope-guard.ts` is the single enforcement implementation. It is wired two ways:

1. **Pi extension** — `createPathProtectionExtension(scope)` registers a `tool_call` handler (write/edit blocked outside spine-supplied allowed paths).
2. **pi-agent-core** — `createBeforeToolCallGuard(scope)` for orchestrator-driven runs.

Both paths share identical rules; tests prove in-scope writes succeed, out-of-scope writes are denied with an observable reason.

## Phase 1 work items

**W2 — Single-writer ownership lock (D23).** `acquireWriterLock` / `attachObserver` in `lib/ownership-lock.ts`:

- **Writer:** exclusive lock at `{workspace}/.orchestrator/ownership.lock.json` recording `ownerId`, `pid`, `startedAt`
- **Fail-fast:** a second writer gets `workspace_already_owned` while the pid is alive
- **Observer:** `attachObserver` reads the live claim without taking the lock
- **Release:** explicit `release()` and process exit/signal handlers on clean shutdown
- **Crash reclaim:** dead pid ⇒ stale lock removed via `reclaimStaleLock` (simulated with SIGKILL in tests)

**W3 — Capability grant + path protection (D6).** `issueCapabilityGrant` in `lib/capability-grant.ts` issues per-invocation authority; `invokeWithCapabilityGrant` in `spine/scoped-invocation.ts` wires `grant.scope` through `createBeforeToolCallGuard` (never from agent context). Both in-scope successes and out-of-scope denials are surfaced as `ScopeEvent`s on the spine outcome.

**W4 — Stub-agent invocation with validated results (D14).** `invokeValidatedStubAgent` in `spine/stub-invocation.ts` drives a single scoped edit via the stub agent and validates the returned artifact through `lib/validate-agent-result.ts` before exposing it as control-plane evidence. Malformed results are rejected and never acted on.

**W5 — Single deterministic gate, PRE and POST (D8).** `runDeterministicGate` in `lib/gate-runner.ts` is the single code path for PRE and POST — both run the project-configured `bun run check` from the worktree's `package.json`. `requireGreenPreGate` refuses to start on a red PRE state. `spine/gate-invocation.ts` creates detached worktrees and wires PRE/POST runs.

**W6 — Control-plane transition derivation (D19).** `applyControlPlaneTransition` in `lib/transition-derivation.ts` derives merge/hold/reject outcomes from validated agent results plus POST-gate evidence — never from the result alone. `reviewLineageTransition` in `spine/control-plane-transition.ts` wires lineage context into that review. A red POST-gate holds state; merge requires a green POST-gate review.

**W7 — Minimal provenance (D10).** `logStubGeneration` in `spine/provenance-invocation.ts` logs one content-addressed generation per stub run to SQLite (`.orchestrator/provenance.sqlite`). `lib/provenance-hash.ts` canonicalizes inputs and computes prompt/context/content hashes; `lib/provenance-store.ts` persists records with enough material to recompute and verify the stored context hash on read-back.

**W8 — End-to-end skeleton wiring.** `runSkeletonLineage` in `spine/skeleton-run.ts` composes W2–W7 behind one command: lock → scoped stub agent → worktree apply → PRE/POST gate → control-plane transition → provenance → release. Integration tests prove merge on a trivial two-way change, scope blocking (W3), and POST-gate rejection (W5/W6).

### Domain modelling principles

- **Type-first / make illegal states unrepresentable.** Branded value objects (`RepoPath`, `ContentHash`, ids) are only constructed through validating smart constructors that return `Result`, so an invalid instance cannot exist. Derived facts (a lineage's regime) are computed, never stored, so they cannot disagree with their source.
- **Determinism is testable in isolation.** Every domain decision — door → regime, failure → route, evidence → merge outcome — is a pure function with no model and no I/O, exercised directly by unit tests.
- **The domain depends on nothing.** Snaffle's domain layer is pure; infrastructure and the spine depend on `src/domain`, never the reverse.

## License

MIT
