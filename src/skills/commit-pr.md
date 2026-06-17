<!-- skill-version: 1 -->
# Commit-PR skill

Doctrine for scaffolding the commit / pull request once a lineage is green. The
commit is mechanical: the control plane derives the merge transition (D19); this
skill only shapes the message and PR body from the lineage's provenance.

## Doctrine

- The commit message states *why*, not a restatement of the diff.
- One lineage is one logical change; do not bundle unrelated work.
- A one-way door never auto-merges — it pauses at the human queue first (D5/D11);
  a two-way door auto-merges on green.

## Hand-off (do not reimplement)

Commit scaffolding and the eventual PR adapter wrap deterministic substrate; this
skill references it rather than copying it:

- `src/lib/worktree.ts` — the isolated worktree the change was applied in.
- `src/lib/provenance-store.ts` — the content-addressed generation record that
  backs the PR body's audit trail (D10).
