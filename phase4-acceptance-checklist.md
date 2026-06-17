# Phase 4 — Acceptance Checklist

Adversarial AC mirroring the Phase 2/3 pattern. Gate: `bun run check` and `npm run check:node`.

Each box names the test that proves it. `bun run check` is green (220 tests).

## Spikes (S1–S4)

- [x] **S1** Agent⊕skill composition — implementer loads a `SKILL.md` referencing `lib/`, emits a scoped edit, validates to `AgentResult` — `src/spikes/p4-s1-agent-skill.test.ts`
- [x] **S2** Oracle authoring handoff — test-author output frozen + hashed before implement; frozen-path write denied; post-freeze drift caught — `src/spikes/p4-s2-oracle-handoff.test.ts`
- [x] **S3** Byte-stable prefix per agent type; volatile data out-of-band — `src/lib/agent-context.test.ts`
- [x] **S4** Regime branch selection — full vs minimal phase list, shared integrity floor — `src/lib/regime-plan.test.ts`

## Work items (W1–W6, W8)

- [x] **W1** Flat skill library + loader; D12 guard rejects a skill that reimplements `lib/` — `src/lib/skills.test.ts`
- [x] **W2** Five agent definitions (tier, skills, scope policy); composed faux invocation tags the real agent kind — `src/spine/invoke-agent.test.ts`
- [x] **W3** `assembleAgentContext` stable prefix + variable tail; provider-neutral cache hint wired out-of-band — `src/lib/agent-context.test.ts`, `src/spine/invoke-agent.test.ts`
- [x] **W4** Oracle-authoring phase freezes + hashes before implement; frozen-path edit hard-rejected; oracle hash in provenance — `src/spine/oracle-authoring.test.ts`
- [x] **W5** Phase pipeline runner — two-way → implement→validate→merge; one-way → spec→plan→oracle→implement→validate→await-human; failure routed between phases — `src/spine/phase-pipeline.test.ts`
- [x] **W6** Regime orchestration — deterministic oracle-coverage decides reuse-vs-author; full never collapses oracle/human-hold — `src/lib/oracle-coverage.test.ts`, `src/spine/regime-orchestration.test.ts`
- [x] **W8** Spiker phase trigger — runs only on a declared open question, throwaway scope never applied — `src/spine/spiker-trigger.test.ts`

## Both regimes end-to-end (stub retired from the default path)

- [x] Two-way change drives the minimal regime to auto-merge over composed (faux-backed) agents — `src/spine/phase-pipeline.test.ts`, `src/spine/regime-orchestration.test.ts`
- [x] One-way change drives the full regime to an await-human hold over composed agents — `src/spine/phase-pipeline.test.ts`, `src/spine/regime-orchestration.test.ts`
- [x] Default Phase-4 path is `runLineageForRegime`/`runLineagePipeline` (real agent definitions), not `runSkeletonLineage` (the Phase-1 stub is no longer the default execution path) — `src/spine/phase-pipeline.ts`

## Non-cuttable integrity floor (D25)

- [x] Separate test-author authoring + oracle freeze before the implementer (D7) — `src/spine/oracle-authoring.test.ts`, `src/spikes/p4-s2-oracle-handoff.test.ts`
- [x] Implementer never authors or edits its grader (scope/oracle integrity) — `src/spine/oracle-authoring.test.ts`, `src/spine/invoke-agent.test.ts`
- [x] Deterministic gate as sole acceptance authority; control-plane-derived transitions (D8/D19) — `src/spine/phase-pipeline.test.ts`
- [x] Capability scoping from the control plane (D6) — `src/spine/invoke-agent.test.ts`
- [x] One-way doors hold for human and never auto-merge (D5/D11) — `src/spine/phase-pipeline.test.ts`, `src/spine/regime-orchestration.test.ts`
- [x] Byte-stable prefix and out-of-band scope/ids (D26/D6) — `src/lib/agent-context.test.ts`

## Deferred (per plan §5 cut lines)

- **W7 deterministic-first generate** (cut line 1) — kept agent-always-generate; the codemod/template fast path with token-free provenance lands later. Not load-bearing for proving composed agents over skills.
- **commit-pr skill body** beyond doctrine (cut line 3) — commit scaffolding stays the existing path until Phase 5's PR adapter.
