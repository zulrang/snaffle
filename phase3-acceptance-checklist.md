# Phase 3 — Acceptance Checklist

Adversarial AC mirroring Phase 2 pattern. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green (177 tests).

## Spikes (S1–S4)

- [x] **S1** Config-driven door signals — TOML path patterns classify scopes; ambiguous → one-way — `src/lib/door-classifier.test.ts`
- [x] **S2** Failure evidence → full D4 taxonomy incl. `apply_failure` + malformed guard — `src/lib/failure-classifier.test.ts`
- [x] **S3** Plan compile + content hash + drift refusal + last-good retention — `src/lib/plan-freezer.test.ts`
- [x] **S4** Provider-neutral light/mid/heavy tier resolution from TOML — `src/lib/tier-router.test.ts`

## Work items (W2–W8)

- [x] **W2** `classifyDoor(scope, hints, config)` — sole door entry point for spine — `src/lib/door-classifier.test.ts`, `src/spine/phase3-integration.test.ts`
- [x] **W3** `classifyFailure(evidence) → FailureVerdict` over typed evidence union — `src/lib/failure-classifier.test.ts`
- [x] **W4** Failure router — bounded transient retry + single escalation — `src/lib/failure-router.test.ts`
- [x] **W5** `compileExecutionPlan` + `assertPlanFresh` + disk retention — `src/lib/plan-freezer.test.ts`
- [x] **W6** Provenance carries real frozen plan hash (not `PHASE1_SKELETON_PLAN`) — `src/lib/provenance-hash.test.ts`
- [x] **W7** `resolveModelTier` + escalation path through config; metadata reflects config-resolved tier — `src/lib/tier-router.test.ts`, `src/spine/phase3-integration.test.ts`
- [x] **W8** Budget circuit breaker — pause source, auto-resume, kill-switch — `src/lib/budget-governor.test.ts`

## Spine integration (W9)

- [x] Plan freeze at pre-gate; stale config after freeze blocks start — `src/spine/phase3-integration.test.ts`, `src/lib/plan-freezer.test.ts`
- [x] Door classified from repo config at admission (no hardcoded `classifyTwoWay()`) — `src/spine/phase3-integration.test.ts`
- [x] Post-gate red → classified verdict + routing action observable in outcome — `src/spine/skeleton-run.test.ts`
- [x] Budget evaluated between spine steps — `src/spine/phase3-integration.test.ts`

## Non-cuttable floor (D25)

- [x] Ambiguous door → one-way default — `src/lib/door-classifier.test.ts`, `src/domain/domain.test.ts`
- [x] Malformed verdict → human route, never acted on — `src/lib/failure-classifier.test.ts`, `src/domain/domain.test.ts`
- [x] Plan drift refused after freeze — `src/lib/plan-freezer.test.ts`, `src/spine/phase3-integration.test.ts`
- [x] Tier resolution provider-neutral via config — `src/lib/tier-router.test.ts`, `src/spine/phase3-integration.test.ts`
- [x] Budget kill-switch with operator/budget pause separation — `src/lib/budget-governor.test.ts`, `src/spine/phase3-integration.test.ts`

## Deferred to Phase 4 (per plan §4 cut line 3)

- Automatic re-invocation/retry loop in the spine — classify+route is observable now; real agents land in Phase 4.
