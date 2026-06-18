import { describe, expect, test } from "bun:test";
import { createGhPrClient, type GhExec } from "./gh-pr-adapter";
import { publishPr, renderPrPayload } from "./pr-adapter";

const source = {
  lineageId: "L-gh",
  summary: "Live gh adapter test",
  regime: "minimal" as const,
  planHash: "p".repeat(64),
  contextHash: "c".repeat(64),
  generationId: "gen-gh",
};

describe("W1 — gh PR adapter (D11)", () => {
  test("maps provenance payload to gh pr create args and parses URL", async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: "https://github.com/org/repo/pull/42\n", stderr: "" };
    };

    const result = await publishPr(source, createGhPrClient(exec));
    expect(result.ok && result.value.kind === "opened").toBe(true);
    if (!result.ok || result.value.kind !== "opened") return;
    expect(result.value.url).toBe("https://github.com/org/repo/pull/42");

    expect(calls).toHaveLength(1);
    const args = calls[0] as string[];
    expect(args).toContain("pr");
    expect(args).toContain("create");
    expect(args).toContain(renderPrPayload(source).branch);
  });

  test("gh failure propagates as degrade through publishPr", async () => {
    const exec: GhExec = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: not authenticated",
    });
    const result = await publishPr(source, createGhPrClient(exec));
    expect(result.ok && result.value.kind === "degraded_to_queue").toBe(true);
  });
});
