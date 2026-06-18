# Snaffle

**Snaffle** is a deterministic control plane (the **spine**) that drives coding agents over the [Pi](https://pi.dev) harness. The spine owns locks, gates, scope, provenance, and merge decisions; agents produce evidence, not authority. Models run only where intent or synthesis is genuinely irreducible — everything else is scripts, tests, and typed control-plane logic.

For architecture and design rationale, see [`deterministic-agent-delivery-pipeline-spec.md`](./deterministic-agent-delivery-pipeline-spec.md). Contributors: [`AGENTS.md`](./AGENTS.md).

## Requirements

- [Bun](https://bun.com) `>= 1.3` (dev runtime) or **Node** `>= 22` (ship target — `npm run check:node` verifies compatibility)
- Git (isolated worktrees for gate runs)
- Pi packages are pinned in `package.json` (`@earendil-works/*@0.74.0`)

## Install

```bash
bun install
bun run check    # typecheck + lint + guards + full test suite
```

Run the CLI from the repo:

```bash
bun run orchestrator -- <command> [options]
```

## CLI

All commands accept `--repo <path>` (defaults to the current directory). Output is JSON on stdout; non-zero exit codes indicate failure or a non-merge terminal.

| Command | Purpose |
| --- | --- |
| `orchestrator run` | Run a lineage through the regime pipeline (spec → plan → oracle → implement → validate, or the minimal two-way path) |
| `orchestrator status` | Lock state, frozen plan, and recent provenance |
| `orchestrator decisions list` | Pending human decisions (one-way doors, sampled two-way merges) |
| `orchestrator decisions approve --lineage <id>` | Authorize continuation for a parked lineage |
| `orchestrator decisions reject --lineage <id>` | Reject and close a parked lineage |
| `orchestrator resume --lineage <id>` | Resume an approved lineage: reapply, rerun POST gate, then merge |
| `orchestrator escapes list \| report \| propose` | Oracle escapes (gate greens that failed downstream) |
| `orchestrator escapes apply-criteria --criterion <id>` | Apply a remediation proposal via control-plane re-freeze |
| `orchestrator rollout status \| resume` | Post-merge flag guardrail state after merge |

**Flags for `run`:**

- `--legacy-skeleton` — Phase-1 single-shot stub path (for regression only)
- `--variant merge_success\|scope_blocked\|post_gate_rejected` — skeleton variants (legacy mode only)
- `--owner <id>` — writer lock owner id
- `--task-file <path>` — dogfood task JSON for the default regime path
- `--config-file <path>` — dogfood TOML config override for the default regime path

**Example:**

```bash
bun run orchestrator -- run --repo .
bun run orchestrator -- run --config-file docs/dogfood-gate.example.toml --task-file docs/dogfood-task.example.json
bun run orchestrator -- decisions list
bun run orchestrator -- decisions approve --lineage lineage-abc
bun run orchestrator -- resume --lineage lineage-abc
```

## Configuration

Snaffle reads project config from `.orchestrator/gate.toml` in the target repo. Gate stages, door taxonomy, model tiers, budget limits, HITL sampling, rollout, and governance all live in this file (or fall back to documented defaults when sections are absent).

Runtime state is written under `.orchestrator/` (gitignored): ownership lock, provenance SQLite, frozen execution plan, acceptance snapshots, decision queue, gate baselines, and oracle freeze records.

A minimal gate config might declare tier, repo mode, and stages:

```toml
tier = "full"
repoMode = "strict"

[[stages]]
kind = "lint"
command = ["npm", "run", "lint"]

[[stages]]
kind = "full_tests"
command = ["npm", "run", "test"]
```

Optional sections include `[door]`, `[tiers]`, `[budget]`, `[hitl]`, `[rollout]`, and `[governance]`. See `src/lib/orchestrator-config.test.ts` for parse examples.

**Live adapters** (opt-in, env-gated in tests):

- PR creation: configure the PR adapter in orchestrator config; requires `GH_TOKEN` for live `gh` mode
- Rollout: `[rollout]` with `adapter = "live"` and a webhook base URL
- Real models: set `SNAFFLE_LIVE_MODEL=1` for the env-gated smoke test (not run in default CI)

## How it works

1. **Admit** — Classify the change as one-way or two-way; snapshot the acceptance target; acquire the single-writer lock.
2. **Plan** — Compile and freeze the execution plan; refuse start if config drifts after freeze.
3. **Execute** — Run the regime-appropriate agent pipeline in an isolated worktree with per-invocation scope grants.
4. **Gate** — PRE and POST run the same deterministic multi-stage gate; POST red never merges.
5. **Decide** — The control plane derives transitions from gate evidence and door class; one-way changes park for human approval.
6. **Observe** — Provenance, gate spans, oracle escapes, and optional post-merge rollout guardrails.

Two-way changes on the minimal regime can auto-merge on a green gate. One-way changes always require an explicit human decision — draining the queue is not completion.

## Repository layout

```
src/
  domain/       Pure model — doors, lineages, gates, failures, transitions (no I/O)
  lib/          Deterministic logic — gate runner, classifiers, scope guard, stores
  spine/        Orchestrator wiring — CLI, pipeline, batch scheduler, HITL queue
  pi/           Pi SDK invocation adapter
  extensions/   Pi path-protection extension (delegates to lib/scope-guard)
  skills/       Agent skill docs composed at invocation time
```

Layer rule: `domain/` imports nothing; `lib/` imports `domain/` only; `spine/`, `pi/`, and `extensions/` import `lib/` + `domain/`.

## Development

| Script | What it does |
| --- | --- |
| `bun run check` | typecheck, lint, bun-native guard, name-branching guard, tests |
| `npm run check:node` | Same gates under Node (ship-target smoke) |
| `bun run test` | Test suite only |
| `bun run lint:fix` | Auto-fix Biome issues |

CI (`.github/workflows/check.yml`) runs `bun run check` on push and pull requests.

Pi integration tests use the **faux** provider — they prove SDK and composition shape, not live model quality.

## License

MIT
