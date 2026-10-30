import {
  AppError,
  WORKSPACE_BUNDLES,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromUser,
  createAuthorizer,
  type ApprovalRequestContext,
  type ApprovalRequestHandler,
  type ApprovalStaleness,
  type ApprovalTransactionStores,
  type AuthenticatedUser,
  type GrantRequestStaleReason,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { grantAuditMetadata } from "../access/access-service";
import { requireManageableHolder } from "../access/grant-holder-rules";
import { authorizeHeldRightsWithin } from "../access/held-rights-within";
import { requireAuthorized } from "../access/rights-held";
import type { ChatServerOptions } from "../types";
import { bundleRows } from "../workspaces/member-bundle-rows";
import {
  GRANT_DECIDING_RIGHT,
  GRANT_REQUEST_KIND,
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

/** The decision's transaction, with what giving a right reads and writes there. */
type GrantTransaction = ApprovalTransactionStores &
  Required<Pick<ApprovalTransactionStores, "access" | "audit" | "users" | "workspaces">>;

function grantTransaction(context: ApprovalRequestContext): GrantTransaction | undefined {
  const stores = context.transaction;
  return stores?.access && stores.audit && stores.users && stores.workspaces
    ? {
        ...stores,
        access: stores.access,
        audit: stores.audit,
        users: stores.users,
        workspaces: stores.workspaces
      }
    : undefined;
}

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
    // The decision first takes the rights locks, the instance's and then the member's, as every
    // write of rights does: what is read below stays true until the grant commits. A row of
    // the Inbox reads outside a decision and takes none.
    const tx = grantTransaction(context);
    if (context.transaction && !tx)
      throw new AppError("INTERNAL", "The decision's transaction does not reach the grants");
    if (tx) await tx.access.lockRights({ clientInstanceId, userId });
    const stores = tx ?? options.stores;
    const membership = await stores.workspaces.getMembership({
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
      userId: asUserId(userId)
    });
    if (!membership) return "member_left";
    const member = await stores.users.getUser({ clientInstanceId, userId: asUserId(userId) });
    if (member?.status !== "active") return "member_inactive";
    const rights = await memberAccess(
      tx
        ? { clientInstanceId, stores: options.stores, authorizer: createAuthorizer(tx.access) }
        : options,
      member
    );
    if (holdsBundle(rights, workspaceId, bundle)) return "already_held";
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
      const stores = grantTransaction(context);
      if (!stores)
        throw new AppError("INTERNAL", "The decision's transaction does not reach the grants");
      const { workspaceId, userId, bundle } = payload.subject;
      // Under the rights locks, as every grant write: the instance's, then the member's. The
      // stale check of this decision took them already; taking them again costs nothing.
      await stores.access.lockRights({ clientInstanceId, userId });
      const membership = await stores.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
        userId: asUserId(userId)
      });
      if (!membership) throw new AppError("CONFLICT", "The member left the workspace");
      const holder = await stores.users.getUser({ clientInstanceId, userId: asUserId(userId) });
      if (!holder) throw new AppError("NOT_FOUND", "Workspace member is not available");
      // The approver as they are now, with their rights read anew under the locks: the call
      // admitted them on rights that a change committed meanwhile may have taken away.
      const decider = await approverNow(stores, approver);
      const now = await createAuthorizer(stores.access).forActor(decider);
      for (const [action, resource] of [
        [GRANT_DECIDING_RIGHT, undefined],
        [bundle, { workspaceId }]
      ] as const) {
        const decision = now.authorize(action, resource);
        if (!decision.allowed)
          requireAuthorized({ allowed: false, action, reason: decision.reason });
      }
      requireManageableHolder(decider, holder);
      // The rule of no escalation, as the direct grant runs it: a deny of the approver inside
      // the workspace refuses giving the bundle over it.
      requireAuthorized(
        await authorizeHeldRightsWithin(
          { clientInstanceId, access: stores.access },
          now,
          [{ action: bundle, resource: { workspaceId } }],
          { gives: { label: holder.displayLabel } }
        )
      );
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

/** The approver as their record says now: the roles and references a change may have taken. */
async function approverNow(
  stores: GrantTransaction,
  approver: AuthenticatedUser
): Promise<AuthenticatedUser> {
  const record = await stores.users.getUser({
    clientInstanceId: approver.clientInstanceId,
    userId: asUserId(approver.id)
  });
  if (!record || record.status !== "active")
    throw new AppError("FORBIDDEN", "The approver's account is no longer active", {
      reason: "inactive"
    });
  return { ...approver, roles: record.roles, permissionRefs: record.permissionRefs };
}
