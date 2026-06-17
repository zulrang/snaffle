# Phase 3 — Acceptance Checklist

Adversarial AC mirroring Phase 2 pattern. Gate: `bun run check` and `npm run check:node`.

## Spikes (S1–S4)

- [ ] **S1** Config-driven door signals — TOML path patterns classify scopes; ambiguous → one-way
- [ ] **S2** Failure evidence → full D4 taxonomy incl. `apply_failure` + malformed guard
- [ ] **S3** Plan compile + content hash + drift refusal + last-good retention
- [ ] **S4** Provider-neutral light/mid/heavy tier resolution from TOML

## Work items (W2–W8)

- [ ] **W2** `classifyDoor(scope, hints, config)` — sole door entry point for spine
- [ ] **W3** `classifyFailure(evidence) → FailureVerdict` over typed evidence union
- [ ] **W4** Failure router — bounded transient retry + single escalation
- [ ] **W5** `compileExecutionPlan` + `assertPlanFresh` + disk retention
- [ ] **W6** Provenance carries real frozen plan hash (not `PHASE1_SKELETON_PLAN`)
- [ ] **W7** `resolveModelTier` + escalation path through config
- [ ] **W8** Budget circuit breaker — pause source, auto-resume, kill-switch

## Spine integration (W9)

- [ ] Plan freeze at pre-gate; stale config after freeze blocks start
- [ ] Door classified from repo config at admission (no hardcoded `classifyTwoWay()`)
- [ ] Post-gate red → classified verdict + routing action observable in outcome
- [ ] Budget evaluated between spine steps

## Non-cuttable floor (D25)

- [ ] Ambiguous door → one-way default
- [ ] Malformed verdict → human route, never acted on
- [ ] Plan drift refused after freeze
- [ ] Tier resolution provider-neutral via config
- [ ] Budget kill-switch with operator/budget pause separation
