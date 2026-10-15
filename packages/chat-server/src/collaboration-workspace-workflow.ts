import {
  type ISODateString,
  AppError,
  isSuperadmin,
  WORKSPACE_ACCENT_COLORS,
  asUserId,
  auditActorFromUser,
  getSubjectUserId,
  type AuditRecorder,
  type ActorAccess,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceWithRole,
  type ConversationVisibility,
  type OperationAuthorization,
  type PlatformStores,
  type RuntimeAssetSnapshot,
  type UserRecord,
  type WorkspaceAccentColor,
  type WorkspaceMemberCandidate,
  type WorkspaceMembership,
  type WorkspaceMembershipRole,
  type WorkspaceVisibility
} from "@vivd-catalyst/core";
import { getWorkspaceAssetSnapshot } from "./agent-availability";
import { withRightsHeld } from "./rights-held";
import type { ChatServerOptions } from "./types";
import {
  effectiveWorkspaceRole,
  requireWorkspaceAccess,
  type WorkspaceAccess
} from "./workspace-access";
import { assertConversationIdle } from "./conversation-idle";
import type { DeletionOutcome } from "./subject-deletion";
import { requestWorkspaceDeletion, type WorkspaceDeletionResult } from "./workspace-deletion";

const MAX_WORKSPACE_NAME_LENGTH = 120;
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500;
const MAX_WORKSPACE_EMOJI_LENGTH = 32;
const CANNOT_ADD_MEMBER_MESSAGE =
  "This user cannot be added. Invitations for people without an eligible account are not available yet.";
const LAST_OWNER_MESSAGE = "A Shared Workspace must retain at least one active owner";

/** The least role a workspace operation asks of its caller. `member` is any role. */
export type WorkspaceRoleNeeded = "member" | "admin" | "owner";

/** What a changing workspace operation takes from its Operation Run. */
export interface WorkspaceChangeCall {
  /** The operation, which a refusal names: no right a caller can be granted opens it. */
  operationId: string;
  user: AuthenticatedUser;
  /** The caller's rights as the call was admitted; a change of members reads them anew. */
  access: ActorAccess;
  /** Writes audit rows that name the run. */
  audit: AuditRecorder;
  correlationId: string;
}

export interface WorkspaceListItem extends CollaborationWorkspaceWithRole {
  membershipRole: WorkspaceMembershipRole | null;
  pendingAccessRequestCount: number;
}

export interface WorkspaceDirectoryItem {
  id: CollaborationWorkspaceId;
  name: string;
  description: string | null;
  emoji: string | null;
  accentColor: WorkspaceAccentColor | null;
  accessState: "member" | "request_pending" | "can_request";
  createdAt: ISODateString;
}

export interface WorkspaceMemberItem {
  userId: UserRecord["id"];
  displayLabel: string;
  email: string | null;
  role: WorkspaceMembershipRole;
}

export interface WorkspaceAccessRequestItem {
  userId: UserRecord["id"];
  displayLabel: string;
  email: string | null;
  createdAt: string;
}

export interface WorkspaceDeletionImpact {
  conversationCount: number;
  memberCount: number;
  pendingAccessRequestCount: number;
}

export interface CreateSharedWorkspaceCommand {
  name: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}

export interface UpdateWorkspaceSettingsCommand {
  name?: string;
  description?: string | null;
  visibility?: WorkspaceVisibility;
  defaultConversationVisibility?: ConversationVisibility;
  emoji?: string | null;
  accentColor?: WorkspaceAccentColor | null;
}

