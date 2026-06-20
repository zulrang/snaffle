---
name: snaffle
description: Route code changes through Snaffle's deterministic spine instead of editing files directly. Authors a task file and invokes `snaffle run`, then reports lineage state, decisions, and escapes. Use when the user asks to change, add, fix, or refactor code in this repo, or says "snaffle", "route through snaffle", or "run it through the spine". Do NOT use for reading/explaining code, answering questions, or running `bun run check` manually.
---

# Snaffle routing skill

**Audience:** external task authors (Cursor, Pi interactive, human operators) —
**not** Snaffle's internal subagents. Spec/planner/implementer/test-author agents
invoked by the spine get their own doctrine via `src/skills/` and must never load
this skill or route through Snaffle.

You are the **task author**, not the editor. Snaffle is the external control
plane; it drives its own subagents (spec/planner/implementer/test-author) in an
isolated worktree under a single-writer lock, runs the deterministic gate, and
parks or merges. Your job is to hand it a well-formed task and report back.

Never edit repo files directly to satisfy a code-change request. Author a task
file and let `snaffle run` do the work.

## When to use

- User asks to change, add, fix, or refactor code in this repo.
- User says "snaffle", "route through snaffle", "run it through the spine".

Do **not** use for: reading/explaining code, Q&A, running `bun run check`
yourself, or anything outside this repo.

## Task intake contract

Every task is a JSON file under `.snaffle/tasks/<slug>.json`. Required
fields (see `src/lib/dogfood-task.ts` for the parser, `docs/dogfood-task.example.json` for an example):

```json
{
  "goal": "User-visible change being requested. One sentence.",
  "scope": ["repo/relative/paths", "or/dirs"],
  "acceptanceCriteria": ["bun run check remains green", "..."],
  "scriptedWrites": [
    { "path": "path/relative/to/repo", "content": "exact file contents" }
  ]
}
```

Rules:

- `goal` — non-empty, user-visible outcome, not an implementation plan.
- `scope` — repo-relative paths/dirs Snaffle may write. Declare the **minimum**
  set. Broad scope = one-way door risk.
- `acceptanceCriteria` — checks/behavior that make it done. `"bun run check
  remains green"` is the floor.
- `scriptedWrites` — **currently required** while the default run path is
  faux-backed. Author the exact intended file contents here. When live model
  generation is wired, this field becomes optional and you should omit it for
  non-deterministic work; for now it is how the edit actually lands.

## Door hints (classify before authoring)

Before writing the task, decide the door class. Snaffle's classifier is
authoritative, but your scope choice drives it:

- **Two-way** (reversible): edits to leaf code/docs not in the public-contract
  list. Auto-merges if green and not sampled.
- **One-way** (needs human): touches anything in `[door.paths].public_contract`
  of `.snaffle/gate.toml` — gate/scope/oracle/door/transition/spine/pi/
  extensions/scripts/workflows/package.json. These park at `awaiting_human`
  and never auto-merge.

When unsure, declare the narrower scope so it lands two-way; let Snaffle's
classifier widen to one-way if a path matches. **Never** widen scope to avoid
the human queue.

## Running

```bash
bun run snaffle -- run --task-file .snaffle/tasks/<slug>.json
```

Optional `--config-file <path>` to override `.snaffle/gate.toml`. Optional
`--owner <your-id>` to attribute the write lock.

Exit codes: `0` = merged, `1` = parked (awaiting_human) or non-merged terminal,
`2`/`3` = error (see stderr JSON).

## Reporting back

After the run, read the JSON on stdout and report to the user, concisely:

- `outcome.terminal.kind` — `merged` | `awaiting_human` | `rejected` | ...
- `lineageId` — the run id, for follow-up commands.
- If `awaiting_human`: tell the user the next steps (do **not** run them
  yourself unless asked):
  - `bun run snaffle -- decisions approve --lineage <id>`
  - `bun run snaffle -- resume --lineage <id> --no-push` (trust window)
  - drop `--no-push` when they want it to ship.

Then inspect if asked:

```bash
bun run snaffle -- status --repo . --limit 20
bun run snaffle -- decisions list --repo .
bun run snaffle -- escapes list --repo .
```

## Self-editing hazard (Snaffle editing Snaffle)

If the requested change touches any of these, the run **will** be one-way and
park for human review — that is correct, do not try to avoid it:

- `src/lib/gate-*`, `src/lib/scope-guard.ts`, `src/lib/oracle-freeze.ts`,
  `src/lib/door-classifier.ts`
- `src/domain/door.ts`, `src/domain/transition.ts`
- `src/spine/control-plane-transition.ts`, `src/spine/phase-pipeline.ts`,
  `src/spine/regime-cli.ts`
- `src/pi/invoke-stub-agent.ts`, `src/extensions/path-protection.ts`
- `scripts/guard-*`, `.github/workflows/**`, `package.json`

A run that could weaken its own gate and then pass itself is recursive grader
capture — the D7 failure pointed inward. Keep gate/enforcement changes in
their own task, separate from feature work.

## Do not

- Do not run `snaffle run` without a task file you authored.
- Do not invent `scope` broader than the user asked.
- Do not run `decisions approve` / `resume` unprompted — those are human
  authorization steps. Offer them.
- Do not reimplement gate/scope/door logic yourself (D12). Snaffle owns it.
