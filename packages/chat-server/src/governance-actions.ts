import { auditActorFromUser } from "@vivd-catalyst/core";
import { AppError, type AuthenticatedUser, type RuntimeCallContext } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

type GovernanceRoleRequirement = "admin" | "superadmin";

export async function authorizeGovernanceAction(input: {
  options: ChatServerOptions;
  user: AuthenticatedUser;
  context: RuntimeCallContext;
  requiredRole: GovernanceRoleRequirement;
  auditType: string;
  deniedMessage: string;
}): Promise<void> {
  assertGovernanceRole(input.user, input.requiredRole, input.deniedMessage);
  await input.options.auditRecorder.record({
    type: input.auditType,
    status: "success",
    actor: auditActorFromUser(input.user),
    correlationId: input.context.correlationId
  });
}

function assertGovernanceRole(
  user: AuthenticatedUser,
  requiredRole: GovernanceRoleRequirement,
  deniedMessage: string
): void {
  const authorized =
    requiredRole === "superadmin"
      ? user.roles.includes("superadmin")
      : user.roles.includes("admin") || user.roles.includes("superadmin");

  if (!authorized) {
    throw new AppError("FORBIDDEN", deniedMessage);
  }
}
