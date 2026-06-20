# Snaffle — Agent Context

Snaffle is a deterministic agent delivery pipeline: an external control-plane **spine** over Pi agents. Gate before claiming done: `bun run check`

## Routing code changes through Snaffle

For any request to **change, add, fix, or refactor code in this repo**, do not edit
repo files directly. Author a task file under `.orchestrator/tasks/<slug>.json`
and run `bun run orchestrator -- run --task-file <path>`. Load the `snaffle`
skill (`.pi/skills/snaffle/SKILL.md`) for the task-file schema, door hints, and
reporting steps. Snaffle drives its own subagents in an isolated worktree under
the single-writer lock; you are the task author, not the editor.

Do not run `decisions approve` / `resume` unprompted — those are human
authorization steps. Offer them when a run parks at `awaiting_human`.

Self-editing hazard: changes touching gate/scope/oracle/door/transition/spine/
pi/extensions/scripts/workflows/package.json are one-way and **must** park for
human review. Never widen scope to avoid the queue (recursive grader capture).

Reading, exploring, explaining code, and running `bun run check` manually are
not code-change requests — handle those directly.

## Entry Points

- Domain vocabulary: `src/domain/index.ts`
- Deterministic logic (single copy): `src/lib/`
- Orchestrator wiring (Phase 1 spine): `src/spine/`
- Pi invocation adapter: `src/pi/invoke-stub-agent.ts`
- Current work items and `done_when`: `deterministic-agent-delivery-pipeline-plan.md`

## Do Not Touch

- `bun.lock` (unless intentionally changing pinned deps)
- `node_modules/`
- `{workspace}/.orchestrator/` (runtime lock/state; gitignored)
- `src/lib/fixtures/` (subprocess crash tests; change only with matching test updates)

## Non-Obvious Rules

- **Layer direction:** `domain/` → nothing. `lib/` → `domain/` only. `spine/`, `pi/`, `extensions/` → `lib/` + `domain/`. Never import Pi SDK or I/O into `domain/`.
- **D12:** Gate, scope, lock, and classifier logic live once in `lib/`. Pi extensions and `beforeToolCall` hooks call `lib/` — do not reimplement rules in adapters.
- **D6 / D19:** Write scope and capability grants are issued by the spine per invocation, never read from agent context. Agent results are evidence; only the control plane derives state transitions.
- **Runtime (D17):** Bun (`>= 1.3`) is the dev runtime; **Node (`>= 22`) is the ship target**. Use no Bun-native APIs in shipped code (`guard:bun-native` + `check:node` enforce this). Pi packages are pinned at `@earendil-works/*@0.74.0` — do not bump without explicit intent.
- **Tests:** Pi integration tests use the **faux** provider (`registerFauxProvider`); they prove SDK shape, not live model calls. Real-model tests belong behind env-gated integration, not default CI.
- **Types:** Prefer branded ids, `Result`, and smart constructors so illegal states do not typecheck (`tsconfig` is maximally strict).

## Key Documents

- Architecture and decisions (D1–D25): `deterministic-agent-delivery-pipeline-spec.md`
- Phase 1 build plan, cut lines, exit criteria: `deterministic-agent-delivery-pipeline-plan.md`
- Prompt cache hints, skills prefix, provider mapping: `docs/prompt-cache.md`
