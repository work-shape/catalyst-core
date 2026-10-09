import {
  auditActorFromIdentity,
  type AuthenticatedIdentity,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/**
 * Records that a caller was let through to a governance action. The right itself is checked
 * before this runs: by the operation's `requires`, or by the workflow where it depends on the
 * loaded resource.
 */
export async function recordGovernanceAccess(input: {
  options: ChatServerOptions;
  user: AuthenticatedIdentity;
  context: Pick<RuntimeCallContext, "correlationId">;
  auditType: string;
}): Promise<void> {
  await input.options.auditRecorder.record({
    type: input.auditType,
    status: "success",
    actor: auditActorFromIdentity(input.user),
    correlationId: input.context.correlationId
  });
}
