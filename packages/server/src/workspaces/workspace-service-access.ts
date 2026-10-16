import { AppError, type OperationAuthorization } from "@work-shape/catalyst-core";
import { type WorkspaceAccess } from "./workspace-access";
import { type WorkspaceRoleNeeded } from "./workspace-service-types";

export const CANNOT_ADD_MEMBER_MESSAGE =
  "This user cannot be added. Invitations for people without an eligible account are not available yet.";

/**
 * The one place a role is held against what an operation asks: the sentence a caller whose
 * role is too low reads, or nothing where the role is enough.
 */
export function roleRefusal(
  access: WorkspaceAccess,
  needed: WorkspaceRoleNeeded
): string | undefined {
  if (needed === "owner" && access.role !== "owner") return "Workspace Owner access is required";
  if (needed === "admin" && access.role !== "owner" && access.role !== "admin") {
    return "Workspace Owner or Admin access is required";
  }
  return undefined;
}

/** A read asks the role and refuses with the same sentence as a change. */
export function requireOwnerOrAdmin(access: WorkspaceAccess): void {
  const refusal = roleRefusal(access, "admin");
  if (refusal !== undefined) throw new AppError("FORBIDDEN", refusal);
}

export function requireOwner(access: WorkspaceAccess): void {
  const refusal = roleRefusal(access, "owner");
  if (refusal !== undefined) throw new AppError("FORBIDDEN", refusal);
}

/** What the `authorize` of an operation answers: a refusal names the operation and says the rule. */
export function authorizationOf(
  operationId: string,
  refusal: string | undefined
): OperationAuthorization {
  return refusal === undefined
    ? { allowed: true }
    : { allowed: false, action: operationId, reason: "no_grant", message: refusal };
}

/** The same refusal thrown inside the operation. With these details the run ends as denied. */
export function refusalError(operationId: string, message: string): AppError {
  return new AppError("FORBIDDEN", message, { action: operationId, reason: "no_grant" });
}

export function requireNoRefusal(operationId: string, refusal: string | undefined): void {
  if (refusal !== undefined) throw refusalError(operationId, refusal);
}
