import { describe, expect, test } from "bun:test";
import { ok } from "../domain/shared";
import { type PrPayload, publishPr, renderPrPayload } from "./pr-adapter";

const source = {
  lineageId: "L1",
  summary: "Add the minimal in-scope change",
  regime: "minimal" as const,
  planHash: "p".repeat(64),
  contextHash: "c".repeat(64),
  generationId: "gen-1",
};

describe("W7 — PR adapter + commit scaffolder (D11)", () => {
  test("a dry-run client receives a provenance-derived commit+PR payload", async () => {
    const calls: PrPayload[] = [];
    const result = await publishPr(source, {
      open: async (payload) => {
        calls.push(payload);
        return { url: `dry-run://pr/${payload.branch}` };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("opened");
    expect(calls[0]?.body).toContain(source.planHash);
  });

  test("a remote failure degrades to the local queue and never fakes a merge", async () => {
    const result = await publishPr(source, {
      open: async () => {
        throw new Error("network unreachable");
      },
    });
    expect(result).toEqual(ok({ kind: "degraded_to_queue", detail: "network unreachable" }));
  });

  test("rendering is a pure function of the provenance source", () => {
    expect(renderPrPayload(source)).toEqual(renderPrPayload(source));
  });
});
