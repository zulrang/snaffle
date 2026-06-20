# Snaffle

**Snaffle** helps you run AI coding helpers in a safe, step-by-step way.

Think of it like a traffic controller for code changes. Snaffle (the **spine**) decides *when* each step runs, *who* is allowed to change files, and *whether* the work is good enough to ship. The AI helpers do the work; Snaffle checks their work and keeps a log.

Snaffle works with [Pi](https://pi.dev), a toolkit for running coding agents (programs that read and write code for you). AI models are used only when a human judgment is truly needed. Most steps are plain scripts, tests, and fixed rules.

**Want more detail?** See [`deterministic-agent-delivery-pipeline-spec.md`](./deterministic-agent-delivery-pipeline-spec.md) for how Snaffle is designed. If you are changing the code, read [`AGENTS.md`](./AGENTS.md).

## What you need installed

- **[Bun](https://bun.com)** version 1.3 or newer — used to run Snaffle while you develop
- **Node.js** version 22 or newer — used to check that Snaffle also works in production-like setups (`npm run check:node`)
- **Git** — tracks code history; Snaffle uses separate Git workspaces so tests do not mess up your main copy
- Snaffle depends on Pi packages pinned in `package.json` (`@earendil-works/*@0.74.0`)

## Install

```bash
bun install
bun run check    # runs type checks, lint, guards, and all tests
```

Run Snaffle from this folder:

```bash
bun run snaffle -- <command> [options]
```

## Commands (CLI)

**CLI** means you type commands in a terminal instead of clicking buttons.

Most commands take `--repo <path>`. That is the folder with your project. If you leave it out, Snaffle uses the folder you are in now.

Snaffle prints **JSON** on success (structured text that other tools can read). If something fails, it exits with a non-zero code and does not treat the run as finished.

| Command | What it does |
| --- | --- |
| `snaffle run` | Runs the full pipeline: plan the work, run agents, run checks, and finish or pause |
| `snaffle status` | Shows lock state, frozen plan, and recent history |
| `snaffle decisions list` | Lists changes waiting for a human yes/no |
| `snaffle decisions approve --lineage <id>` | Lets a paused run continue after you approve |
| `snaffle decisions reject --lineage <id>` | Stops and closes a paused run |
| `snaffle resume --lineage <id> [--no-push]` | Continues an approved run; `--no-push` runs checks without saving or uploading to Git |
| `snaffle escapes list \| report \| propose` | Handles cases where early checks passed but later steps failed |
| `snaffle escapes apply-criteria --criterion <id>` | Applies a fix plan through Snaffle’s control layer |
| `snaffle rollout status \| resume` | Checks safety flags after code has been merged |

**Extra flags for `run`:**

- `--legacy-skeleton` — old single-shot test path (for regression tests only)
- `--variant merge_success\|scope_blocked\|post_gate_rejected` — test variants (legacy mode only)
- `--owner <id>` — who holds the write lock (only one writer at a time)
- `--task-file <path>` — JSON file describing the task for a demo run
- `--config-file <path>` — TOML config file for a demo run

**Examples:**

```bash
bun run snaffle -- run --repo .
bun run snaffle -- run --config-file docs/dogfood-gate.example.toml --task-file docs/dogfood-task.example.json
bun run snaffle -- decisions list
bun run snaffle -- decisions approve --lineage lineage-abc
bun run snaffle -- resume --lineage lineage-abc --no-push
```

## Configuration

Snaffle reads settings from `.snaffle/gate.toml` inside your project folder.

That file can define:

- **Gate stages** — commands that must pass (like lint or tests) before work continues
- **Door rules** — which changes need a human to approve
- **Model tiers** — which AI models to use and when
- **Budget limits** — caps on cost or usage
- **HITL** — “human in the loop”: when a person must review
- **Rollout** — checks after code is merged
- **Governance** — extra policy rules

If a section is missing, Snaffle uses built-in defaults.

While Snaffle runs, it also writes files under `.snaffle/` (this folder is ignored by Git). That includes locks, history, frozen plans, snapshots, decision queues, and PR failure queue items.

A small config might look like this:

```toml
tier = "full"
repo_mode = "strict"

[[stages]]
kind = "lint"
command = ["npm", "run", "lint"]

[[stages]]
kind = "full_tests"
command = ["npm", "run", "test"]
```

More examples live in `src/lib/orchestrator-config.test.ts`.

**Optional live integrations** (turned on by config and environment variables; not used in default CI):

- **Pull requests:** use `resume --publish-pr` after approval; failed `gh pr create` attempts degrade to `.snaffle/pr-failures/`
- **Rollout webhooks:** set `[rollout]` with `adapter = "live"` and a webhook URL
- **Real AI models:** set `SNAFFLE_LIVE_MODEL=1` for a smoke test with live models

## How a run works

1. **Admit** — Snaffle classifies the change, saves a snapshot of what “done” means, and grabs a single-writer lock so two runs do not clash.
2. **Plan** — Snaffle builds a fixed plan and refuses to start if settings change after that.
3. **Execute** — Agents run in an isolated Git workspace. Each step gets a clear list of files it may touch (**scope**).
4. **Gate** — Automated checks run before and after agent work. If the final checks fail, nothing merges.
5. **Park or continue** — Snaffle decides the next step from check results and door rules. Some changes pause and wait for a human.
6. **Approve** — A human approves the paused work. Approval does not merge or push by itself.
7. **Resume** — `resume --lineage <id>` runs final checks on the approved work, then commits and pushes. Use `--no-push` to validate without changing Git history, or `--publish-pr` to open a GitHub PR after the push.
8. **Observe** — Snaffle keeps logs, check timings, escape reports, and optional post-merge safety checks.

**Lineage** is Snaffle’s ID for one tracked run through this flow.

Some small changes can continue automatically when checks pass. Bigger or riskier changes always need a human decision. Clearing the approval queue is not the same as finishing — the resume step actually ships the work.

## Folder layout

```
src/
  domain/       Core ideas and types (no file or network access)
  lib/          Rules and helpers — gates, classifiers, scope checks, storage
  spine/        CLI, pipeline, scheduling, human-approval queue
  pi/           Connects Snaffle to the Pi agent toolkit
  extensions/   Pi add-ons (file protection uses lib/scope-guard)
  skills/       Instructions given to agents at run time
```

**Import rule:** `domain/` depends on nothing. `lib/` depends only on `domain/`. `spine/`, `pi/`, and `extensions/` depend on `lib/` and `domain/`. This keeps the core logic in one place.

## Development

| Script | What it does |
| --- | --- |
| `bun run check` | Typecheck, lint, guards, and full test suite |
| `npm run check:node` | Same checks under Node (production-style smoke test) |
| `bun run test` | Tests only |
| `bun run lint:fix` | Auto-fix style issues with Biome |

GitHub Actions (`.github/workflows/check.yml`) runs `bun run check` on every push and pull request.

Pi tests use a **faux** (fake) provider. They check that wiring works; they do not judge real AI output.

## License

MIT
