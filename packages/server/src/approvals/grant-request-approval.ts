import {
  AppError,
  WORKSPACE_BUNDLES,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromUser,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type ApprovalStaleness,
  type GrantRequestStaleReason,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { grantAuditMetadata } from "../access/access-service";
import { requireManageableHolder } from "../access/grant-holder-rules";
import type { ChatServerOptions } from "../types";
import {
  GRANT_DECIDING_RIGHT,
  GRANT_REQUEST_KIND,
  bundleRows,
  holdsBundle,
  memberAccess
} from "../workspaces/workspace-bundles";

const payloadSchema = z.object({
  subject: z.object({
    workspaceId: z.string().min(1),
    userId: z.string().min(1),
    bundle: z.enum(WORKSPACE_BUNDLES)
  }),
  reason: z.string().max(500).optional()
});

type GrantRequestPayload = z.infer<typeof payloadSchema> & JsonObject;

/** Why a request can no longer give what it asked: the Inbox words each in its own language. */
type StaleReason = GrantRequestStaleReason;

type GrantRequestOptions = Pick<ChatServerOptions, "clientInstanceId" | "stores" | "authorizer">;

/**
 * `grant_request` (AP-3): Builder or Publisher for one member of one Shared Workspace. Who
 * decides it administers people (`users.manage`) and holds the bundle in that workspace, so
 * nobody gives what they do not hold. Approving writes the grant row in the decision's
 * transaction; declining needs no reason. Nothing changes until it is approved, and an approved
 * bundle is taken back on the Members screen, not by a revert.
 */
export function createGrantRequestHandler(
  options: GrantRequestOptions
): ApprovalRequestHandler<GrantRequestPayload> {
  const { clientInstanceId } = options;

  async function staleness(
    payload: GrantRequestPayload,
    context: ApprovalRequestContext
  ): Promise<StaleReason | undefined> {
    const { workspaceId, userId, bundle } = payload.subject;
    const workspaces = context.transaction?.workspaces ?? options.stores.workspaces;
    const membership = await workspaces.getMembership({
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
      userId: asUserId(userId)
    });
    if (!membership) return "member_left";
    const member = await options.stores.users.getUser({
      clientInstanceId,
      userId: asUserId(userId)
    });
    if (member?.status !== "active") return "member_inactive";
    if (holdsBundle(await memberAccess(options, member), workspaceId, bundle))
      return "already_held";
    return undefined;
  }

  return {
    kind: GRANT_REQUEST_KIND,
    requiredPermission: GRANT_DECIDING_RIGHT,
    // Only who holds the bundle in the workspace gives it.
    furtherPermissions: (payload) => [
      {
        permission: payload.subject.bundle,
        resource: { workspaceId: payload.subject.workspaceId }
      }
    ],
    validate: (payload) => payloadSchema.parse(payload),
    async preview(payload, context): Promise<JsonObject> {
      const { workspaceId, userId, bundle } = payload.subject;
      const [workspace, member] = await Promise.all([
        options.stores.workspaces.getWorkspace(
          clientInstanceId,
          asCollaborationWorkspaceId(workspaceId)
        ),
        options.stores.users.getUser({ clientInstanceId, userId: asUserId(userId) })
      ]);
      // A row shows who and where; the open item also says whether it can still be approved.
      const stale =
        context.status === "pending" && context.viewer?.inList === false
          ? await staleness(payload, context)
          : undefined;
      return {
        workspace: { id: workspaceId, name: workspace?.name ?? "" },
        member: { id: userId, label: member?.displayLabel ?? "" },
        bundle,
        ...(payload.reason ? { reason: payload.reason } : {}),
        ...(stale ? { stale } : {})
      };
    },
    async isStale(payload, context): Promise<boolean | ApprovalStaleness> {
      const reason = await staleness(payload, context);
      return reason ? { result: { reason } } : false;
    },
    async apply(payload, approver, context): Promise<JsonObject> {
      const stores = context.transaction;
      if (!stores?.access || !stores.audit)
        throw new AppError("INTERNAL", "The decision's transaction does not reach the grants");
      const { workspaceId, userId, bundle } = payload.subject;
      // Under the rights locks, as every grant write: the instance's, then the member's.
      await stores.access.lockRights({ clientInstanceId, userId });
      const holder = await options.stores.users.getUser({
        clientInstanceId,
        userId: asUserId(userId)
      });
      if (!holder) throw new AppError("NOT_FOUND", "Workspace member is not available");
      requireManageableHolder(approver, holder);
      const subject = { workspaceId, userId, bundle };
      const [existing] = await bundleRows(stores.access, clientInstanceId, subject);
      if (existing) return { status: "granted", grantId: existing.id };
      const grant = await stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: userId,
        action: bundle,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId,
        grantedBy: asUserId(approver.id)
      });
      await stores.audit.appendAuditEvent({
        clientInstanceId,
        type: "permission.granted",
        status: "success",
        actor: auditActorFromUser(approver),
        subject: grant.id,
        correlationId: context.correlationId,
        metadata: { ...grantAuditMetadata(grant), requestId: context.requestId }
      });
      return { status: "granted", grantId: grant.id };
    }
  };
}