export class CollaborationWorkspaceWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  /** The single access check for a Collaboration Workspace: `requireWorkspaceAccess`. */
  requireWorkspaceAccess(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceAccess> {
    return requireWorkspaceAccess(this.options, user, collaborationWorkspaceId);
  }

  /**
   * Who may call a registered workspace operation. It is the operation's `authorize`, so the
   * run records the check and a refusal, and a caller whose role is too low reaches neither the
   * policy nor an approval. The role comes from `requireWorkspaceAccess`, which the operation
   * asks again where it writes. A workspace the caller cannot reach is not available to them,
   * as for a read: that throws, and the call fails before anything of it ran.
   */
  async authorizeChange(
    operationId: string,
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    needed: WorkspaceRoleNeeded
  ): Promise<OperationAuthorization> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    return authorizationOf(operationId, roleRefusal(access, needed));
  }

  /** The `authorize` of `workspaces.delete`: an Owner, also of a workspace already in deletion. */
  async authorizeDeletion(
    operationId: string,
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<OperationAuthorization> {
    const { refusal } = await this.deletionAccess(user, collaborationWorkspaceId);
    return authorizationOf(operationId, refusal);
  }

  /**
   * The `authorize` of `workspaces.access_requests.create`. Whoever is signed in may ask to
   * join a Shared Workspace that can be found; no other workspace is available to them.
   */
  async authorizeAccessRequest(
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<OperationAuthorization> {
    await this.requireDiscoverableWorkspace(collaborationWorkspaceId);
    return { allowed: true };
  }

  /** The runtime assets a member sees in this workspace. */
  async getAssetSnapshot(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<RuntimeAssetSnapshot> {
    await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    return getWorkspaceAssetSnapshot(
      this.options,
      await this.requireWorkspace(collaborationWorkspaceId)
    );
  }

  async listWorkspaces(user: AuthenticatedUser): Promise<WorkspaceListItem[]> {
    const userId = asUserId(getSubjectUserId(user));
    const memberWorkspaces = await this.options.stores.workspaces.listWorkspacesForUser({
      clientInstanceId: this.options.clientInstanceId,
      userId
    });
    const memberWorkspaceIds = new Set(memberWorkspaces.map((workspace) => workspace.id));
    const otherSharedWorkspaces = isSuperadmin(user)
      ? (
          await this.options.stores.workspaces.listSharedWorkspaces({
            clientInstanceId: this.options.clientInstanceId
          })
        ).filter((workspace) => !memberWorkspaceIds.has(workspace.id))
      : [];
    return Promise.all([
      ...memberWorkspaces.map((workspace) =>
        this.toListItem(workspace, {
          userId,
          role: effectiveWorkspaceRole(user, workspace, workspace.role),
          membershipRole: workspace.role
        })
      ),
      ...otherSharedWorkspaces.map((workspace) =>
        this.toListItem(workspace, { userId, role: "owner", membershipRole: null })
      )
    ]);
  }

  async createSharedWorkspace(
    call: WorkspaceChangeCall,
    command: CreateSharedWorkspaceCommand
  ): Promise<WorkspaceListItem> {
    const { user } = call;
    const workspace = await this.options.stores.workspaces.createWorkspace({
      clientInstanceId: this.options.clientInstanceId,
      kind: "shared",
      name: normalizeRequiredName(command.name),
      description: normalizeDescription(command.description),
      visibility: command.visibility ?? "discoverable",
      defaultConversationVisibility: command.defaultConversationVisibility ?? "workspace",
      emoji: normalizeEmoji(command.emoji),
      accentColor: validateAccentColor(command.accentColor),
      creatorUserId: asUserId(getSubjectUserId(user))
    });
    await this.record(call, workspace.id, "collaboration_workspace.created");
    return { ...workspace, role: "owner", membershipRole: "owner", pendingAccessRequestCount: 0 };
  }

  async getWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceListItem> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    return this.toListItem(await this.requireWorkspace(collaborationWorkspaceId), access);
  }

  async getDeletionImpact(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceDeletionImpact> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwner(access);
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const [conversations, memberships, accessRequests] = await Promise.all([
      this.options.stores.conversations.listConversationsForWorkspace({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        scope: { kind: "lifecycle" }
      }),
      this.options.stores.workspaces.listMemberships({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      }),
      this.options.stores.workspaces.listAccessRequestsForWorkspace({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      })
    ]);
    return {
      conversationCount: conversations.length,
      memberCount: memberships.length,
      pendingAccessRequestCount: accessRequests.length
    };
  }

  /**
   * Accepts the deletion of a Shared Workspace by one of its Owners. `deferred` means the
   * workspace is closed and its job removes what is left. A request that is repeated for a
   * workspace in deletion is answered `deferred` to the same people.
   */
  async deleteSharedWorkspace(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    confirmName: string
  ): Promise<DeletionOutcome<WorkspaceDeletionResult>> {
    const { user } = call;
    const scope = { clientInstanceId: this.options.clientInstanceId, collaborationWorkspaceId };
    const { inDeletion, refusal } = await this.deletionAccess(user, collaborationWorkspaceId);
    requireNoRefusal(call.operationId, refusal);
    const workspace =
      inDeletion?.workspace ?? (await this.requireSharedWorkspace(collaborationWorkspaceId));
    if (confirmName !== workspace.name) {
      throw new AppError("VALIDATION_FAILED", "Workspace name confirmation does not match");
    }
    if (!inDeletion) {
      // Refused before anything is marked: nothing is deleted under work that still writes.
      const conversations = await this.options.stores.conversations.listConversationsForWorkspace({
        ...scope,
        scope: { kind: "lifecycle" }
      });
      for (const conversation of conversations) {
        await assertConversationIdle(this.options, conversation.id);
      }
    }
    return requestWorkspaceDeletion(this.options, {
      collaborationWorkspaceId,
      actor: auditActorFromUser(user),
      actorUserId: asUserId(getSubjectUserId(user)),
      correlationId: call.correlationId
    });
  }

  /**
   * Whether the user may delete the workspace, with the workspace in deletion where its
   * deletion was requested before. Such a workspace has no memberships to ask any more, so its
   * Owners are read from what the deletion kept, and nobody else finds it.
   */
  private async deletionAccess(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ) {
    const inDeletion = await this.options.stores.workspaces.getWorkspaceInDeletion({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId
    });
    if (!inDeletion) {
      const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
      return { inDeletion, refusal: roleRefusal(access, "owner") };
    }
    const userId = getSubjectUserId(user);
    const ownsIt = inDeletion.memberships.some(
      (membership) => membership.userId === userId && membership.role === "owner"
    );
    if (!ownsIt && !isSuperadmin(user)) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return { inDeletion, refusal: undefined };
  }

  async updateSettings(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    command: UpdateWorkspaceSettingsCommand
  ): Promise<WorkspaceListItem> {
    const { user } = call;
    const access = await this.requireRole(call, collaborationWorkspaceId, "admin");
    const workspace = await this.requireWorkspace(collaborationWorkspaceId);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "Personal Workspace settings cannot be changed");
    }

    const update = {
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      ...(command.name !== undefined ? { name: normalizeRequiredName(command.name) } : {}),
      ...(command.description !== undefined
        ? { description: normalizeDescription(command.description) }
        : {}),
      ...(command.visibility !== undefined ? { visibility: command.visibility } : {}),
      ...(command.defaultConversationVisibility !== undefined
        ? { defaultConversationVisibility: command.defaultConversationVisibility }
        : {}),
      ...(command.emoji !== undefined ? { emoji: normalizeEmoji(command.emoji) } : {}),
      ...(command.accentColor !== undefined
        ? { accentColor: validateAccentColor(command.accentColor) }
        : {})
    };
    const changedFields = workspaceChangedFields(workspace, update);
    if (changedFields.length === 0) {
      return this.getWorkspace(user, collaborationWorkspaceId);
    }
    const updated = await this.options.stores.workspaces.updateWorkspace(update);
    await this.record(call, collaborationWorkspaceId, "collaboration_workspace.updated", {
      changedFields
    });
    return this.toListItem(updated, access);
  }

  async listMembers(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceMemberItem[]> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
    const [memberships, users] = await Promise.all([
      this.options.stores.workspaces.listMemberships({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      }),
      this.options.stores.users.listUsers({ clientInstanceId: this.options.clientInstanceId })
    ]);
    const usersById = new Map(users.map((candidate) => [candidate.id, candidate]));
    return memberships.map((membership) => {
      const member = usersById.get(membership.userId);
      if (!member) throw new AppError("INTERNAL", "Workspace member is not available");
      return {
        userId: member.id,
        displayLabel: member.displayLabel,
        email: member.email ?? null,
        role: membership.role
      };
    });
  }

  async searchMemberCandidates(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    query: string
  ): Promise<WorkspaceMemberCandidate[]> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return [];
    return this.options.stores.workspaces.searchMemberCandidates({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      query: normalizedQuery,
      limit: 8
    });
  }

  async addMemberByEmail(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    email: string
  ) {
    return this.whileRightsHeld(call, undefined, (held, now) =>
      held.addMemberByEmailNow(now, collaborationWorkspaceId, email)
    );
  }

  private async addMemberByEmailNow(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    email: string
  ): Promise<WorkspaceMemberItem> {
    await this.requireRole(call, collaborationWorkspaceId, "admin");
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
    if (!normalizedEmail) throw new AppError("VALIDATION_FAILED", CANNOT_ADD_MEMBER_MESSAGE);

    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const matches = users.filter(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.email?.toLocaleLowerCase("en-US") === normalizedEmail ||
          candidate.identities.some(
            (identity) =>
              identity.emailVerified &&
              identity.email?.toLocaleLowerCase("en-US") === normalizedEmail
          ))
    );
    const [target] = matches;
    if (matches.length !== 1 || !target) {
      throw new AppError("VALIDATION_FAILED", CANNOT_ADD_MEMBER_MESSAGE);
    }
    const existing = await this.options.stores.workspaces.getMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: target.id
    });
    if (existing) throw new AppError("CONFLICT", "User is already a workspace member");
    // The rights locks of the user found, after the instance's that `whileRightsHeld` took.
    await this.options.stores.access.lockRights({
      clientInstanceId: this.options.clientInstanceId,
      userId: target.id
    });
    const pendingAccessRequest = await this.options.stores.workspaces.getAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: target.id
    });

    await this.options.stores.workspaces.addMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: target.id,
      role: "member"
    });
    if (pendingAccessRequest) {
      await this.options.stores.workspaces.deleteAccessRequest({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        userId: target.id
      });
    }
    await this.record(call, collaborationWorkspaceId, "collaboration_workspace.member_added", {
      targetUserId: target.id
    });
    return {
      userId: target.id,
      displayLabel: target.displayLabel,
      email: target.email ?? null,
      role: "member"
    };
  }

  async changeMemberRole(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"],
    role: WorkspaceMembershipRole
  ) {
    return this.whileRightsHeld(call, targetUserId, (held, now) =>
      held.changeMemberRoleNow(now, collaborationWorkspaceId, targetUserId, role)
    );
  }

  private async changeMemberRoleNow(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"],
    role: WorkspaceMembershipRole
  ): Promise<WorkspaceMembership> {
    const actor = await this.requireRole(call, collaborationWorkspaceId, "admin");
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const target = await this.requireMembership(collaborationWorkspaceId, targetUserId);
    if (actor.role === "admin" && (target.role !== "member" || role !== "member")) {
      throw refusalError(call.operationId, "Workspace Admins may manage regular Members only");
    }
    if (target.role === role) throw new AppError("CONFLICT", "Workspace role is unchanged");
    const updated = await this.underOwnerLock(collaborationWorkspaceId, target, (stores) =>
      stores.workspaces.updateMembershipRole({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        userId: targetUserId,
        role
      })
    );
    await this.record(
      call,
      collaborationWorkspaceId,
      "collaboration_workspace.member_role_changed",
      { targetUserId, oldRole: target.role, newRole: role }
    );
    return updated;
  }

  async removeMember(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ) {
    return this.whileRightsHeld(call, targetUserId, (held, now) =>
      held.removeMemberNow(now, collaborationWorkspaceId, targetUserId)
    );
  }

  private async removeMemberNow(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ): Promise<WorkspaceMembership> {
    const actor = await this.requireRole(call, collaborationWorkspaceId, "admin");
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const target = await this.requireMembership(collaborationWorkspaceId, targetUserId);
    if (actor.role === "admin" && target.role !== "member") {
      throw refusalError(call.operationId, "Workspace Admins may remove regular Members only");
    }
    const removed = await this.underOwnerLock(collaborationWorkspaceId, target, (stores) =>
      stores.workspaces.removeMembership({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        userId: targetUserId
      })
    );
    await this.record(call, collaborationWorkspaceId, "collaboration_workspace.member_removed", {
      targetUserId
    });
    return removed;
  }

  async leaveWorkspace(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ) {
    return this.whileRightsHeld(call, call.user.id, (held, now) =>
      held.leaveWorkspaceNow(now, collaborationWorkspaceId)
    );
  }

  private async leaveWorkspaceNow(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceMembership> {
    const access = await this.requireRole(call, collaborationWorkspaceId, "member");
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    if (!access.membershipRole) {
      throw new AppError("CONFLICT", "User is not a workspace member");
    }
    const removed = await this.underOwnerLock(
      collaborationWorkspaceId,
      { userId: access.userId },
      (stores) =>
        stores.workspaces.removeMembership({
          clientInstanceId: this.options.clientInstanceId,
          collaborationWorkspaceId,
          userId: access.userId
        })
    );
    await this.record(call, collaborationWorkspaceId, "collaboration_workspace.member_left", {
      targetUserId: access.userId
    });
    return removed;
  }

  async browseDirectory(user: AuthenticatedUser): Promise<WorkspaceDirectoryItem[]> {
    const subjectUserId = asUserId(getSubjectUserId(user));
    const workspaces = await this.options.stores.workspaces.listDiscoverableWorkspaces({
      clientInstanceId: this.options.clientInstanceId
    });
    return Promise.all(
      workspaces.map(async (workspace) => {
        const [membership, request] = await Promise.all([
          this.options.stores.workspaces.getMembership({
            clientInstanceId: this.options.clientInstanceId,
            collaborationWorkspaceId: workspace.id,
            userId: subjectUserId
          }),
          this.options.stores.workspaces.getAccessRequest({
            clientInstanceId: this.options.clientInstanceId,
            collaborationWorkspaceId: workspace.id,
            userId: subjectUserId
          })
        ]);
        return {
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          emoji: workspace.emoji,
          accentColor: workspace.accentColor,
          accessState: membership ? "member" : request ? "request_pending" : "can_request",
          createdAt: workspace.createdAt
        };
      })
    );
  }

  async requestAccess(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ) {
    const subjectUserId = asUserId(getSubjectUserId(call.user));
    await this.requireDiscoverableWorkspace(collaborationWorkspaceId);
    if (
      await this.options.stores.workspaces.getMembership({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        userId: subjectUserId
      })
    ) {
      throw new AppError("CONFLICT", "User is already a workspace member");
    }
    if (
      await this.options.stores.workspaces.getAccessRequest({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId,
        userId: subjectUserId
      })
    ) {
      throw new AppError("CONFLICT", "A workspace access request is already pending");
    }
    const request = await this.options.stores.workspaces.createAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: subjectUserId
    });
    await this.record(call, collaborationWorkspaceId, "collaboration_workspace.access_requested", {
      targetUserId: subjectUserId
    });
    return request;
  }

  async listAccessRequests(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceAccessRequestItem[]> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
    const [requests, users] = await Promise.all([
      this.options.stores.workspaces.listAccessRequestsForWorkspace({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      }),
      this.options.stores.users.listUsers({ clientInstanceId: this.options.clientInstanceId })
    ]);
    const usersById = new Map(users.map((candidate) => [candidate.id, candidate]));
    return requests.map((request) => {
      const requester = usersById.get(request.userId);
      if (!requester) throw new AppError("INTERNAL", "Access requester is not available");
      return {
        userId: requester.id,
        displayLabel: requester.displayLabel,
        email: requester.email ?? null,
        createdAt: request.createdAt
      };
    });
  }

  async approveAccessRequest(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ) {
    return this.whileRightsHeld(call, targetUserId, (held, now) =>
      held.approveAccessRequestNow(now, collaborationWorkspaceId, targetUserId)
    );
  }

  private async approveAccessRequestNow(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ): Promise<WorkspaceMembership> {
    await this.requireRole(call, collaborationWorkspaceId, "admin");
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const request = await this.options.stores.workspaces.getAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId
    });
    if (!request) throw new AppError("NOT_FOUND", "Workspace Access Request is not available");
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    if (
      !users.some((candidate) => candidate.id === targetUserId && candidate.status === "active")
    ) {
      throw new AppError("CONFLICT", CANNOT_ADD_MEMBER_MESSAGE);
    }
    const added = await this.options.stores.workspaces.addMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId,
      role: "member"
    });
    await this.options.stores.workspaces.deleteAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId
    });
    await this.record(
      call,
      collaborationWorkspaceId,
      "collaboration_workspace.access_request_approved",
      { targetUserId }
    );
    return added;
  }

  async declineAccessRequest(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ) {
    await this.requireRole(call, collaborationWorkspaceId, "admin");
    const request = await this.options.stores.workspaces.deleteAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId
    });
    await this.record(
      call,
      collaborationWorkspaceId,
      "collaboration_workspace.access_request_declined",
      { targetUserId }
    );
    return request;
  }

  private async toListItem(
    workspace: CollaborationWorkspace,
    access: WorkspaceAccess
  ): Promise<WorkspaceListItem> {
    return {
      ...workspace,
      role: access.role,
      membershipRole: access.membershipRole,
      pendingAccessRequestCount: await this.countPendingAccessRequests(
        workspace.id,
        access.membershipRole
      )
    };
  }

  /** Pending requests are a to-do for the workspace's own Owners and Admins, nobody else. */
  private async countPendingAccessRequests(
    collaborationWorkspaceId: CollaborationWorkspaceId,
    membershipRole: WorkspaceMembershipRole | null
  ): Promise<number> {
    if (membershipRole !== "owner" && membershipRole !== "admin") return 0;
    const requests = await this.options.stores.workspaces.listAccessRequestsForWorkspace({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId
    });
    return requests.length;
  }

  private async requireWorkspace(
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace> {
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    return workspace;
  }

  private async requireSharedWorkspace(
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace> {
    const workspace = await this.requireWorkspace(collaborationWorkspaceId);
    if (workspace.kind !== "shared") {
      throw new AppError("VALIDATION_FAILED", "This action requires a Shared Workspace");
    }
    return workspace;
  }

  /** A Shared Workspace that can be found, or the refusal that it is not there for the caller. */
  private async requireDiscoverableWorkspace(
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<void> {
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace || workspace.kind !== "shared" || workspace.visibility !== "discoverable") {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
  }

  /**
   * The caller's access, asked again where the operation writes: the role may have changed
   * since the call was admitted. The refusal ends the run as denied, like the one before it.
   */
  private async requireRole(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    needed: WorkspaceRoleNeeded
  ): Promise<WorkspaceAccess> {
    const access = await this.requireWorkspaceAccess(call.user, collaborationWorkspaceId);
    requireNoRefusal(call.operationId, roleRefusal(access, needed));
    return access;
  }

  private async requireMembership(
    collaborationWorkspaceId: CollaborationWorkspaceId,
    userId: UserRecord["id"]
  ): Promise<WorkspaceMembership> {
    const membership = await this.options.stores.workspaces.getMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId
    });
    if (!membership) throw new AppError("NOT_FOUND", "Workspace member is not available");
    return membership;
  }

  /**
   * `withRightsHeld` for a change of who is a member: a membership holds the rights of the
   * workspace, so the change waits for and is waited for by every other write of rights. The
   * workflow runs on the transaction's stores, with the caller as they are now.
   */
  private whileRightsHeld<Result>(
    call: WorkspaceChangeCall,
    userId: string | undefined,
    change: (held: CollaborationWorkspaceWorkflow, now: WorkspaceChangeCall) => Promise<Result>
  ): Promise<Result> {
    return withRightsHeld(
      this.options,
      { actor: call.user, access: call.access, ...(userId === undefined ? {} : { userId }) },
      ({ options, actor, access }) =>
        change(new CollaborationWorkspaceWorkflow(options), { ...call, user: actor, access })
    );
  }

  /**
   * Changes or removes a membership under the lock every change of owners takes, and refuses
   * to take the last active owner from the workspace. The role is read again under the lock:
   * the deletion of another owner's account, or a second change, may have come first.
   */
  private underOwnerLock<Result>(
    collaborationWorkspaceId: CollaborationWorkspaceId,
    target: Pick<WorkspaceMembership, "userId">,
    change: (stores: PlatformStores) => Promise<Result>
  ): Promise<Result> {
    const scope = { clientInstanceId: this.options.clientInstanceId, collaborationWorkspaceId };
    return this.options.stores.transaction(async (stores) => {
      await stores.workspaces.lockWorkspacesForOwnerChange(scope);
      const current = await stores.workspaces.getMembership({ ...scope, userId: target.userId });
      if (current?.role === "owner") {
        const [memberships, users] = await Promise.all([
          stores.workspaces.listMemberships(scope),
          stores.users.listUsers({ clientInstanceId: this.options.clientInstanceId })
        ]);
        const activeUserIds = new Set(
          users
            .filter((candidate) => candidate.status === "active")
            .map((candidate) => candidate.id)
        );
        const anotherActiveOwner = memberships.some(
          (membership) =>
            membership.role === "owner" &&
            membership.userId !== target.userId &&
            activeUserIds.has(membership.userId)
        );
        if (!anotherActiveOwner) throw new AppError("CONFLICT", LAST_OWNER_MESSAGE);
      }
      return change(stores);
    });
  }

  private async record(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    type: string,
    metadata?: Record<string, string | string[]>
  ): Promise<void> {
    const { audit: auditRecorder } = call;
    await auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(call.user),
      subject: collaborationWorkspaceId,
      correlationId: call.correlationId,
      metadata
    });
  }
}

