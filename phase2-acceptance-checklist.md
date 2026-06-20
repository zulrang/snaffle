# Phase 2 — Acceptance Checklist

Adversarial AC for **Phase 2: Deterministic Gate Hardened + Repo Modes**. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green.

## S0 — Node-compat floor (D17/D18)

- [x] `npm run check:node` passes on a clean checkout — CI + local `check:node`
- [x] `scripts/guard-no-bun-native.mjs` fails on reintroduced Bun-native APIs — runs in `bun run check` (`guard:bun-native`)

## S1 / W4 — contract-diff teeth

- [x] Reshaped exported interface → `contract_diff` **red** — `src/lib/contract-diff.test.ts`
- [x] Behavior-preserving field reorder → **green** — `src/lib/contract-diff.test.ts`
- [x] Reshaped Pi `Type.Object` tool schema → **red** — `src/lib/contract-diff.test.ts`

## S2 / W5 — wrap-mode baseline (D16)

- [x] Known-red tree with baseline → PRE **allows** start — `src/lib/gate-baseline.test.ts`
- [x] New failure vs baseline → PRE **blocks** — `src/lib/gate-baseline.test.ts`
- [x] Green tree → PRE **allows** start — `src/lib/gate-baseline.test.ts`
- [x] Baseline hash recomputes from stored inputs — `src/lib/gate-baseline.test.ts`

## S3 / W6 — greenfield bootstrap

- [x] Empty repo bootstrap → `.snaffle/gate.toml` + runnable check — `src/lib/gate-bootstrap.test.ts`
- [x] Green PRE on fresh greenfield without hand-editing — `src/lib/gate-bootstrap.test.ts`

## W1 / D12 — PRE/POST identity

- [x] PRE and POST share the same `GATE_DETERMINISTIC_ENTRY` and stage set — `src/lib/phase2-gate.test.ts`
- [x] Multi-stage runner fail-fast on first red — `src/lib/phase2-gate.test.ts`, `src/lib/gate-runner.test.ts`

## W2 — tiers

- [x] `--affected` and `--full` dispatch the same stage functions; overlapping kinds agree — `src/lib/phase2-gate.test.ts`

## W7 — scope + oracle integrity (D6/D7)

- [x] Frozen oracle edit blocked by `evaluateToolCallUnderGrant` — `src/lib/phase2-gate.test.ts`
- [x] `oracle_integrity` gate stage red when oracle hash drifts — `src/lib/phase2-gate.test.ts`

## W8 — integration

- [x] Walking skeleton (Phase 1 W8) green — `src/spine/skeleton-run.test.ts`
- [x] Phase 2 gate integration — `src/lib/phase2-gate.test.ts`

## Non-cuttable floor (D25)

- Node-compat guard + CI-under-Node
- PRE/POST single-path identity
- contract-diff teeth
- baseline-regression correctness
- scope + oracle integrity
