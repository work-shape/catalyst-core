import {
  AppError,
  auditActorFromUser,
  hasPermission,
  type AuthenticatedUser,
  type Permission,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

export async function authorizeGovernanceAction(input: {
  options: ChatServerOptions;
  user: AuthenticatedUser;
  context: RuntimeCallContext;
  requiredPermission: Permission;
  auditType: string;
  deniedMessage: string;
}): Promise<void> {
  assertGovernancePermission(input.user, input.requiredPermission, input.deniedMessage);
  await input.options.auditRecorder.record({
    type: input.auditType,
    status: "success",
    actor: auditActorFromUser(input.user),
    correlationId: input.context.correlationId
  });
}

function assertGovernancePermission(
  user: AuthenticatedUser,
  requiredPermission: Permission,
  deniedMessage: string
): void {
  if (!hasPermission(user, requiredPermission)) {
    throw new AppError("FORBIDDEN", deniedMessage);
  }
}
