import type { PrClient, PrPayload } from "./pr-adapter";
import { spawnCommand } from "./spawn";

/**
 * Live GitHub PR client (D11, W1). Maps provenance-derived payloads to `gh pr create`
 * through an injected exec boundary — offline tests use a mock exec; live mode uses gh.
 */

export interface GhExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GhExec = (args: readonly string[]) => Promise<GhExecResult>;

const parsePrUrl = (stdout: string): string => {
  const line = stdout
    .trim()
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("http"));
  if (line === undefined || line.length === 0) {
    throw new Error(`gh did not return a PR URL: ${stdout.slice(0, 200)}`);
  }
  return line;
};

export const createGhPrClient = (exec: GhExec): PrClient => ({
  open: async (payload: PrPayload) => {
    const result = await exec([
      "pr",
      "create",
      "--head",
      payload.branch,
      "--title",
      payload.title,
      "--body",
      payload.body,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `gh exited ${result.exitCode}`);
    }
    return { url: parsePrUrl(result.stdout) };
  },
});

/** ponytail: default exec shells out to gh in cwd; env-gated live tests only. */
export const defaultGhExec =
  (cwd: string): GhExec =>
  async (args) => {
    const result = await spawnCommand(["gh", ...args], { cwd });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