/**
 * The one place a role is held against what an operation asks: the sentence a caller whose
 * role is too low reads, or nothing where the role is enough.
 */
function roleRefusal(access: WorkspaceAccess, needed: WorkspaceRoleNeeded): string | undefined {
  if (needed === "owner" && access.role !== "owner") return "Workspace Owner access is required";
  if (needed === "admin" && access.role !== "owner" && access.role !== "admin") {
    return "Workspace Owner or Admin access is required";
  }
  return undefined;
}

/** A read asks the role and refuses with the same sentence as a change. */
function requireOwnerOrAdmin(access: WorkspaceAccess): void {
  const refusal = roleRefusal(access, "admin");
  if (refusal !== undefined) throw new AppError("FORBIDDEN", refusal);
}

function requireOwner(access: WorkspaceAccess): void {
  const refusal = roleRefusal(access, "owner");
  if (refusal !== undefined) throw new AppError("FORBIDDEN", refusal);
}

/** What the `authorize` of an operation answers: a refusal names the operation and says the rule. */
function authorizationOf(operationId: string, refusal: string | undefined): OperationAuthorization {
  return refusal === undefined
    ? { allowed: true }
    : { allowed: false, action: operationId, reason: "no_grant", message: refusal };
}

/** The same refusal thrown inside the operation. With these details the run ends as denied. */
function refusalError(operationId: string, message: string): AppError {
  return new AppError("FORBIDDEN", message, { action: operationId, reason: "no_grant" });
}

