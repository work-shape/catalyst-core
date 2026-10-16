import {
  AppError,
  asUserId,
  auditActorFromUser,
  getSubjectUserId,
  isSuperadmin,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type OperationAuthorization,
  type PlatformStores,
  type RuntimeAssetSnapshot,
  type UserRecord,
  type WorkspaceMemberCandidate,
  type WorkspaceMembership,
  type WorkspaceMembershipRole
} from "@work-shape/catalyst-core";
import { withRightsHeld } from "../access/rights-held";
import { assertConversationIdle } from "../conversations/conversation-idle";
import type { DeletionOutcome } from "../deletion/subject-deletion";
import {
  requestWorkspaceDeletion,
  type WorkspaceDeletionResult
} from "../deletion/workspace-deletion";
import type { ChatServerOptions } from "../types";
import { getWorkspaceAssetSnapshot } from "./agent-availability";
import { recordWorkspaceChange } from "./workspace-service-audit";
import {
  effectiveWorkspaceRole,
  requireWorkspaceAccess,
  type WorkspaceAccess
} from "./workspace-access";
import {
  approveAccessRequestNow,
  browseDirectory,
  declineAccessRequest,
  listAccessRequests,
  requestAccess
} from "./workspace-access-requests";
import {
  authorizationOf,
  CANNOT_ADD_MEMBER_MESSAGE,
  refusalError,
  requireNoRefusal,
  requireOwner,
  requireOwnerOrAdmin,
  roleRefusal
} from "./workspace-service-access";
import {
  type CreateSharedWorkspaceCommand,
  type UpdateWorkspaceSettingsCommand,
  type WorkspaceAccessRequestItem,
  type WorkspaceChangeCall,
  type WorkspaceDeletionImpact,
  type WorkspaceDirectoryItem,
  type WorkspaceListItem,
  type WorkspaceMemberItem,
  type WorkspaceRoleNeeded
} from "./workspace-service-types";
import {
  normalizeDescription,
  normalizeEmoji,
  normalizeRequiredName,
  validateAccentColor,
  workspaceChangedFields
} from "./workspace-settings";

const LAST_OWNER_MESSAGE = "A Shared Workspace must retain at least one active owner";

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
    return browseDirectory({ options: this.options }, user);
  }

  async requestAccess(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ) {
    return requestAccess(
      {
        options: this.options,
        requireDiscoverableWorkspace: this.requireDiscoverableWorkspace.bind(this)
      },
      call,
      collaborationWorkspaceId
    );
  }

  async listAccessRequests(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceAccessRequestItem[]> {
    return listAccessRequests(
      { options: this.options, requireWorkspaceAccess: this.requireWorkspaceAccess.bind(this) },
      user,
      collaborationWorkspaceId
    );
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
    return approveAccessRequestNow(
      {
        options: this.options,
        requireRole: this.requireRole.bind(this),
        requireSharedWorkspace: this.requireSharedWorkspace.bind(this)
      },
      call,
      collaborationWorkspaceId,
      targetUserId
    );
  }

  async declineAccessRequest(
    call: WorkspaceChangeCall,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ) {
    return declineAccessRequest(
      {
        options: this.options,
        requireRole: this.requireRole.bind(this)
      },
      call,
      collaborationWorkspaceId,
      targetUserId
    );
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
    return recordWorkspaceChange(call, collaborationWorkspaceId, type, metadata);
  }
}
export {
  type CreateSharedWorkspaceCommand,
  type UpdateWorkspaceSettingsCommand,
  type WorkspaceAccessRequestItem,
  type WorkspaceChangeCall,
  type WorkspaceDeletionImpact,
  type WorkspaceDirectoryItem,
  type WorkspaceListItem,
  type WorkspaceMemberItem,
  type WorkspaceRoleNeeded
} from "./workspace-service-types";
