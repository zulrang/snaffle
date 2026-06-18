import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dogfoodTaskPrompt, parseDogfoodTask } from "./dogfood-task";

const must = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as T;
};

describe("dogfood task contract", () => {
  test("parses the minimal faux-backed task intake shape", () => {
    const task = must(
      parseDogfoodTask(
        JSON.stringify({
          goal: "Add a tiny covered helper.",
          scope: ["src/lib"],
          acceptanceCriteria: ["bun run check stays green"],
          scriptedWrites: [{ path: "src/lib/tiny-helper.ts", content: "export const x = 1;\n" }],
        }),
      ),
    );

    expect(task.goal).toBe("Add a tiny covered helper.");
    expect(task.scope).toEqual(["src/lib"]);
    expect(task.acceptanceCriteria).toEqual(["bun run check stays green"]);
    expect(task.scriptedWrites).toEqual([
      { path: "src/lib/tiny-helper.ts", content: "export const x = 1;\n" },
    ]);
  });

  test("fails closed on missing scripted writes", () => {
    const result = parseDogfoodTask(
      JSON.stringify({
        goal: "No write shape.",
        scope: ["src/lib"],
        acceptanceCriteria: ["check"],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("scriptedWrites");
  });

  test("allows empty scripted write content", () => {
    const task = must(
      parseDogfoodTask(
        JSON.stringify({
          goal: "Create an empty marker.",
          scope: ["docs"],
          acceptanceCriteria: ["marker exists"],
          scriptedWrites: [{ path: "docs/empty.md", content: "" }],
        }),
      ),
    );

    expect(task.scriptedWrites[0]?.content).toBe("");
  });

  test("tracked dogfood task example parses", () => {
    const raw = readFileSync(
      new URL("../../docs/dogfood-task.example.json", import.meta.url),
      "utf8",
    );
    const task = must(parseDogfoodTask(raw));

    expect(task.scope).toEqual(["docs"]);
    expect(task.scriptedWrites[0]?.path).toBe("docs/dogfood-warmup.md");
  });

  test("prompt includes scope, acceptance, and requested writes", () => {
    const prompt = dogfoodTaskPrompt({
      goal: "Warm up dogfood.",
      scope: ["docs"],
      acceptanceCriteria: ["check stays green"],
      scriptedWrites: [{ path: "docs/x.md", content: "# X\n" }],
    });

    expect(prompt).toContain("Warm up dogfood.");
    expect(prompt).toContain("- docs");
    expect(prompt).toContain("- check stays green");
    expect(prompt).toContain("path: docs/x.md");
    expect(prompt).toContain("# X");
  });
});
