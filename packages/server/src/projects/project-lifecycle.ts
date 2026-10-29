import {
  AppError,
  asConversationId,
  auditActorFromUser,
  getSubjectUserId,
  isAppError,
  type AuditRecorder,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type ProjectAudience,
  type ProjectAudienceChange,
  type ProjectDeletionConversations,
  type ProjectImpact,
  type ProjectMove
} from "@work-shape/catalyst-core";
import { assertConversationIdle } from "../conversations/conversation-idle";
import { attemptConversationDataCleanup } from "../deletion/conversation-cleanup";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";
import { projectNotAvailable, requireProjectAccess } from "./project-access";
import { attemptClaimedProjectCleanup } from "./project-cleanup";

type Context = { correlationId: string; audit: AuditRecorder };

/**
 * A whole project (PRJ-6): who reads it, which workspace holds it, and its deletion. Every call
 * first asks `requireProjectAccess`, so a project outside the caller's audience answers as one
 * that does not exist. The store decides each change again under the project's row lock.
 */
export class ProjectLifecycleWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async impact(user: AuthenticatedUser, projectId: string): Promise<ProjectImpact> {
    const project = await requireProjectAccess(this.options, user, projectId);
    return this.options.stores.projects.getProjectImpact({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id
    });
  }

  /**
   * Shares the project with its workspace or makes it private to its creator, with every chat
   * in it (section 3). Only the creator, and only in a Shared Workspace. No chat in it may
   * have work in progress, as for one chat whose readers change.
   */
  async setAudience(
    user: AuthenticatedUser,
    context: Context,
    projectId: string,
    command: { audience: ProjectAudience; expectedAudience: ProjectAudience }
  ): Promise<ProjectAudienceChange> {
    const project = await requireProjectAccess(this.options, user, projectId);
    if (project.createdByUserId !== getSubjectUserId(user)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only the creator of a project changes who reads it",
        { reason: "project_creator_only" },
        { exposeMessage: true }
      );
    }
    if (command.audience !== command.expectedAudience) {
      await this.requireIdle(project.id);
    }
    const change = await this.options.stores.projects.setProjectAudience({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      collaborationWorkspaceId: project.collaborationWorkspaceId,
      expectedAudience: command.expectedAudience,
      audience: command.audience,
      changedAt: new Date().toISOString()
    });
    if (command.audience !== command.expectedAudience) {
      // Ids, audiences and counts: never the title.
      await context.audit.record({
        type: "project.audience_changed",
        status: "success",
        actor: auditActorFromUser(user),
        subject: project.id,
        correlationId: context.correlationId,
        metadata: {
          workspaceId: project.collaborationWorkspaceId,
          previousAudience: command.expectedAudience,
          audience: command.audience,
          conversationsShared: change.conversationsShared,
          conversationsLeft: change.conversationsLeft,
          conversationsMadePrivate: change.conversationsMadePrivate
        }
      });
    }
    return change;
  }

  /**
   * Moves the project with its chats and files to another workspace (section 10). The caller
   * is in its audience and a member of both workspaces: the superadmin's Owner access to a
   * Shared Workspace moves nothing into or out of it. A project keeps its audience; out of a
   * Personal Workspace the caller says who reads it, and into one it is that person's. Grants
   * on the project end with the move.
   */
  async move(
    user: AuthenticatedUser,
    context: Context,
    projectId: string,
    command: { collaborationWorkspaceId: CollaborationWorkspaceId; audience?: ProjectAudience }
  ): Promise<ProjectMove> {
    const project = await requireProjectAccess(this.options, user, projectId);
    const from = project.collaborationWorkspaceId;
    const to = command.collaborationWorkspaceId;
    if (from === to) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The project already belongs to this workspace",
        { reason: "project_same_workspace" },
        { exposeMessage: true }
      );
    }
    const source = await this.requireMemberOf(user, from);
    const destination = await this.requireMemberOf(user, to);
    let audience: ProjectAudience;
    if (destination.kind === "personal") {
      audience = "workspace";
    } else if (source.kind === "personal") {
      // A Personal Workspace's project is one person's: it is shared only when they say so.
      audience = command.audience ?? "private";
    } else {
      if (command.audience !== undefined && command.audience !== project.audience) {
        throw new AppError(
          "VALIDATION_FAILED",
          "A project keeps who reads it when it moves; its creator changes that on its own",
          { reason: "project_move_keeps_audience" },
          { exposeMessage: true }
        );
      }
      audience = project.audience;
    }
    await this.requireIdle(project.id);
    const moved = await this.options.stores.projects.moveProject({
      clientInstanceId: this.options.clientInstanceId,
      projectId: project.id,
      fromCollaborationWorkspaceId: from,
      toCollaborationWorkspaceId: to,
      audience,
      movedAt: new Date().toISOString()
    });
    // A change of who may reach the project: both workspaces, audiences and counts.
    await context.audit.record({
      type: "project.moved",
      status: "success",
      actor: auditActorFromUser(user),
      subject: project.id,
      correlationId: context.correlationId,
      metadata: {
        fromWorkspaceId: from,
        toWorkspaceId: to,
        previousAudience: project.audience,
        audience: moved.project.audience,
        conversationsMoved: moved.conversationsMoved,
        grantsDropped: moved.grantsDropped
      }
    });
    return moved;
  }

  /**
   * Deletes the project with its definition, revisions and files (section 10). Its chats stay
   * in the workspace, each read as before, or are deleted too. Claims first, then cleans up,
   * as every deletion does: the project and the chats chosen with it are claimed in one
   * transaction, and only then are stored bytes removed. A cleanup that fails is retried by the
   * retention job and does not fail the request.
   */
  async delete(
    user: AuthenticatedUser,
    context: Context,
    projectId: string,
    command: { conversations: ProjectDeletionConversations }
  ): Promise<{ conversationsDeleted: number; conversationsKept: number }> {
    const project = await requireProjectAccess(this.options, user, projectId);
    const { clientInstanceId } = this.options;
    if (command.conversations === "delete" && !this.options.config.retention.allowUserDelete) {
      throw new AppError(
        "FORBIDDEN",
        "User conversation deletion is disabled for this client instance"
      );
    }
    const deletedAt = new Date().toISOString();
    // The project first: from its claim no chat enters it and no file is written into it, and
    // the chats in it at that moment are the ones the choice is about.
    const claim = await this.options.stores.projects.claimProjectDeletion({
      clientInstanceId,
      projectId: project.id,
      collaborationWorkspaceId: project.collaborationWorkspaceId,
      deleteConversations: command.conversations === "delete",
      deletedAt
    });
    if (claim.status === "not_claimed") throw projectNotAvailable();
    // The chats are claimed with the project: a cleanup that fails here is finished by the
    // conversation retry, and the chats are deleted whatever happens after this line.
    for (const id of claim.deletedConversationIds) {
      const cleanup = await attemptConversationDataCleanup(
        this.options,
        asConversationId(id),
        deletedAt
      );
      await context.audit.record({
        type: "conversation.deleted",
        status: "success",
        actor: auditActorFromUser(user),
        subject: id,
        correlationId: context.correlationId,
        metadata: { requestedBy: "project_deleted", projectId: project.id, ...cleanup }
      });
    }
    const deleted = claim.deletedConversationIds;
    const kept = claim.conversationIds.length;
    const cleanup = await attemptClaimedProjectCleanup(this.options, project.id);
    await context.audit.record({
      type: "project.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: project.id,
      correlationId: context.correlationId,
      metadata: {
        workspaceId: project.collaborationWorkspaceId,
        audience: project.audience,
        conversations: command.conversations,
        conversationsDeleted: deleted.length,
        conversationsKept: kept,
        cleanup: cleanup.cleanup
      }
    });
    return { conversationsDeleted: deleted.length, conversationsKept: kept };
  }

  /** A workspace the user is a member of; its record. */
  private async requireMemberOf(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace> {
    const notAvailable = () =>
      new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    let membershipRole: string | null;
    try {
      ({ membershipRole } = await requireWorkspaceAccess(
        this.options,
        user,
        collaborationWorkspaceId
      ));
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") throw notAvailable();
      throw error;
    }
    if (membershipRole === null) {
      throw new AppError(
        "FORBIDDEN",
        "Only a member of both workspaces moves a project",
        { reason: "project_move_member_only" },
        { exposeMessage: true }
      );
    }
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace) throw notAvailable();
    return workspace;
  }

  /** Refuses while a chat of the project has a run, an upload or a command in progress. */
  private async requireIdle(projectId: string): Promise<void> {
    const ids = await this.options.stores.projects.listProjectConversationIds({
      clientInstanceId: this.options.clientInstanceId,
      projectId
    });
    for (const id of ids) await assertConversationIdle(this.options, asConversationId(id));
  }
}
