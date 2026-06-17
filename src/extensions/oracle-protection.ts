import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WriteScope } from "../domain/scope";
import type { OracleFreezeRecord } from "../lib/oracle-freeze";
import { createPathProtectionExtension as createGuardExtension } from "../lib/scope-guard";

/**
 * Pi extension enforcing scope + frozen oracle paths (D6, D7, W7).
 */
export const createOracleProtectionExtension = (
  scope: WriteScope,
  oracleFreeze: OracleFreezeRecord,
  workspaceRoot?: string,
): ((pi: ExtensionAPI) => void) => createGuardExtension(scope, workspaceRoot, oracleFreeze);

export default createOracleProtectionExtension;
