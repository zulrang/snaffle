---
name: Phase 6 stateful rollout governance
overview: Plan Phase 6 (expand/contract, post-launch metric gate, oracle escapes, spans, governance pack) in the Phase 1–5 shape — spikes first, work items with testable done_when, cut lines, exit criteria — building on the Phase 5 scheduler, queue, and snapshots. Offline/injected clients only in CI.
todos:
  - id: s1-expand-contract-plan
    content: "S1: Expand/contract plan from stateful door signals — stable multi-phase plan, no-op for non-stateful"
    status: completed
  - id: s2-metric-guardrail
    content: "S2: Post-launch metric guardrail boundary — injected client, arm/poll/rollback, no live network"
    status: completed
  - id: s3-oracle-escape-store
    content: "S3: Oracle escape record + cluster query — durable idempotent store"
    status: completed
  - id: s4-gate-spans
    content: "S4: Gate span promotion — PRE/POST linked spans with lineage/batch attribution"
    status: completed
  - id: w1-stateful-detector
    content: "W1: Stateful change detector (D9) — sole entry point for expand/contract"
    status: completed
  - id: w2-expand-contract-emitter
    content: "W2: Expand/contract emitter — hashed phases persisted under .orchestrator/"
    status: completed
  - id: w3-pipeline-phases
    content: "W3: Expand/contract pipeline phases in full regime when stateful"
    status: completed
  - id: w4-rollout-config
    content: "W4: Post-launch metric gate config — [rollout] TOML section compiled into plan"
    status: completed
  - id: w5-rollout-runner
    content: "W5: Rollout guardrail runner — arm after merge, auto-rollback on breach"
    status: completed
  - id: w6-escape-logger
    content: "W6: Oracle-escape logger wired from HITL, sample, metric sources"
    status: completed
  - id: w7-escape-cli
    content: "W7: escapes list | report CLI"
    status: completed
  - id: w8-span-store
    content: "W8: Span store + gate/batch wiring"
    status: completed
  - id: w9-governance-pack
    content: "W9: Governance policy pack loader (optional, plan-compiled)"
    status: completed
  - id: w10-name-branching-guard
    content: "W10: Name-branching AST/lint guardrail for lib/ and spine/"
    status: completed
  - id: w11-budget-ledger
    content: "W11: Durable budget ledger (optional cut-line)"
    status: completed
  - id: w12-integration
    content: "W12: Spine rollout integration loop — stateful + guardrail + escapes + spans"
    status: completed
  - id: w13-acceptance
    content: "W13: phase6-acceptance-checklist.md + mark Phase 6 complete"
    status: completed
isProject: false
---

# Phase 6 — Stateful Changes, Rollout, Governance, Escapes

**Spec:** D8 (post-launch), D9, D10 (spans), D15, D24  
**Build plan:** `deterministic-agent-delivery-pipeline-plan.md` §7  
**Prerequisite:** Phase 5 complete (`0e25ee5`, 270 tests)

**Status:** Complete — see `phase6-acceptance-checklist.md` and commit `f1631f6`.

## Risk order

1. **Expand/contract** — irreversible state without choreography (S1 → W1–W3)
2. **Post-launch guardrail** — long-loop acceptance without polluting pre-merge gate (S2 → W4–W5)
3. **Oracle escapes** — silent wrongness without a grader (S3 → W6–W7)
4. **Spans + governance** — observability and config-only dispatch (S4, W8–W10)

## First spikes to run

1. `S1` — prove a pure `lib/` plan emitter for `persisted_schema` scopes
2. `S2` — prove injected flag/metric client contract in a throwaway test file under `src/spikes/`

## Non-cuttable

- Pre-merge gate sole merge blocker
- No single-step revert on stateful changes
- Escapes logged at cause (criteria/test-author), not patched downstream
- No stochastic grader in acceptance path (D24)
