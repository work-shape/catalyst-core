import {
  AppError,
  asUserId,
  auditActorFromUser,
  authenticatedUserFromRecord,
  createAuthorizer,
  type ActorAccess,
  type ApprovalRequest,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type MemberBundleChange,
  type MemberBundleState,
  type OperationAuthorization,
  type PermissionGrant,
  type UserRecord,
  type WorkspaceBundle
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import { AccessWorkflow, grantAuditMetadata } from "../access/access-service";
import { mayManageHolder, requireManageableHolder } from "../access/grant-holder-rules";
import { withRightsHeld } from "../access/rights-held";
import { bundleRows, type GrantRequestSubject } from "./member-bundle-rows";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "./workspace-access";
import {
  authorizationOf,
  refusalError,
  requireOwnerOrAdmin,
  roleRefusal
} from "./workspace-service-access";
import type { WorkspaceChangeCall } from "./workspace-service-types";

// AP-3: Builder and Publisher of a member, one by one, on Workspace > Members. An Owner or
// Admin of the workspace, or the member for themselves, asks for a bundle; the request is a
// `grant_request` in the Inbox, decided by an instance admin who holds the bundle there. Such
// an admin can also give it at once. The Owner or Admin and any instance admin take it back.
// A bundle is a grant row at workspace scope (WS-BUILD-1); nothing here widens what one gives.

/** The Approval Request kind of a request for a bundle. */
export const GRANT_REQUEST_KIND = "grant_request";

/** Who decides a request and gives a bundle at once: an instance admin, who holds it too. */
export const GRANT_DECIDING_RIGHT = "users.manage";

/** One bundle of one member as the caller reads it, and what their switch does. */
export interface MemberBundleView {
  state: MemberBundleState;
  change?: MemberBundleChange;
  requestId?: string;
}

type BundleOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "authorizer" | "approvalRequests" | "auditRecorder"
>;

/** A member's rights as their account is now, for what they hold. An inactive one holds nothing. */
export async function memberAccess(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores" | "authorizer">,
  member: UserRecord
): Promise<ActorAccess | undefined> {
  if (member.status !== "active") return undefined;
  const identity = authenticatedUserFromRecord({
    user: member,
    identity: { authSource: "workspace-bundles", externalUserId: member.id }
  });
  return (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(identity);
}

/** Whether the rights a member holds give the bundle in the workspace, from any source. */
export function holdsBundle(
  access: ActorAccess | undefined,
  workspaceId: string,
  bundle: WorkspaceBundle
): boolean {
  return access?.authorize(bundle, { workspaceId }).allowed ?? false;
}

/**
 * Whether the caller gives the bundle at once: they administer people, hold the bundle in the
 * workspace themselves, and the member is not they and no superadmin they may not change.
 */
function mayGrantBundle(
  caller: AuthenticatedUser,
  access: ActorAccess,
  member: UserRecord,
  workspaceId: string,
  bundle: WorkspaceBundle
): boolean {
  return (
    access.authorize(GRANT_DECIDING_RIGHT).allowed &&
    access.authorize(bundle, { workspaceId }).allowed &&
    member.id !== caller.id &&
    mayManageHolder(caller, member)
  );
}

/** The pending requests of a workspace, by member and bundle. */
async function pendingRequests(
  options: BundleOptions,
  workspaceId: string,
  userId?: string
): Promise<Map<string, ApprovalRequest>> {
  const store = options.approvalRequests?.store;
  if (!store) return new Map();
  const requests = await store.listApprovalRequests({
    clientInstanceId: options.clientInstanceId,
    kinds: [GRANT_REQUEST_KIND],
    status: "pending",
    subjectContains: { workspaceId, ...(userId === undefined ? {} : { userId }) }
  });
  const byKey = new Map<string, ApprovalRequest>();
  for (const request of requests) {
    const subject = request.payload.subject;
    if (typeof subject !== "object" || subject === null || Array.isArray(subject)) continue;
    const key = `${String(subject.userId)}:${String(subject.bundle)}`;
    // Newest first: the newest open request answers for the switch.
    if (!byKey.has(key)) byKey.set(key, request);
  }
  return byKey;
}

/** One bundle of one member, as an Owner or Admin of the workspace reads it. */
async function describeBundle(
  options: BundleOptions,
  caller: { user: AuthenticatedUser; access: ActorAccess },
  member: UserRecord,
  memberRights: ActorAccess | undefined,
  pending: Map<string, ApprovalRequest>,
  subject: GrantRequestSubject
): Promise<MemberBundleView> {
  if (holdsBundle(memberRights, subject.workspaceId, subject.bundle)) {
    const rows = await bundleRows(options.stores.access, options.clientInstanceId, subject);
    // A bundle held through a role, a group or the whole instance is changed where it is given.
    if (rows.length === 0) return { state: "inherited" };
    return mayManageHolder(caller.user, member)
      ? { state: "held", change: "revoke" }
      : { state: "held" };
  }
  const request = pending.get(`${subject.userId}:${subject.bundle}`);
  if (request) {
    // Only who asked withdraws a request; an instance admin decides it in the Inbox.
    return {
      state: "requested",
      requestId: request.id,
      ...(request.requestedBy.id === caller.user.id ? { change: "withdraw" as const } : {})
    };
  }
  if (member.status !== "active") return { state: "none" };
  return {
    state: "none",
    change: mayGrantBundle(caller.user, caller.access, member, subject.workspaceId, subject.bundle)
      ? "grant"
      : "request"
  };
}

/** Builder and Publisher of every member, for the workspace's Owner or Admin. */
export async function listMemberBundles(
  options: BundleOptions,
  caller: { user: AuthenticatedUser; access: ActorAccess },
  workspaceId: CollaborationWorkspaceId
) {
  requireOwnerOrAdmin(await requireWorkspaceAccess(options, caller.user, workspaceId));
  await requireSharedWorkspace(options, workspaceId);
  const [memberships, users, pending] = await Promise.all([
    options.stores.workspaces.listMemberships({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId: workspaceId
    }),
    options.stores.users.listUsers({ clientInstanceId: options.clientInstanceId }),
    pendingRequests(options, workspaceId)
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const items = await Promise.all(
    memberships.map(async (membership) => {
      const member = usersById.get(membership.userId);
      if (!member) throw new AppError("INTERNAL", "Workspace member is not available");
      const rights = await memberAccess(options, member);
      const of = (bundle: WorkspaceBundle) =>
        describeBundle(options, caller, member, rights, pending, {
          workspaceId,
          userId: member.id,
          bundle
        });
      const [builder, publisher] = await Promise.all([of("builder"), of("publisher")]);
      return { userId: member.id, builder, publisher };
    })
  );
  return { items };
}

/** The `authorize` of a request: an Owner or Admin, or the member for themselves. */
export async function authorizeBundleRequest(
  options: BundleOptions,
  operationId: string,
  user: AuthenticatedUser,
  workspaceId: CollaborationWorkspaceId,
  userId: string
): Promise<OperationAuthorization> {
  const access = await requireWorkspaceAccess(options, user, workspaceId);
  return authorizationOf(operationId, roleRefusal(access, userId === user.id ? "member" : "admin"));
}

/**
 * The `authorize` of a revocation: an Owner or Admin of the workspace, or an instance admin,
 * who reaches it without being a member.
 */
export async function authorizeBundleRevoke(
  options: BundleOptions,
  operationId: string,
  user: AuthenticatedUser,
  access: ActorAccess,
  workspaceId: CollaborationWorkspaceId
): Promise<OperationAuthorization> {
  if (access.authorize(GRANT_DECIDING_RIGHT).allowed) return { allowed: true };
  const workspaceAccess = await requireWorkspaceAccess(options, user, workspaceId);
  return authorizationOf(operationId, roleRefusal(workspaceAccess, "admin"));
}

/**
 * Files a request for a bundle, which changes nothing until an instance admin approves it. A
 * second call while one is open answers that one.
 */
export async function requestMemberBundle(
  options: BundleOptions,
  call: WorkspaceChangeCall,
  subject: GrantRequestSubject & { workspaceId: CollaborationWorkspaceId },
  reason: string | undefined
): Promise<MemberBundleView> {
  const member = await requireMember(options, subject);
  if (member.status !== "active")
    throw new AppError("CONFLICT", "The member's account is not active");
  if (holdsBundle(await memberAccess(options, member), subject.workspaceId, subject.bundle))
    throw new AppError("CONFLICT", "The member already holds this bundle here", {
      reason: "already_held"
    });
  const open = (await pendingRequests(options, subject.workspaceId, subject.userId)).get(
    `${subject.userId}:${subject.bundle}`
  );
  if (open)
    return {
      state: "requested",
      requestId: open.id,
      ...(open.requestedBy.id === call.user.id ? { change: "withdraw" as const } : {})
    };
  if (!options.approvalRequests)
    throw new AppError("CONFLICT", "This instance takes no requests for approval");
  const workflow = new ApprovalRequestWorkflow({
    ...options.approvalRequests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder
  });
  const request = await workflow.createRequest(
    call.user,
    { correlationId: call.correlationId },
    {
      kind: GRANT_REQUEST_KIND,
      // The name of the operation. The Inbox words the item in the reader's language.
      summary: "workspaces.member_bundles.request",
      payload: {
        subject: {
          workspaceId: subject.workspaceId,
          userId: subject.userId,
          bundle: subject.bundle
        },
        ...(reason ? { reason } : {})
      }
    }
  );
  return { state: "requested", requestId: request.id, change: "withdraw" };
}

/**
 * Gives a member the bundle at once, through the grants of Instance > Access: only an instance
 * admin who holds the bundle there writes the row (no escalation), and it is audited as such.
 */
export async function grantMemberBundle(
  options: ChatServerOptions,
  call: WorkspaceChangeCall,
  subject: GrantRequestSubject & { workspaceId: CollaborationWorkspaceId }
): Promise<MemberBundleView> {
  await requireMember(options, subject);
  const rows = await bundleRows(options.stores.access, options.clientInstanceId, subject);
  if (rows.length === 0) {
    await new AccessWorkflow(options).grant(
      call.user,
      { correlationId: call.correlationId, access: call.access },
      {
        holderKind: "user",
        holderId: subject.userId,
        action: subject.bundle,
        scopeKind: "workspace",
        scopeId: subject.workspaceId,
        effect: "allow"
      }
    );
  }
  return { state: "held", change: "revoke" };
}

/**
 * Takes the bundle back at once: the member's rows of it in this workspace. Under the rights
 * locks, with the caller's right asked anew, so a role changed meanwhile counts.
 */
export async function revokeMemberBundle(
  options: BundleOptions,
  call: WorkspaceChangeCall,
  subject: GrantRequestSubject & { workspaceId: CollaborationWorkspaceId }
): Promise<MemberBundleView> {
  const revoked = await withRightsHeld(
    options,
    { actor: call.user, access: call.access, userId: subject.userId },
    async ({ options: held, actor, access }) => {
      const allowed = await authorizeBundleRevoke(
        held,
        call.operationId,
        actor,
        access,
        subject.workspaceId
      );
      if (!allowed.allowed)
        throw refusalError(call.operationId, allowed.message ?? "The bundle cannot be taken back");
      const holder = await held.stores.users.getUser({
        clientInstanceId: held.clientInstanceId,
        userId: asUserId(subject.userId)
      });
      if (holder) requireManageableHolder(actor, holder);
      const rows = await bundleRows(held.stores.access, held.clientInstanceId, subject);
      if (rows.length === 0)
        throw new AppError("NOT_FOUND", "The member holds no row of this bundle here");
      const deleted: PermissionGrant[] = [];
      for (const row of rows) {
        const gone = await held.stores.access.deleteGrant({
          clientInstanceId: held.clientInstanceId,
          grantId: row.id
        });
        if (gone) deleted.push(gone);
      }
      return { deleted, holder };
    }
  );
  for (const grant of revoked.deleted) {
    await call.audit.record({
      type: "permission.revoked",
      status: "success",
      actor: auditActorFromUser(call.user),
      subject: grant.id,
      correlationId: call.correlationId,
      metadata: grantAuditMetadata(grant)
    });
  }
  const member = revoked.holder;
  const rights = member ? await memberAccess(options, member) : undefined;
  if (holdsBundle(rights, subject.workspaceId, subject.bundle)) return { state: "inherited" };
  return member && member.status === "active"
    ? {
        state: "none",
        change: mayGrantBundle(call.user, call.access, member, subject.workspaceId, subject.bundle)
          ? "grant"
          : "request"
      }
    : { state: "none" };
}

/** The member the call names, who must belong to the Shared Workspace. */
async function requireMember(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  subject: GrantRequestSubject & { workspaceId: CollaborationWorkspaceId }
): Promise<UserRecord> {
  await requireSharedWorkspace(options, subject.workspaceId);
  const userId = asUserId(subject.userId);
  const [membership, member] = await Promise.all([
    options.stores.workspaces.getMembership({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId: subject.workspaceId,
      userId
    }),
    options.stores.users.getUser({ clientInstanceId: options.clientInstanceId, userId })
  ]);
  if (!membership || !member) throw new AppError("NOT_FOUND", "Workspace member is not available");
  return member;
}

async function requireSharedWorkspace(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  workspaceId: CollaborationWorkspaceId
): Promise<void> {
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    workspaceId
  );
  if (workspace?.kind !== "shared")
    throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
}
