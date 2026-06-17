# Deterministic Agent Delivery Pipeline

A deterministic control plane (the **spine**) that drives stochastic coding agents over the [Pi](https://pi.dev) harness, calling models only where intent or novel synthesis is genuinely irreducible. Determinism is the default; the LLM is a subroutine; the human is the escalation valve for ambiguity, not for catching errors a script could catch for free.

See [`deterministic-agent-delivery-pipeline-spec.md`](./deterministic-agent-delivery-pipeline-spec.md) for the full spec and [`deterministic-agent-delivery-pipeline-plan.md`](./deterministic-agent-delivery-pipeline-plan.md) for the build plan.

> **Status:** Phase 1 (walking skeleton) — in progress. Domain model and Pi integration spikes (S1, S2) are green; work items W2–W8 come next.

## Dependencies

Pinned Pi packages (`0.74.0`, `@earendil-works` scope):

| Package | Role |
| --- | --- |
| `@earendil-works/pi-agent-core` | Agent loop, `beforeToolCall` enforcement |
| `@earendil-works/pi-ai` | Unified model API; faux provider for deterministic tests |
| `@earendil-works/pi-coding-agent` | Pi extension API (`tool_call` gate) |

## Runtime & toolchain

- **Runtime:** [Bun](https://bun.com) (`>= 1.3`). Bun runs TypeScript directly and is npm-compatible, so it sits natively alongside the npm-distributed Pi packages. (This refines the spec's D17 "Node" choice; the domain layer is runtime-agnostic regardless.)
- **Typechecker:** `tsc --noEmit` under a maximally strict `tsconfig` — illegal domain states should not typecheck.
- **Lint/format:** [Biome](https://biomejs.dev).
- **Tests:** Bun's built-in test runner.

## Getting started

```bash
bun install      # install dev dependencies
bun run check    # typecheck + lint + test (the local gate)
```

Individual scripts:

| Script | What it does |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | `bun test` |
| `bun run lint` | `biome check .` |
| `bun run lint:fix` | `biome check --write .` |
| `bun run format` | `biome format --write .` |
| `bun run check` | all three gates, in order |

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
    scope-guard.ts   Single copy of write-scope enforcement (D12) — shared by spine, Agent, extension
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

### Domain modelling principles

- **Type-first / make illegal states unrepresentable.** Branded value objects (`RepoPath`, `ContentHash`, ids) are only constructed through validating smart constructors that return `Result`, so an invalid instance cannot exist. Derived facts (a lineage's regime) are computed, never stored, so they cannot disagree with their source.
- **Determinism is testable in isolation.** Every domain decision — door → regime, failure → route, evidence → merge outcome — is a pure function with no model and no I/O, exercised directly by unit tests.
- **The domain depends on nothing.** Infrastructure and the orchestrator depend on `src/domain`, never the reverse.

## License

MIT
