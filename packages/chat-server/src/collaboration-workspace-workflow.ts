import {
  type ISODateString,
  AppError,
  WORKSPACE_ACCENT_COLORS,
  asUserId,
  auditActorFromUser,
  getSubjectUserId,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceWithRole,
  type ConversationId,
  type ConversationVisibility,
  type RuntimeAssetSnapshot,
  type RuntimeCallContext,
  type UserRecord,
  type WorkspaceAccentColor,
  type WorkspaceMemberCandidate,
  type WorkspaceMembership,
  type WorkspaceMembershipRole,
  type WorkspaceVisibility
} from "@vivd-catalyst/core";
import { getWorkspaceAssetSnapshot } from "./agent-availability";
import type { ChatServerOptions } from "./types";
import { pendingCleanupCountOf } from "./conversation-cleanup";
import { deleteConversationAggregate } from "./user-deletion";

const MAX_WORKSPACE_NAME_LENGTH = 120;
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500;
const MAX_WORKSPACE_EMOJI_LENGTH = 32;
const CANNOT_ADD_MEMBER_MESSAGE =
  "This user cannot be added. Invitations for people without an eligible account are not available yet.";
const LAST_OWNER_MESSAGE = "A Shared Workspace must retain at least one active owner";
const COLLABORATION_WORKSPACES_DISABLED_MESSAGE =
  "Collaboration workspaces are not enabled for this instance";

/**
 * What a user may do in one Collaboration Workspace. A superadmin acts as Owner of every Shared
 * Workspace, so `role` can exceed the user's own Workspace Membership or exist without one.
 */
export interface WorkspaceAccess {
  userId: UserRecord["id"];
  role: WorkspaceMembershipRole;
  /** The user's own Workspace Membership role; null when only the superadmin role gives access. */
  membershipRole: WorkspaceMembershipRole | null;
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

export interface WorkspaceDeletionResult {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  conversationCount: number;
  fileCount: number;
  memberCount: number;
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

  /**
   * The single access check for a Collaboration Workspace. Nobody but its user reaches a
   * Personal Workspace, and private Conversations stay with their author (ADR-0015).
   */
  async requireWorkspaceAccess(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceAccess> {
    const userId = asUserId(getSubjectUserId(user));
    const membership = await this.options.stores.workspaces.getMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId
    });
    const membershipRole = membership?.role ?? null;
    // Only a superadmin's access depends on the workspace itself, so only they load it here.
    const workspace = isSuperadmin(user)
      ? await this.options.stores.workspaces.getWorkspace(
          this.options.clientInstanceId,
          collaborationWorkspaceId
        )
      : undefined;
    const role = workspace
      ? effectiveWorkspaceRole(user, workspace, membershipRole)
      : membershipRole;
    if (!role) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return { userId, role, membershipRole };
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateSharedWorkspaceCommand
  ): Promise<WorkspaceListItem> {
    this.requireCollaborationWorkspacesEnabled();
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
    await this.record(context, user, workspace.id, "collaboration_workspace.created");
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

  async deleteSharedWorkspace(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    confirmName: string
  ): Promise<WorkspaceDeletionResult> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwner(access);
    const workspace = await this.requireSharedWorkspace(collaborationWorkspaceId);
    if (confirmName !== workspace.name) {
      throw new AppError("VALIDATION_FAILED", "Workspace name confirmation does not match");
    }

    const conversations = await this.options.stores.conversations.listConversationsForWorkspace({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      scope: { kind: "lifecycle" }
    });
    for (const conversation of conversations) {
      await this.assertConversationIdle(conversation.id);
    }
    const memberships = await this.options.stores.workspaces.listMemberships({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId
    });

    let conversationCount = 0;
    let fileCount = 0;
    for (const conversation of conversations) {
      const current = await this.options.stores.conversations.getConversation(
        this.options.clientInstanceId,
        conversation.id
      );
      if (!current || current.collaborationWorkspaceId !== collaborationWorkspaceId) {
        continue;
      }
      await this.assertConversationIdle(conversation.id);
      const deletedAt = new Date().toISOString();
      const deletion = await deleteConversationAggregate(this.options, conversation.id, deletedAt);
      conversationCount += 1;
      if (deletion.cleanup === "complete") {
        fileCount += deletion.fileCount + deletion.artifactCount + deletion.workspaceFileCount;
      }
      await this.options.auditRecorder.record({
        type: "conversation.deleted",
        status: "success",
        actor: auditActorFromUser(user),
        subject: conversation.id,
        correlationId: context.correlationId,
        metadata: {
          requestedBy: "workspace_deletion",
          ...deletion
        }
      });
    }

    try {
      await this.options.stores.workspaces.deleteWorkspace({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      });
    } catch (error) {
      const pendingCleanupCount = pendingCleanupCountOf(error);
      if (pendingCleanupCount !== undefined) {
        await this.options.auditRecorder.record({
          type: "collaboration_workspace.delete_failed",
          status: "failed",
          actor: auditActorFromUser(user),
          subject: collaborationWorkspaceId,
          correlationId: context.correlationId,
          metadata: { conversationCount, pendingCleanupCount }
        });
      }
      throw error;
    }
    const result = {
      collaborationWorkspaceId,
      conversationCount,
      fileCount,
      memberCount: memberships.length
    };
    await this.options.auditRecorder.record({
      type: "collaboration_workspace.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: collaborationWorkspaceId,
      correlationId: context.correlationId,
      metadata: {
        conversationCount: result.conversationCount,
        fileCount: result.fileCount,
        memberCount: result.memberCount
      }
    });
    return result;
  }

