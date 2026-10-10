import type { StorePage } from "@vivd-catalyst/core";
import { auditActorFromUser } from "@vivd-catalyst/core";
import {
  AppError,
  JobLeaseLostError,
  type AuthenticatedUser,
  type Conversation,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type ConversationListItem,
  type ConversationId,
  type ConversationVisibility,
  type JobControl,
  type JsonObject,
  type RuntimeCallContext,
  type UserId,
  addDays,
  asUserId,
  getSubjectUserId,
  isAppError
} from "@vivd-catalyst/core";
import { getModelSelectionForConversationTitles } from "@vivd-catalyst/config-schema";
import { CollaborationWorkspaceWorkflow } from "../collaboration-workspace-workflow";
import { attemptConversationDataCleanup } from "../conversation-cleanup";
import { assertConversationIdle } from "../conversation-idle";
import {
  createTitlePrompt,
  findFirstUserMessage,
  isTemporaryConversationTitle,
  isUsableGeneratedTitle,
  normalizeGeneratedConversationTitle,
  temporaryAttachmentTitles
} from "../conversation-title";
import { modelBindingRefOf, reasoningEffortTheModelTakes } from "../system-model-call";
import type { ChatServerOptions } from "../types";

export interface CreateConversationCommand {
  title?: string;
  collaborationWorkspaceId?: CollaborationWorkspaceId;
}

export interface MoveConversationCommand {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  visibility?: ConversationVisibility;
}

// Protects a title slot and a place in admission from a model that never answers. Past it the
// title call ends, is recorded once without tokens, and the conversation keeps its first title.
const CONVERSATION_TITLE_TIMEOUT_MS = 60_000;

