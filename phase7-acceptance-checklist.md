# Phase 7 — Acceptance Checklist

Adversarial AC mirroring Phases 2–6. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green (342 tests, 1 env-gated skip).

## Spikes (S1–S4)

- [x] **S1** Live gh PR adapter contract — mock exec maps to `gh pr create` — `src/spikes/p7-s1-gh-pr-adapter.test.ts`
- [x] **S2** Live rollout webhook adapter — arm/poll/rollback shim — `src/spikes/p7-s2-live-rollout.test.ts`
- [x] **S3** Escape → criteria remediation hook — stable proposal hash — `src/spikes/p7-s3-escape-remediation.test.ts`
- [x] **S4** Durable budget ledger — counters survive reopen — `src/spikes/p7-s4-budget-ledger.test.ts`

## Work items (W1–W10)

- [x] **W1** `GhPrAdapter` — injected exec boundary — `src/lib/gh-pr-adapter.test.ts`
- [x] **W2** `LiveRolloutClient` — webhook `RolloutClient` + config adapter — `src/lib/live-rollout-client.test.ts`, `src/lib/orchestrator-config.test.ts`
- [x] **W3** Operator ramp CLI — `orchestrator rollout status|resume` — `src/spine/rollout-cli.test.ts`
- [x] **W4** Durable budget ledger — optional `[budget].persist` — `src/lib/budget-ledger.test.ts`
- [x] **W5** Escape remediation emitter — template proposals — `src/lib/escape-remediation.test.ts`
- [x] **W6** Remediation CLI — `escapes propose|apply-criteria` — `src/spine/escapes-cli.test.ts`
- [x] **W7** Optional gate stages — `spec_traceability` + `smoke_budget` fixtures — `src/lib/optional-gate-stages.test.ts`
- [x] **W8** Env-gated real-model smoke — skipped unless `SNAFFLE_LIVE_MODEL=1` — `src/spine/live-model-smoke.test.ts`
- [x] **W9** Spine production loop — offline mirror — `src/spine/phase7-integration.test.ts`
- [x] **W10** Phase 7 acceptance checklist — `phase7-acceptance-checklist.md`

## Non-cuttable integrity floor

- [x] Live adapter failure degrades like dry-run — `src/lib/gh-pr-adapter.test.ts`, `src/lib/live-rollout-client.test.ts`
- [x] Pre-merge gate sole merge blocker unchanged — existing Phase 6 floor green
- [x] Escape proposals require frozen snapshot integrity — `src/spine/escapes-cli.test.ts`
- [x] Apply-criteria re-freezes snapshot only; refuses drift/stale — `src/lib/escape-remediation.test.ts`
- [x] No stochastic grader in merge path — D24 deferred by design

## Deferred (per plan §8 cut lines)

- **Multi-vendor rollout matrix** — webhook shim only.
- **Live `gh` env-gated integration** — mock exec in CI; live path uses `defaultGhExec`.