function requireNoRefusal(operationId: string, refusal: string | undefined): void {
  if (refusal !== undefined) throw refusalError(operationId, refusal);
}

function normalizeRequiredName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AppError("VALIDATION_FAILED", "Workspace name is required");
  if (normalized.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace name must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`
    );
  }
  return normalized;
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace description must be at most ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters`
    );
  }
  return normalized || null;
}

function normalizeEmoji(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > MAX_WORKSPACE_EMOJI_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace emoji must be at most ${MAX_WORKSPACE_EMOJI_LENGTH} characters`
    );
  }
  return normalized || null;
}

function validateAccentColor(
  value: WorkspaceAccentColor | null | undefined
): WorkspaceAccentColor | null {
  if (value === undefined || value === null) return null;
  if (!WORKSPACE_ACCENT_COLORS.includes(value)) {
    throw new AppError("VALIDATION_FAILED", "Workspace accent color is not available");
  }
  return value;
}

function workspaceChangedFields(
  workspace: CollaborationWorkspace,
  update: UpdateWorkspaceSettingsCommand
): string[] {
  return (
    [
      "name",
      "description",
      "visibility",
      "defaultConversationVisibility",
      "emoji",
      "accentColor"
    ] as const
  ).filter((field) => update[field] !== undefined && update[field] !== workspace[field]);
}