export class ConversationWorkflow {
  private readonly options: ChatServerOptions;
  private readonly workspaces: CollaborationWorkspaceWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.workspaces = new CollaborationWorkspaceWorkflow(options);
  }

  async listConversations(
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined,
    user: AuthenticatedUser,
    page?: StorePage,
    titleQuery?: string
  ): Promise<ConversationListItem[]> {
    if (!collaborationWorkspaceId) {
      const personal = (
        await this.options.stores.workspaces.listWorkspacesForUser({
          clientInstanceId: this.options.clientInstanceId,
          userId: asUserId(getSubjectUserId(user))
        })
      ).find((workspace) => workspace.kind === "personal");
      if (!personal) return [];
      collaborationWorkspaceId = personal.id;
    }
    await this.workspaces.requireWorkspaceAccess(user, collaborationWorkspaceId);
    return this.options.stores.conversations.listConversationsWithActiveRun({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      scope: { kind: "viewer", userId: getSubjectUserId(user) },
      titleQuery,
      page
    });
  }

  async createConversation(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateConversationCommand
  ): Promise<Conversation> {
    const subjectUserId = getSubjectUserId(user);
    const workspace = await this.resolveTargetWorkspace(user, command.collaborationWorkspaceId);
    const conversation = await this.options.stores.conversations.createConversation({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: subjectUserId,
      createdByExternalUserId: user.externalUserId,
      visibility: workspace.defaultConversationVisibility,
      title: command.title ?? "New conversation",
      retainedUntil: addDays(
        new Date(),
        this.options.config.retention.conversationDays
      ).toISOString()
    });

    await this.options.auditRecorder.record({
      type: "conversation.created",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversation.id,
      correlationId: context.correlationId,
      metadata: {
        retainedUntil: conversation.retainedUntil
      }
    });
    return conversation;
  }

  async renameConversation(
    conversationId: ConversationId,
    title: string,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation> {
    const conversation = await this.requireConversationAccess(conversationId, user);
    if (conversation.title === title) {
      return conversation;
    }

    const updated = await this.options.stores.conversations.updateConversationTitle({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      title,
      updatedAt: new Date().toISOString()
    });
    await this.options.auditRecorder.record({
      type: "conversation.renamed",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        previousTitleLength: conversation.title.length,
        titleLength: title.length
      }
    });
    return updated;
  }

  async moveConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: MoveConversationCommand
  ): Promise<Conversation> {
    const conversation = await this.requireConversationAccess(conversationId, user);
    const destination = await this.requireMemberWorkspace(user, command.collaborationWorkspaceId);
    if (conversation.collaborationWorkspaceId === command.collaborationWorkspaceId) {
      throw new AppError("VALIDATION_FAILED", "Conversation already belongs to this workspace");
    }
    const visibility: ConversationVisibility =
      destination.kind === "personal"
        ? "workspace"
        : (command.visibility ??
          (conversation.visibility === "private"
            ? "private"
            : destination.defaultConversationVisibility));
    if (visibility === "private" && conversation.createdByUserId !== getSubjectUserId(user)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only the creator of a conversation can make it private"
      );
    }
    await assertConversationIdle(this.options, conversationId);
    const moved = await this.options.stores.conversations.moveConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      fromCollaborationWorkspaceId: conversation.collaborationWorkspaceId,
      toCollaborationWorkspaceId: command.collaborationWorkspaceId,
      visibility
    });
    await this.options.auditRecorder.record({
      type: "conversation.moved",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        fromCollaborationWorkspaceId: conversation.collaborationWorkspaceId,
        toCollaborationWorkspaceId: command.collaborationWorkspaceId
      }
    });
    return moved;
  }

  /**
   * The work of the `conversation.generate_title` job. It finishes without work when the
   * conversation or the user is gone or the title is no longer the temporary one. The title is
   * written under the job's lease and only over the title it was generated for, so a rename
   * during the model call stands. A failure is thrown, so the job is tried again.
   */
  async generateTitleForConversation(
    input: { conversationId: ConversationId; userId: UserId; correlationId: string },
    control: Pick<JobControl, "signal" | "transaction">
  ): Promise<void> {
    if (!this.options.config.conversationTitles.enabled) {
      return;
    }
    const { conversationId } = input;
    const user = await this.findActiveUser(input.userId);
    if (!user) {
      return;
    }
    let conversation: Conversation;
    try {
      conversation = await this.requireConversationAccess(conversationId, user);
    } catch (error) {
      if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
        return;
      }
      throw error;
    }
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const firstUserMessage = findFirstUserMessage(messages);
    if (
      !firstUserMessage ||
      !isTemporaryConversationTitle(
        conversation.title,
        firstUserMessage.text,
        temporaryAttachmentTitles(firstUserMessage)
      )
    ) {
      return;
    }

    const modelSelection = getModelSelectionForConversationTitles(this.options.config);
    const binding = modelBindingRefOf(modelSelection);

    try {
      const completion = await this.options.modelGateway.complete({
        binding,
        messages: createTitlePrompt(firstUserMessage),
        tools: [],
        reasoningEffort: reasoningEffortTheModelTakes(
          this.options.modelGateway,
          binding,
          modelSelection.reasoningEffort
        ),
        attribution: {
          kind: "system",
          purpose: "conversation_title",
          conversationId,
          userId: input.userId,
          workspaceId: conversation.collaborationWorkspaceId
        },
        clientInstanceId: this.options.clientInstanceId,
        correlationId: input.correlationId,
        signal: control.signal,
        deadline: new Date(Date.now() + CONVERSATION_TITLE_TIMEOUT_MS)
      });
      const title = normalizeGeneratedConversationTitle(completion.text);
      if (!isUsableGeneratedTitle(title) || title === conversation.title) {
        return;
      }

      // One statement decides: a title the user wrote since the job read the conversation
      // is not the expected one and stays.
      const updated = await control.transaction((stores) =>
        stores.conversations.replaceConversationTitle({
          clientInstanceId: this.options.clientInstanceId,
          conversationId,
          expectedTitle: conversation.title,
          title,
          updatedAt: new Date().toISOString()
        })
      );
      if (!updated) {
        return;
      }
      await this.options.auditRecorder.record({
        type: "conversation.title_generated",
        status: "success",
        actor: auditActorFromUser(user),
        subject: conversationId,
        correlationId: input.correlationId,
        metadata: {
          providerId: modelSelection.provider.id,
          model: modelSelection.model,
          previousTitleLength: conversation.title.length,
          generatedTitleLength: title.length
        }
      });
    } catch (error) {
      // An attempt that lost its lease was taken over; the attempt that holds it reports.
      if (error instanceof JobLeaseLostError) {
        throw error;
      }
      await this.options.auditRecorder.record({
        type: "conversation.title_generation_failed",
        status: "failed",
        actor: auditActorFromUser(user),
        subject: conversationId,
        correlationId: input.correlationId,
        metadata: {
          providerId: modelSelection.provider.id,
          model: modelSelection.model,
          ...toAuditErrorMetadata(error)
        }
      });
      throw error;
    }
  }

  private async findActiveUser(userId: UserId): Promise<AuthenticatedUser | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user || user.status !== "active") {
      return undefined;
    }
    const identity = user.identities[0];
    return {
      id: user.id,
      externalUserId: identity?.externalUserId ?? user.id,
      displayLabel: user.displayLabel,
      email: user.email,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      permissions: user.permissions,
      clientInstanceId: user.clientInstanceId,
      authSource: identity?.authSource ?? "job",
      subjectUserId: user.id
    };
  }

  async deleteConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation> {
    if (!this.options.config.retention.allowUserDelete) {
      throw new AppError(
        "FORBIDDEN",
        "User conversation deletion is disabled for this client instance"
      );
    }
    await this.requireConversationAccess(conversationId, user);
    const deletedAt = new Date().toISOString();
    const deleted = await this.options.stores.conversations.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt
    });
    // The Conversation is gone for the user from here on. A cleanup that fails is retried by
    // the retention job and does not fail the request.
    const cleanup = await attemptConversationDataCleanup(this.options, deleted.id, deletedAt);
    await this.options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: auditActorFromUser(user),
      subject: deleted.id,
      correlationId: context.correlationId,
      metadata: { ...cleanup }
    });
    return deleted;
  }

  /**
   * The single access check for a Conversation and everything that hangs off it. A missing
   * Conversation, one in a workspace the caller is not a member of, and another member's
   * private Conversation are indistinguishable to the caller.
   */
  async requireConversationAccess(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    const conversation = await this.options.stores.conversations.getConversation(
      this.options.clientInstanceId,
      conversationId
    );
    if (!conversation || conversation.status !== "active") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    try {
      await this.workspaces.requireWorkspaceAccess(user, conversation.collaborationWorkspaceId);
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", "Conversation is not available");
      }
      throw error;
    }
    if (
      conversation.visibility === "private" &&
      conversation.createdByUserId !== getSubjectUserId(user)
    ) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return conversation;
  }

  async resolveTargetWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined
  ): Promise<CollaborationWorkspace> {
    return collaborationWorkspaceId
      ? this.requireMemberWorkspace(user, collaborationWorkspaceId)
      : this.options.stores.workspaces.ensurePersonalWorkspace({
          clientInstanceId: this.options.clientInstanceId,
          userId: asUserId(getSubjectUserId(user))
        });
  }

  async requireMemberWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId
  ): Promise<CollaborationWorkspace> {
    await this.workspaces.requireWorkspaceAccess(user, collaborationWorkspaceId);
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return workspace;
  }
}

function toAuditErrorMetadata(error: unknown): JsonObject {
  return { errorCode: isAppError(error) ? error.code : "INTERNAL" };
}
