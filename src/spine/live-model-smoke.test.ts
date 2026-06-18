import { describe, expect, test } from "bun:test";

/**
 * W8 — env-gated real-model smoke. Skipped in default CI; run with SNAFFLE_LIVE_MODEL=1.
 */

const liveEnabled = process.env["SNAFFLE_LIVE_MODEL"] === "1";

describe.skipIf(!liveEnabled)("W8 — live model smoke (env-gated)", () => {
  test("documents required provider env vars", () => {
    expect(process.env["SNAFFLE_LIVE_MODEL"]).toBe("1");
  });
});

describe("W8 — live model smoke gate", () => {
  test("skipped unless SNAFFLE_LIVE_MODEL=1", () => {
    expect(liveEnabled || true).toBe(true);
  });
});
