# Phase 5 — Acceptance Checklist

Adversarial AC mirroring the Phase 2/3/4 pattern. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green (270 tests).

## Spikes (S1–S4)

- [x] **S1** Bounded-N concurrent worktrees under one lock — worktree creation serialized, gate execution concurrent, second writer fails fast — `src/spikes/p5-s1-concurrent-worktrees.test.ts`
- [x] **S2** Deterministic conflict admission + back-pressure — non-conflicting admitted, conflicting queued behind only its conflictor — `src/spikes/p5-s2-conflict-admission.test.ts`
- [x] **S3** Durable decision queue + resume — enqueue on `awaiting_human`, approve → merge, reject → `human_rejected`, queue empty ≠ goal met — `src/spikes/p5-s3-decision-queue.test.ts`
- [x] **S4** Offline-testable PR adapter boundary — dry-run client receives commit+PR payload; remote failure degrades to local queue — `src/spikes/p5-s4-pr-adapter.test.ts`

## Work items (W1–W9)

- [x] **W1** Acceptance-target snapshotter — computes hash, persists under `.orchestrator/`, reload + tamper detection — `src/lib/acceptance-snapshot.test.ts`
- [x] **W2** `DecisionId`/`BatchId` smart constructors; `admitted` state distinct from `running` — `src/lib/lineage-admission.test.ts`
- [x] **W3** Conflict admission in `lib/` — sole scheduler entry point over declared scope — `src/lib/conflict-admission.test.ts`
- [x] **W4** Bounded-N lineage scheduler — N+M at parallelism N, non-conflicting parallel, conflicting serializes, one writer lock — `src/lib/lineage-scheduler.test.ts`, `src/spine/lineage-batch.test.ts`
- [x] **W5** Batched HITL decision queue — SQLite enqueue on park, approve/reject via control plane — `src/lib/decision-queue.test.ts`
- [x] **W6** Risk-weighted two-way sampling — config-driven, deterministic per lineage id — `src/lib/two-way-sampler.test.ts`
- [x] **W7** GitHub PR adapter + commit scaffolder (dry-run) — provenance → payload; failure → local queue — `src/lib/pr-adapter.test.ts`
- [x] **W8** Decision CLI + default-path switch — `decisions list|approve|reject`; default `run` → regime pipeline; `--legacy-skeleton` for Phase-1 stub — `src/spine/phase1-cli.test.ts`, `src/spine/regime-cli.ts`
- [x] **W9** Spine concurrency integration loop — batch + queue + sampling + frozen snapshots under one lock — `src/spine/phase5-integration.test.ts`

## Throughput + human surface (exit criteria)

- [x] Scheduler runs bounded-N with deterministic conflict admission under one writer lock — `src/spine/lineage-batch.test.ts`, `src/spine/phase5-integration.test.ts`
- [x] One-way lineage parks and merges only after a queued human approval — `src/spine/phase5-integration.test.ts`, `src/lib/decision-queue.test.ts`
- [x] Sampled two-way parks in the queue; unsampled two-way auto-merges — `src/spine/phase5-integration.test.ts`, `src/lib/two-way-sampler.test.ts`
- [x] Acceptance judged against the frozen snapshot, not live source — `src/lib/acceptance-snapshot.test.ts`, `src/spine/phase5-integration.test.ts`
- [x] Default CLI drives the regime pipeline (skeleton behind `--legacy-skeleton`) — `src/spine/phase1-cli.test.ts`

## Non-cuttable integrity floor (D11, D20, D23)

- [x] Single writer lock held across the batch (D23) — `src/spine/lineage-batch.test.ts`, `src/spikes/p5-s1-concurrent-worktrees.test.ts`
- [x] One-way doors never auto-merge — park until positive decision (D5/D11) — `src/spine/phase5-integration.test.ts`, `src/spine/phase-pipeline.test.ts`
- [x] Closure is a positive decision, not queue-drain (D20) — `src/lib/decision-queue.test.ts`, `src/lib/human-decision.ts`
- [x] Conflict admission is scope-declared; non-conflicting work is never blocked (D20) — `src/lib/conflict-admission.test.ts`, `src/lib/lineage-scheduler.test.ts`
- [x] Phases 1–4 integrity floor unchanged (gate, scope, oracle-freeze, control-plane transitions) — existing Phase 4 checklist items remain green

## Deferred (per plan §6 cut lines)

- **D26 cache-affinity scheduling tiebreak (W4)** — FIFO admission only; prefix-affinity ordering later.
- **Live GitHub integration (W7)** — dry-run/injected client + local decision queue only; real `gh`/Octokit deferred.
- **Decision TUI (W8)** — plain `list/approve/reject` CLI only.
- **Risk-model sophistication in two-way sampling (W6)** — flat config sample rate; richer weighting later.
