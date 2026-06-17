import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./cli.ts";

describe("cli entry — parseCliArgs", () => {
  test("rejects unknown flags", () => {
    expect(parseCliArgs(["run", "--nope"])).toBeUndefined();
  });
});
