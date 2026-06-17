# Phase 2 Acceptance Checklist

Adversarial acceptance for **Deterministic Gate Hardened + Repo Modes**. Run after `bun run check` and `npm run check:node` are green.

## S0 — Node-compat floor (D17/D18)

- [ ] `npm run check:node` passes on a clean checkout (typecheck + lint + guard + node smoke).
- [ ] `scripts/guard-no-bun-native.mjs` fails if `bun:sqlite` or `Bun.spawn` is reintroduced in shipped `src/` (outside fixtures and `*.test.ts`).

## S1 / W4 — contract-diff teeth

- [ ] Deliberately reshape an exported interface → `contract_diff` stage is **red**.
- [ ] Reorder interface fields only (behavior-preserving) → `contract_diff` stays **green**.
- [ ] Reshape a Pi `Type.Object` tool schema → **red**.

## S2 / W5 — wrap-mode baseline (D16)

- [ ] Red tree with captured baseline: same failures → PRE **allows** start.
- [ ] Red tree with captured baseline: **new** failure → PRE **blocks**.
- [ ] Green tree → PRE **allows** start.
- [ ] Baseline hash recomputes from stored `failedCheckKeys`.

## S3 / W6 — greenfield bootstrap

- [ ] Empty repo + bootstrap → `.orchestrator/gate.toml` + runnable `check` script.
- [ ] Green PRE on fresh greenfield repo without hand-editing.

## W1 / D12 — PRE/POST identity

- [ ] PRE and POST traces show the same `GATE_DETERMINISTIC_ENTRY` and stage set.
- [ ] Multi-stage runner stops at first failing stage (fail-fast).

## W2 — tiers

- [ ] `--affected` and `--full` dispatch the same stage functions; overlapping kinds agree on verdict.

## W7 — scope + oracle integrity (D6/D7)

- [ ] Frozen oracle edit blocked by `evaluateToolCallUnderGrant` (same `lib` rule as Pi extension).
- [ ] `oracle_integrity` gate stage red when oracle file hash drifts.

## W8 — integration

- [ ] Walking skeleton (Phase 1 W8) still green under Bun.
- [ ] Phase 2 tests in `src/lib/phase2-gate.test.ts` green in CI.

## Non-cuttable floor (D25)

These must never be shed:

- Node-compat guard + CI-under-Node
- PRE/POST single-path identity
- contract-diff teeth
- baseline-regression correctness
- scope + oracle integrity
