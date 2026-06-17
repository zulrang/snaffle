# Phase 6 — Acceptance Checklist

Adversarial AC mirroring Phases 2–5. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green (307 tests).

## Spikes (S1–S4)

- [x] **S1** Expand/contract plan from stateful door signals — stable plan, no-op for non-stateful — `src/spikes/p6-s1-expand-contract.test.ts`
- [x] **S2** Post-launch metric guardrail boundary — injected client arm/poll/rollback — `src/spikes/p6-s2-metric-guardrail.test.ts`
- [x] **S3** Oracle escape record + cluster query — idempotent durable store — `src/spikes/p6-s3-oracle-escape.test.ts`
- [x] **S4** Gate span promotion — PRE/POST linked by gateRunId/lineageId — `src/spikes/p6-s4-gate-spans.test.ts`

## Work items (W1–W12)

- [x] **W1** Stateful change detector — sole expand/contract entry point — `src/lib/stateful-change.test.ts`
- [x] **W2** Expand/contract emitter — hashed phases, persist, tamper detection — `src/lib/expand-contract.test.ts`
- [x] **W3** Expand/contract pipeline phases in full regime when stateful — `src/spine/phase-pipeline.test.ts`, `src/lib/regime-plan.test.ts`
- [x] **W4** Post-launch rollout config — `[rollout]` TOML section — `src/lib/orchestrator-config.test.ts`
- [x] **W5** Rollout guardrail runner — arm, breach rollback, degrade on failure — `src/lib/rollout-guardrail.test.ts`
- [x] **W6** Oracle-escape logger — SQLite store + cluster query — `src/lib/oracle-escape.test.ts`
- [x] **W7** Escapes CLI — `escapes list|report` — `src/spine/escapes-cli.test.ts`
- [x] **W8** Span store + gate span pairs — PRE/POST attribution — `src/lib/gate-spans.test.ts`
- [x] **W9** Governance policy pack loader — optional `[governance]` section — `src/lib/governance-policy.test.ts`
- [x] **W10** Name-branching guardrail — CI script flags stage literal branching — `scripts/guard-name-branching.mjs`
- [ ] **W11** Durable budget ledger — deferred (Phase 3/6 cut line)
- [x] **W12** Spine rollout integration loop — stateful + guardrail + escape + spans — `src/spine/phase6-integration.test.ts`
- [x] **W13** Phase 6 acceptance checklist — `phase6-acceptance-checklist.md`

## Non-cuttable integrity floor (D8/D9/D24)

- [x] Pre-merge gate remains sole merge blocker — post-launch guardrail does not fake green — `src/lib/rollout-guardrail.test.ts`
- [x] Stateful changes emit expand/contract choreography, not single-step revert — `src/lib/expand-contract.test.ts`, `src/spine/phase-pipeline.test.ts`
- [x] Oracle escapes logged with criterion clustering — `src/lib/oracle-escape.test.ts`
- [x] Phases 1–5 integrity floor unchanged — existing checklists remain green

## Deferred (per plan §7 cut lines)

- **W11 durable budget ledger** — in-memory governor remains default.
- **Live metrics/flags vendor integration (W5)** — injected client only.
- **Governance pack richness (W9)** — skeleton pack + W10 lint guardrail only.
- **spec_traceability / smoke_budget gate stages** — not added in Phase 6.
