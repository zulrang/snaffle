# Methodology

Dogfooding Snaffle should follow Snaffle's own doctrine: start with the cheapest reversible change, human watching, tight budget, then earn trust before widening scope. Crawl, walk, run.

**Backlog:** what remains after Phases 1–7 and prioritized next work — [`docs/snaffle-backlog.md`](docs/snaffle-backlog.md).

## Current State Caveat

Before treating this as a live development runbook, verify the active `run` path is actually doing the work you expect. If the current spine path is still fixture-driven or faux-backed, use these stages to exercise control-plane mechanics only: lock, scope, PRE/POST gate, transition derivation, provenance, decisions, escapes, and PR rendering.

Do not start unattended dogfooding until the run path has:

- Live task intake instead of hard-coded default writes.
- Real model invocation for the selected tiers, not only recorded model metadata over a faux provider.
- A no-side-effect mode (`--dry-run`, `--no-push`, or equivalent) for the first full loop.
- A known PR publishing path: live `gh` when intentionally enabled, otherwise deterministic degradation to the local queue.

If no explicit no-side-effect mode exists yet, treat that as the first product gap to close before Stage 3.

## Stage 0 - Local Config

Stage zero is config. Set provider credentials for the live `pi-ai` provider, map the three tiers (`light`, `mid`, `heavy`) to real models, point the gate at `bun run check`, keep HITL sampling at 100%, and set tight budget caps for the first trust window. Keep `--owner` set so provenance attributes every run to you.

The target repo reads `.snaffle/gate.toml`, but `.snaffle/` is gitignored runtime state. Keep the actual local file uncommitted. Start from `docs/dogfood-gate.example.toml` and copy it locally before running.

Example starting point, with provider/model values replaced by the live model ids you intend to use:

```toml
tier = "full"
repo_mode = "wrap"

[[stages]]
kind = "full_tests"
command = ["bun", "run", "check"]

[tiers.light]
provider = "openrouter"
model = "google/gemini-3-flash-preview"

[tiers.mid]
provider = "openrouter"
model = "google/gemini-3-flash-preview"

[tiers.heavy]
provider = "openrouter"
model = "google/gemini-3-flash-preview"

[budget]
rolling_window_tokens = 50000
session_tokens = 25000
per_change_tokens = 10000
kill_switch_tokens = 75000
persist = true

[hitl]
two_way_sample_rate = 1.0

[door.paths]
public_contract = [
  "src/lib/gate-*",
  "src/lib/scope-guard.ts",
  "src/lib/oracle-freeze.ts",
  "src/lib/door-classifier.ts",
  "src/domain/door.ts",
  "src/domain/transition.ts",
  "src/spine/control-plane-transition.ts",
  "src/spine/phase-pipeline.ts",
  "src/spine/regime-cli.ts",
  "src/pi/invoke-stub-agent.ts",
  "src/extensions/path-protection.ts",
  "scripts/guard-*",
  ".github/workflows/**",
  "package.json",
]
```

Promotion out of Stage 0:

- `bun run check` is green when run by hand.
- `gh auth status` is green if live PR creation is enabled.
- The configured budget limits are intentionally small enough that a loop cannot get expensive.
- The dogfood config itself is either local-only or represented by a tracked template.

## Stage 1 - Characterize

Snaffle's repo is an existing codebase, so run in wrap mode and capture the baseline first (D16). That lets Snaffle fail only on regressions instead of refusing to start because of already-known red checks. Then run `status --limit <n>` and confirm the lock, state, and provenance reads all look right before asking it to change anything.

This is also the live re-run of the early spine acceptance criteria against the real repo.

Promotion out of Stage 1:

- The baseline is captured and reloadable.
- `status --limit <n>` shows the expected owner, lock state, recent provenance, and no surprising terminal states.
- Re-running the baseline/status sequence is deterministic.

## Stage 2 - No-Blast-Radius Warmup

Start with a zero-risk warmup before the first code change. Point Snaffle at reconciling planning docs that have drifted behind the build. This will not fully exercise the code gate, but it lets you watch the loop, decision surface, provenance, and PR adapter on work with little blast radius.

Promotion out of Stage 2:

- The run produces the expected branch/PR or local queue item.
- The diff is limited to the declared documentation scope.
- `status --limit <n>` explains the run without manual forensics.
- No unexpected scope denials, budget pauses, or classifier surprises occur.

## Stage 3 - First Code Change

The first real code change should be deliberately boring: trivial, already-test-covered, and two-way-door. Keep `[hitl].two_way_sample_rate = 1.0` so even green two-way candidates park for review during the first trust window.

Run it first in no-side-effect mode. Watch the whole loop: lock, agent, PRE gate, apply, POST gate, transition, provenance, decision item, and PR rendering. Then inspect `status --limit <n>` and `decisions list` to confirm it did exactly what you expected. Only then let it open a live PR.

Promotion out of Stage 3:

- At least three trivial two-way changes complete with green POST gates.
- Every diff was reviewed by a human before merge.
- No run changed files outside its declared scope.
- No run required manual state repair.

