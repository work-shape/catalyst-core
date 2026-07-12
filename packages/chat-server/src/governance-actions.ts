import {
  AppError,
  auditActorFromIdentity,
  hasPermission,
  type AuthenticatedIdentity,
  type Permission,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

export async function authorizeGovernanceAction(input: {
  options: ChatServerOptions;
  user: AuthenticatedIdentity;
  context: Pick<RuntimeCallContext, "correlationId">;
  requiredPermission: Permission;
  auditType: string;
  deniedMessage: string;
}): Promise<void> {
  assertGovernancePermission(input.user, input.requiredPermission, input.deniedMessage);
  await input.options.auditRecorder.record({
    type: input.auditType,
    status: "success",
    actor: auditActorFromIdentity(input.user),
    correlationId: input.context.correlationId
  });
}

function assertGovernancePermission(
  user: AuthenticatedIdentity,
  requiredPermission: Permission,
  deniedMessage: string
): void {
  if (!hasPermission(user, requiredPermission)) {
    throw new AppError("FORBIDDEN", deniedMessage);
  }
}
