import { spawn } from "node:child_process";

/**
 * Cross-runtime subprocess helper (D17).
 *
 * Shipped code uses node:child_process so the gate runner and worktree logic
 * work under Node CI, not only Bun dev.
 */

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const spawnCommand = (
  command: readonly string[],
  options: { readonly cwd: string; readonly env?: Record<string, string | undefined> },
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const [exe, ...args] = command;
    if (exe === undefined || exe.length === 0) {
      reject(new Error("empty command"));
      return;
    }

    const proc = spawn(exe, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
