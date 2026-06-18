import { describe, expect, test } from "bun:test";
import { createGhPrClient, type GhExec } from "../lib/gh-pr-adapter";
import { publishPr } from "../lib/pr-adapter";

/**
 * P7/S1 — live gh PR adapter contract (offline mock exec).
 */

describe("P7/S1 — gh PR adapter contract", () => {
  test("mock exec receives gh pr create and returns URL", async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: "https://github.com/o/r/pull/1\n", stderr: "" };
    };
    const result = await publishPr(
      {
        lineageId: "L-s1",
        summary: "s1",
        regime: "minimal",
        planHash: "p".repeat(64),
        contextHash: "c".repeat(64),
        generationId: "g1",
      },
      createGhPrClient(exec),
    );
    expect(result.ok && result.value.kind === "opened").toBe(true);
    expect(calls[0]?.[0]).toBe("pr");
  });
});