  async assertConversationIdle(conversationId: ConversationId): Promise<void> {
    const [activeRun, draftAttachments, activeCommands, artifacts] = await Promise.all([
      this.options.stores.agentRuns.getActiveConversationAgentRun({
        clientInstanceId: this.options.clientInstanceId,
        conversationId
      }),
      this.options.attachments?.listDraftAttachments(conversationId) ?? [],
      this.options.stores.executionWorkspaces.countActiveWorkspaceCommands({
        clientInstanceId: this.options.clientInstanceId,
        conversationId
      }),
      this.options.stores.files.listConversationManagedArtifacts({
        clientInstanceId: this.options.clientInstanceId,
        conversationId
      })
    ]);
    const previewJobs = await Promise.all(
      artifacts.map((artifact) =>
        this.options.stores.files.getArtifactPreviewJob({
          clientInstanceId: this.options.clientInstanceId,
          sourceArtifactId: artifact.id
        })
      )
    );
    const busyStates = [
      ...(activeRun ? ["active_agent_run"] : []),
      ...(draftAttachments.some(
        (attachment) => attachment.status === "queued" || attachment.status === "preprocessing"
      )
        ? ["attachment_processing"]
        : []),
      ...(activeCommands.total > 0 ? ["execution_workspace_command"] : []),
      ...(previewJobs.some((job) => job?.status === "pending" || job?.status === "processing")
        ? ["artifact_preview"]
        : [])
    ];
    if (busyStates.length > 0) {
      throw new AppError("CONFLICT", "Conversation has mutable background work in progress", {
        busyStates
      });
    }
  }

  async updateSettings(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    command: UpdateWorkspaceSettingsCommand
  ): Promise<WorkspaceListItem> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
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
    await this.record(context, user, collaborationWorkspaceId, "collaboration_workspace.updated", {
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
    this.requireCollaborationWorkspacesEnabled();
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    email: string
  ): Promise<WorkspaceMemberItem> {
    this.requireCollaborationWorkspacesEnabled();
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
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
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.member_added",
      {
        targetUserId: target.id
      }
    );
    return {
      userId: target.id,
      displayLabel: target.displayLabel,
      email: target.email ?? null,
      role: "member"
    };
  }

