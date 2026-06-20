import { describe, expect, test } from "bun:test";
import { resolveInvocationTimeoutMs } from "./invoke-stub-agent";

describe("Pi invocation timeout", () => {
  test("defaults on for live calls and off for faux calls", () => {
    expect(resolveInvocationTimeoutMs("faux", {})).toBeUndefined();
    expect(resolveInvocationTimeoutMs("live", {})).toBe(90_000);
  });

  test("env override can set or disable the timeout", () => {
    expect(resolveInvocationTimeoutMs("live", { SNAFFLE_AGENT_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(resolveInvocationTimeoutMs("live", { SNAFFLE_AGENT_TIMEOUT_MS: "0" })).toBeUndefined();
  });
});
