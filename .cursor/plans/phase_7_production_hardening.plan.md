---
name: Phase 7 production hardening
overview: Plan Phase 7 (live GitHub/rollout adapters, durable budget ledger, escape remediation loop, optional gate stages) in the Phase 1–6 shape. Default CI stays offline; live paths are env-gated. No stochastic grader in merge path (D24 data-gated only).
todos:
  - id: s1-gh-adapter
    content: "S1: Live gh PR adapter contract — degrade like dry-run on failure"
    status: completed
  - id: s2-live-rollout
    content: "S2: Live rollout vendor adapter behind RolloutClient"
    status: completed
  - id: s3-escape-remediation
    content: "S3: Escape → criteria remediation hook — pure lib, template-driven"
    status: completed
  - id: s4-budget-ledger
    content: "S4: Durable budget ledger SQLite drop-in"
    status: completed
  - id: w1-gh-pr-adapter
    content: "W1: GhPrAdapter wired opt-in via config"
    status: completed
  - id: w2-live-rollout-client
    content: "W2: LiveRolloutClient + rollout.adapter config"
    status: completed
  - id: w3-ramp-cli
    content: "W3: orchestrator rollout status | resume CLI"
    status: completed
  - id: w4-budget-persist
    content: "W4: Optional budget persistence (W11 carry)"
    status: completed
  - id: w5-remediation-emitter
    content: "W5: proposeEscapeRemediation + persist under .orchestrator/"
    status: completed
  - id: w6-remediation-cli
    content: "W6: escapes propose | apply-criteria CLI"
    status: completed
  - id: w7-gate-stages
    content: "W7: Optional spec_traceability + smoke_budget gate stages"
    status: completed
  - id: w8-live-model-smoke
    content: "W8: Env-gated real-model smoke test"
    status: completed
  - id: w9-production-loop
    content: "W9: Spine production loop integration (offline mirror in CI)"
    status: completed
  - id: w10-acceptance
    content: "W10: phase7-acceptance-checklist.md + mark Phase 7 complete"
    status: completed
isProject: false
---

# Phase 7 — Production Hardening, Live Adapters, Escape Feedback

**Spec:** D8 (live post-launch), D11 (live PR), D22 (durable budget), D24 (escape feedback)  
**Build plan:** `deterministic-agent-delivery-pipeline-plan.md` §8  
**Prerequisite:** Phase 6 complete (`f1631f6`, 313 tests)

**Status:** Complete — see `phase7-acceptance-checklist.md` and commit `d678ec2`.

## Risk order

1. **Adapter fidelity** — live `gh` and rollout vendors match injected contracts (S1/S2 → W1/W2)
2. **Operator loop** — ramp CLI + rollout status after auto-rollback (W3)
3. **Escape feedback** — clusters drive criteria proposals, not downstream patches (S3 → W5/W6)
4. **Durability + gate depth** — budget ledger (S4/W4), optional stages (W7)

## First spikes to run

1. `S1` — prove `gh pr create` mapping from existing provenance payload in env-gated test
2. `S3` — prove template-driven remediation proposal from a fixture escape cluster

## Non-cuttable

- Pre-merge gate sole merge blocker
- Live adapter failure degrades like dry-run (never fake merge/green)
- No stochastic grader in acceptance path
- Remediation applies only through control-plane re-freeze

## Explicitly deferred

- D24 grader re-evaluation until escape data proves irreducible gap
- Multi-vendor rollout matrix (one backend + HTTP shim is enough for v1)
