import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WriteScope } from "../domain/scope";
import { createPathProtectionExtension as createGuardExtension } from "../lib/scope-guard";

/**
 * S2 — Pi extension that enforces spine-supplied write scope (D6, D14).
 *
 * Installed as a Pi extension for interactive dev sessions; the orchestrator
 * supplies `allowedPaths` per invocation. The same guard logic lives in
 * `lib/scope-guard.ts` and is also wired through pi-agent-core's
 * `beforeToolCall` under the orchestrator.
 */
export const createPathProtectionExtension = (scope: WriteScope): ((pi: ExtensionAPI) => void) =>
  createGuardExtension(scope);

export default createPathProtectionExtension;
