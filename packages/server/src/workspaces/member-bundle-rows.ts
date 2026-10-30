import {
  WORKSPACE_BUNDLES,
  auditActorFromUser,
  type ClientInstanceId,
  type PermissionGrant,
  type PlatformStores,
  type WorkspaceBundle
} from "@work-shape/catalyst-core";
import { grantAuditMetadata } from "../access/access-service";
import type { WorkspaceChangeCall } from "./workspace-service-types";

/** Builder or Publisher of one member in one Shared Workspace (AP-3). */
export interface GrantRequestSubject {
  workspaceId: string;
  userId: string;
  bundle: WorkspaceBundle;
}

/** The member's own rows of the bundle in this workspace: what the Members screen takes back. */
export async function bundleRows(
  stores: Pick<PlatformStores["access"], "listGrants">,
  clientInstanceId: ClientInstanceId,
  subject: GrantRequestSubject
): Promise<PermissionGrant[]> {
  const rows = await stores.listGrants({
    clientInstanceId,
    holderKind: "user",
    holderId: subject.userId,
    action: subject.bundle,
    scopeKind: "workspace",
    scopeId: subject.workspaceId
  });
  return rows.filter((row) => row.effect === "allow");
}

/**
 * Deletes the member's rows of Builder and Publisher in the workspace, through the stores of
 * the transaction that ends the membership: a member who left or was removed keeps neither, where
 * the Members screen could no longer show or take it back. Returns the rows it deleted.
 */
export async function endMemberBundles(
  stores: Pick<PlatformStores["access"], "listGrants" | "deleteGrant">,
  clientInstanceId: ClientInstanceId,
  member: { workspaceId: string; userId: string }
): Promise<PermissionGrant[]> {
  const deleted: PermissionGrant[] = [];
  for (const bundle of WORKSPACE_BUNDLES) {
    for (const row of await bundleRows(stores, clientInstanceId, { ...member, bundle })) {
      const gone = await stores.deleteGrant({ clientInstanceId, grantId: row.id });
      if (gone) deleted.push(gone);
    }
  }
  return deleted;
}

/** Audits the rows a membership's end took with it, as any revoke: minimized, one per row. */
export async function recordBundlesEnded(
  call: Pick<WorkspaceChangeCall, "audit" | "user" | "correlationId">,
  grants: readonly PermissionGrant[]
): Promise<void> {
  for (const grant of grants) {
    await call.audit.record({
      type: "permission.revoked",
      status: "success",
      actor: auditActorFromUser(call.user),
      subject: grant.id,
      correlationId: call.correlationId,
      metadata: { ...grantAuditMetadata(grant), reason: "membership_ended" }
    });
  }
}