  async changeMemberRole(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"],
    role: WorkspaceMembershipRole
  ): Promise<WorkspaceMembership> {
    const actor = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new AppError("FORBIDDEN", "Workspace Owner access is required");
    }
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const target = await this.requireMembership(collaborationWorkspaceId, targetUserId);
    if (actor.role === "admin") {
      if (target.role !== "member" || role !== "member") {
        throw new AppError("FORBIDDEN", "Workspace Admins may manage regular Members only");
      }
    }
    if (target.role === role) throw new AppError("CONFLICT", "Workspace role is unchanged");
    if (target.role === "owner" && role !== "owner") {
      await this.requireAnotherActiveOwner(collaborationWorkspaceId, target.userId);
    }
    const updated = await this.options.stores.workspaces.updateMembershipRole({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId,
      role
    });
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.member_role_changed",
      { targetUserId, oldRole: target.role, newRole: role }
    );
    return updated;
  }

  async removeMember(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ): Promise<WorkspaceMembership> {
    const actor = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new AppError("FORBIDDEN", "Workspace Owner or Admin access is required");
    }
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    const target = await this.requireMembership(collaborationWorkspaceId, targetUserId);
    if (actor.role === "admin" && target.role !== "member") {
      throw new AppError("FORBIDDEN", "Workspace Admins may remove regular Members only");
    }
    if (target.role === "owner") {
      await this.requireAnotherActiveOwner(collaborationWorkspaceId, target.userId);
    }
    const removed = await this.options.stores.workspaces.removeMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId
    });
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.member_removed",
      { targetUserId }
    );
    return removed;
  }

  async leaveWorkspace(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<WorkspaceMembership> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    await this.requireSharedWorkspace(collaborationWorkspaceId);
    if (!access.membershipRole) {
      throw new AppError("CONFLICT", "User is not a workspace member");
    }
    if (access.membershipRole === "owner") {
      await this.requireAnotherActiveOwner(collaborationWorkspaceId, access.userId);
    }
    const removed = await this.options.stores.workspaces.removeMembership({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: access.userId
    });
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.member_left",
      { targetUserId: access.userId }
    );
    return removed;
  }

  async browseDirectory(user: AuthenticatedUser): Promise<WorkspaceDirectoryItem[]> {
    this.requireCollaborationWorkspacesEnabled();
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ) {
    this.requireCollaborationWorkspacesEnabled();
    const subjectUserId = asUserId(getSubjectUserId(user));
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace || workspace.kind !== "shared" || workspace.visibility !== "discoverable") {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
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
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.access_requested",
      { targetUserId: subjectUserId }
    );
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ): Promise<WorkspaceMembership> {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
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
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.access_request_approved",
      { targetUserId }
    );
    return added;
  }

  async declineAccessRequest(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    targetUserId: UserRecord["id"]
  ) {
    const access = await this.requireWorkspaceAccess(user, collaborationWorkspaceId);
    requireOwnerOrAdmin(access);
    const request = await this.options.stores.workspaces.deleteAccessRequest({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      userId: targetUserId
    });
    await this.record(
      context,
      user,
      collaborationWorkspaceId,
      "collaboration_workspace.access_request_declined",
      { targetUserId }
    );
    return request;
  }

  private requireCollaborationWorkspacesEnabled(): void {
    if (!this.options.config.ui.collaborationWorkspaces.enabled) {
      throw new AppError("FORBIDDEN", COLLABORATION_WORKSPACES_DISABLED_MESSAGE);
    }
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

  private async requireAnotherActiveOwner(
    collaborationWorkspaceId: CollaborationWorkspaceId,
    excludedUserId: UserRecord["id"]
  ): Promise<void> {
    const [memberships, users] = await Promise.all([
      this.options.stores.workspaces.listMemberships({
        clientInstanceId: this.options.clientInstanceId,
        collaborationWorkspaceId
      }),
      this.options.stores.users.listUsers({ clientInstanceId: this.options.clientInstanceId })
    ]);
    const activeUserIds = new Set(
      users.filter((candidate) => candidate.status === "active").map((candidate) => candidate.id)
    );
    if (
      !memberships.some(
        (membership) =>
          membership.role === "owner" &&
          membership.userId !== excludedUserId &&
          activeUserIds.has(membership.userId)
      )
    ) {
      throw new AppError("CONFLICT", LAST_OWNER_MESSAGE);
    }
  }

  private async record(
    context: RuntimeCallContext,
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId,
    type: string,
    metadata?: Record<string, string | string[]>
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(user),
      subject: collaborationWorkspaceId,
      correlationId: context.correlationId,
      metadata
    });
  }
}

function isSuperadmin(user: AuthenticatedUser): boolean {
  return user.roles.includes("superadmin");
}

/** Membership decides, except that a superadmin is Owner of every Shared Workspace. */
function effectiveWorkspaceRole<Role extends WorkspaceMembershipRole | null>(
  user: AuthenticatedUser,
  workspace: Pick<CollaborationWorkspace, "kind">,
  membershipRole: Role
): WorkspaceMembershipRole | Role {
  return isSuperadmin(user) && workspace.kind === "shared" ? "owner" : membershipRole;
}

function requireOwnerOrAdmin(access: WorkspaceAccess): void {
  if (access.role !== "owner" && access.role !== "admin") {
    throw new AppError("FORBIDDEN", "Workspace Owner or Admin access is required");
  }
}

function requireOwner(access: WorkspaceAccess): void {
  if (access.role !== "owner") {
    throw new AppError("FORBIDDEN", "Workspace Owner access is required");
  }
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