## Stage 4 - Escalation Drills

Exercise the escalations on purpose before depending on them. Feed it a one-way-door change by touching something in the door taxonomy, public contract, config, or protected path list, and confirm it stops at mandatory HITL sign-off. Feed it something deliberately underspecified and confirm the `spec_defect` or `underspecified` path routes to you instead of burning heavy-tier budget brute-forcing it.

Also test a failing POST gate and a remote PR adapter failure. You want to have seen every gate fire under your own hand before real backlog flows through.

Promotion out of Stage 4:

- One-way changes park in the human queue and never auto-merge.
- Underspecified work routes to humans without unnecessary model spend.
- PR publishing failure degrades to the local queue.
- Failure routes are visible in provenance and `status`.

## Stage 5 - Real Backlog

Let Snaffle carry a handful of genuine small tasks while you watch every two-way diff and the escape log. The first oracle escapes are useful signal: they tell you whether the acceptance criteria and test-author step are strong enough, and they are what the `escapes propose` flow is for.

Only reduce `[hitl].two_way_sample_rate` after the first trust window has enough evidence. A reasonable first reduction is from `1.0` to `0.5`, then lower only if escapes stay boring and every sampled diff matches expectations.

Promotion out of Stage 5:

- A small batch of real tasks lands without out-of-scope writes or unexplained transitions.
- Escape reports are empty or result in concrete criteria updates.
- Budget use is predictable per change.
- Human review is finding process signal, not repeatedly rescuing the same failure.

## Self-Editing Guardrails

Two hazards are specific to pointing Snaffle at itself.

The important one: when Snaffle edits Snaffle, the paths that enforce its guarantees must be one-way/protected paths in capability scope and door config. Otherwise a run could weaken its own gate and then pass itself, which is recursive grader capture, the exact failure D7 exists to prevent, now pointed inward.

At minimum, force one-way/manual review for changes touching:

- `src/lib/gate-*`
- `src/lib/scope-guard.ts`
- `src/lib/oracle-freeze.ts`
- `src/lib/door-classifier.ts`
- `src/domain/door.ts`
- `src/domain/transition.ts`
- `src/spine/control-plane-transition.ts`
- `src/spine/phase-pipeline.ts`
- `src/spine/regime-cli.ts`
- `src/pi/invoke-stub-agent.ts`
- `src/extensions/path-protection.ts`
- `scripts/guard-*`
- `.github/workflows/**`
- `package.json` scripts
- Any dogfood gate config template

Keep these changes in separate PRs from feature work. A feature PR should not also change the gate, classifier, scope guard, oracle freeze, PR adapter, or budget enforcement.

The second hazard is mechanical: have Snaffle operate in its own worktree/branch so its single-writer lock and your live editing are not fighting over the same tree.

## Task Intake Contract

Every dogfooded task should declare:

- Goal: the user-visible change being requested.
- Scope: repo-relative paths or directories Snaffle may write.
- Door hints: expected `two_way` or `one_way`, plus trigger tags if one-way.
- Acceptance criteria: the checks or behavior that make the task done.
- Budget cap: per-change token/cost ceiling.
- Side-effect mode: dry-run, local queue, or live PR.
- Rollback/escape handling: what to do if the gate passes but review finds an escape.

If any of these are missing, Snaffle should ask rather than infer a broad scope from prose.

For the current dogfood run path, use `bun run snaffle -- run --config-file docs/dogfood-gate.example.toml --task-file <path>` with a task file shaped like `docs/dogfood-task.example.json`. The temporary `scriptedWrites` field is intentionally explicit; remove it once task intake no longer needs a scripted expected write for deterministic warmups. With `[hitl].two_way_sample_rate = 1.0`, a green two-way run should park at `awaiting_human` and the CLI should exit `1`; confirm the durable item with `bun run snaffle -- decisions list`. Approval is authorization only: after `bun run snaffle -- decisions approve --lineage <id>`, run `bun run snaffle -- resume --lineage <id> --no-push` for the first trust window. Drop `--no-push` only when you intentionally want the locked continuation to commit and push, and add `--publish-pr` only when you intentionally want the continuation to call `gh pr create`. A PR publishing failure should write `.snaffle/pr-failures/<lineage>.json` rather than pretending a PR exists.

## Operations Loop

During the dogfood window, check the control plane after every run:

```bash
bun run snaffle -- status --repo . --limit 20
bun run snaffle -- decisions list --repo .
bun run snaffle -- escapes list --repo .
bun run snaffle -- escapes report --repo .
bun run snaffle -- rollout status --repo .
```

Recovery expectations:

- Stale lock: inspect `status`; only clear or supersede the lock after confirming the owning process is gone.
- Budget pause: resume only after identifying the loop or expensive phase that spent the budget.
- Pending decision: approve only from a reviewed diff; reject if scope, door class, or acceptance criteria were wrong.
- PR failure: verify the local queue item contains enough provenance to recreate the PR.
- Oracle escape: record it, run `escapes report`, propose criteria, and apply criteria only through the control-plane re-freeze path.