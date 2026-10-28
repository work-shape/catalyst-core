import type { AuditRecorder, StorePage } from "@work-shape/catalyst-core";
import { auditActorFromUser, dataStoreConversationPrivateError } from "@work-shape/catalyst-core";
import {
  AppError,
  personalConversationPrivateError,
  JobLeaseLostError,
  type ActorAccess,
  type AuthenticatedUser,
  type Conversation,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type ConversationListItem,
  type ConversationId,
  type ConversationCreationTarget,
  type ConversationSubject,
  type ConversationVisibility,
  type JobControl,
  type JsonObject,
  type LocaleCode,
  type RuntimeCallContext,
  type UserId,
  addDays,
  asAgentRunId,
  asUserId,
  DATA_STORE_USE_TOOL_NAME,
  getSubjectUserId,
  isAppError,
  readToolResultMetadata
} from "@work-shape/catalyst-core";
import { PLATFORM_ASSET_TOOLS } from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import { getModelSelectionForConversationTitles } from "@work-shape/catalyst-config-schema";
import { CollaborationWorkspaceWorkflow } from "../workspaces/collaboration-workspace-service";
import { requireWorkspaceToWorkIn } from "../workspaces/workspace-access";
import { attemptConversationDataCleanup } from "../deletion/conversation-cleanup";
import { requireChatConversationAccess, requireConversationAccess } from "./conversation-access";
import { assertConversationIdle } from "./conversation-idle";
import {
  createTitlePrompt,
  findFirstUserMessage,
  isTemporaryConversationTitle,
  isUsableGeneratedTitle,
  normalizeGeneratedConversationTitle,
  temporaryAttachmentTitles
} from "./conversation-title";
import { accessOf, requireOwnTranscript, requireReadableSubject } from "./platform-asset-subject";
import { useDataStoreInConversation } from "./conversation-data-stores";
import { checkoutApp, requireAppToCheckOut } from "../platform/asset-calls/app-edit";
import { modelBindingRefOf, reasoningEffortTheModelTakes } from "../guardrails/system-model-call";
import type { ChatServerOptions } from "../types";

/** The answer of an agent's open that waited for the person, as stored or wrapped. */
const waitingAnswerSchema = z.object({
  kind: z.string(),
  name: z.string(),
  awaitsPerson: z.literal(true)
});
const waitingOpenSchema = z.union([waitingAnswerSchema, z.object({ output: waitingAnswerSchema })]);

/** The answer of an agent's `data_store.use` that waits for the person's click (STORE-USE-1). */
const waitingUseAnswerSchema = z.object({ name: z.string(), awaitsPerson: z.literal(true) });
const waitingUseSchema = z.union([
  waitingUseAnswerSchema,
  z.object({ output: waitingUseAnswerSchema })
]);

export interface CreateConversationCommand {
  visibility?: "private";
  title?: string;
  collaborationWorkspaceId?: CollaborationWorkspaceId;
  /** The asset the conversation is about. Its creator holds the read right on it. */
  subject?: ConversationSubject;
  /**
   * `instance` where the conversation is started under Studio's scope "Instance": its first
   * saves create agents, skills and guardrails for the instance, where the person may. Set
   * here only, and never changed (studio-chat-entry.md, section 4a).
   */
  creationTarget?: ConversationCreationTarget;
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
    const { member } = await requireWorkspaceToWorkIn(this.options, user, collaborationWorkspaceId);
    return this.options.stores.conversations.listConversationsWithActiveRun({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId,
      scope: { kind: member ? "viewer" : "author", userId: getSubjectUserId(user) },
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
    const { workspace, member } = await this.workspaceToWorkIn(
      user,
      command.collaborationWorkspaceId
    );
    if (command.subject) {
      await requireReadableSubject(this.options, user, command.subject);
    }
    const conversation = await this.options.stores.conversations.createConversation({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: subjectUserId,
      createdByExternalUserId: user.externalUserId,
      // The transcript of a conversation about an asset holds the asset's definition, and a
      // member of the workspace need not hold the read right on it: it is its creator's alone,
      // as every conversation of a holder of a bundle who is no member is.
      visibility:
        (command.subject || command.visibility === "private" || !member) &&
        workspace.kind !== "personal"
          ? "private"
          : workspace.defaultConversationVisibility,
      title: command.title ?? "New conversation",
      retainedUntil: addDays(
        new Date(),
        this.options.config.retention.conversationDays
      ).toISOString(),
      ...(command.subject ? { subject: command.subject } : {}),
      ...(command.creationTarget ? { creationTarget: command.creationTarget } : {})
    });

    await this.options.auditRecorder.record({
      type: "conversation.created",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversation.id,
      correlationId: context.correlationId,
      metadata: {
        retainedUntil: conversation.retainedUntil,
        ...(conversation.subject
          ? { subjectKind: conversation.subject.kind, subjectName: conversation.subject.name }
          : {}),
        ...(conversation.creationTarget ? { creationTarget: conversation.creationTarget } : {})
      }
    });
    return conversation;
  }

  /**
   * "Edit in chat" on an App's page: a new conversation of the person's own about the App,
   * holding the App's current draft in `apps/<name>` as the agent's `app.edit` loads it. The
   * right to change the App is checked before anything is made; where the files then cannot be
   * loaded, the empty conversation is discarded again.
   */
  async createAppCheckout(
    user: AuthenticatedUser,
    access: Pick<ActorAccess, "require">,
    context: RuntimeCallContext,
    command: CreateConversationCommand
  ): Promise<Conversation> {
    const { subject } = command;
    if (subject?.kind !== "app") {
      throw new AppError("VALIDATION_FAILED", "A checkout names an App as the subject");
    }
    const { workspace } = await this.workspaceToWorkIn(user, command.collaborationWorkspaceId);
    await requireAppToCheckOut(this.options, access, {
      name: subject.name,
      workspaceId: workspace.id
    });
    const conversation = await this.createConversation(user, context, {
      ...command,
      collaborationWorkspaceId: workspace.id,
      visibility: "private"
    });
    try {
      await checkoutApp(this.options, this.options.workspaceObjects, {
        conversation,
        access,
        context,
        name: subject.name
      });
    } catch (error) {
      await this.deleteConversation(conversation.id, user, context, true).catch(() => undefined);
      throw error;
    }
    return conversation;
  }

  async renameConversation(
    conversationId: ConversationId,
    title: string,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation> {
    const conversation = await this.requireChatConversationAccess(conversationId, user);
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

  /**
   * The person makes an asset what their own conversation is about: the person's step that an
   * asset of the instance needs, such as going to the page of an asset the agent opened. The
   * conversation is the person's, in a transcript nobody else reads, and the asset one they may
   * read; another person's conversation and an asset they may not read are refused as missing.
   */
  async openSubject(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: { correlationId: string; audit: AuditRecorder },
    command: ConversationSubject & { toolCallId?: string }
  ): Promise<Conversation> {
    const conversation = await this.requireChatConversationAccess(conversationId, user);
    if (conversation.createdByUserId !== getSubjectUserId(user)) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const subject = { kind: command.kind, name: command.name };
    await requireReadableSubject(this.options, user, subject);
    await requireOwnTranscript(this.options, conversation);
    if (command.toolCallId !== undefined) {
      await this.requirePendingOpen(conversationId, command.toolCallId, subject);
      // A confirmation sent again, by a second tab or a retry, changes nothing: the
      // conversation is about that asset already, and the audit holds the one step.
      const current = conversation.subject;
      if (current?.kind === subject.kind && current.name === subject.name) return conversation;
    }
    const updated = await this.options.stores.conversations.setConversationSubject({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      subject
    });
    // Deleted meanwhile.
    if (!updated) throw new AppError("NOT_FOUND", "Conversation is not available");
    await context.audit.record({
      type: "conversation.subject_opened",
      status: "success",
      actor: auditActorFromUser(user),
      subject: conversationId,
      correlationId: context.correlationId,
      metadata: {
        subjectKind: subject.kind,
        subjectName: subject.name,
        ...(command.toolCallId === undefined ? {} : { confirmsToolCallId: command.toolCallId })
      }
    });
    return updated;
  }

  /**
   * The person's click on the card of an agent's `data_store.use` (STORE-USE-1): adds the
   * store to their conversation for reading. Only the person whose turn the card came from,
   * in their own session, and only for a call of this conversation that waited for them. The
   * store's own checks (read right, publication, owner reach) are asked again here.
   */
  async addDataStore(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: { correlationId: string; audit: AuditRecorder; locale?: LocaleCode },
    command: { store: string; toolCallId: string }
  ) {
    const conversation = await this.requireChatConversationAccess(conversationId, user);
    // A key or a delegated actor is no click of the person's own (as for personal Connections).
    if (user.keyScopes !== undefined || user.delegatedActor !== undefined) {
      throw new AppError(
        "FORBIDDEN",
        "Only the person adds a Data Store to their conversation, in their own session",
        { reason: "data_store_use_not_persons_turn" },
        { exposeMessage: true }
      );
    }
    await this.requirePendingUse(conversationId, command.toolCallId, command.store, user);
    return useDataStoreInConversation(this.options, {
      conversation,
      actor: user,
      access: await accessOf(this.options, user),
      name: command.store,
      confirmed: true,
      context,
      audit: context.audit,
      toolCallId: command.toolCallId
    });
  }

  /**
   * Refuses a click that names no `data_store.use` of this store in this conversation that
   * waited for the person, or one of another person's turn, a subagent's or a Workflow step's.
   * Every refusal reads the same, so it tells nothing of another person's calls.
   */
  private async requirePendingUse(
    conversationId: ConversationId,
    toolCallId: string,
    store: string,
    user: AuthenticatedUser
  ): Promise<void> {
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const runIds = messages.flatMap((message) => {
      const result = readToolResultMetadata(message.metadata);
      if (result?.toolCallId !== toolCallId || result.toolName !== DATA_STORE_USE_TOOL_NAME)
        return [];
      const answer = waitingUseSchema.safeParse(result.result);
      if (!answer.success) return [];
      const used = "output" in answer.data ? answer.data.output : answer.data;
      return used.name === store ? [result.runId] : [];
    });
    const runId = runIds[0];
    const run =
      runId === undefined
        ? undefined
        : await this.options.stores.agentRuns.getAgentRun({
            clientInstanceId: this.options.clientInstanceId,
            runId: asAgentRunId(runId)
          });
    if (
      run?.conversationId !== conversationId ||
      run.ownerUserId !== getSubjectUserId(user) ||
      run.parentRunId !== undefined ||
      run.workflowStepRunId !== undefined
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The confirmation names no use of this Data Store that waits for you in this conversation",
        { reason: "data_store_use_not_pending" },
        { exposeMessage: true }
      );
    }
  }

  /**
   * Refuses a confirmation that names no open waiting for the person: the tool call must be an
   * open of this asset in this conversation whose answer waited for the person. The audit row
   * names only a call the agent made.
   */
  private async requirePendingOpen(
    conversationId: ConversationId,
    toolCallId: string,
    subject: ConversationSubject
  ): Promise<void> {
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId
    });
    const pending = messages.some((message) => {
      const result = readToolResultMetadata(message.metadata);
      if (result?.toolCallId !== toolCallId || result.toolName !== PLATFORM_ASSET_TOOLS.open.name) {
        return false;
      }
      const answer = waitingOpenSchema.safeParse(result.result);
      if (!answer.success) return false;
      const opened = "output" in answer.data ? answer.data.output : answer.data;
      return opened.kind === subject.kind && opened.name === subject.name;
    });
    if (!pending) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The confirmation names no open of this asset that waits for the person in this conversation",
        { reason: "open_not_pending" },
        { exposeMessage: true }
      );
    }
  }

  async moveConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: MoveConversationCommand
  ): Promise<Conversation> {
    const conversation = await this.requireChatConversationAccess(conversationId, user);
    if (
      await this.options.stores.agentTryConversations.get({
        clientInstanceId: this.options.clientInstanceId,
        conversationId
      })
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "A preview conversation stays with its agent",
        { reason: "preview_conversation_private" },
        { exposeMessage: true }
      );
    }
    const destination = await this.requireMemberWorkspace(user, command.collaborationWorkspaceId);
    if (
      conversation.personalDataAt &&
      destination.kind !== "personal" &&
      command.visibility === "workspace"
    )
      throw personalConversationPrivateError();
    if (conversation.collaborationWorkspaceId === command.collaborationWorkspaceId) {
      throw new AppError("VALIDATION_FAILED", "Conversation already belongs to this workspace");
    }
    // A conversation that reads a Data Store a person added stays private, as one about an
    // asset does: its transcript holds the answers from the store (STORE-USE-1).
    const readsStores =
      (
        await this.options.stores.conversations.listConversationDataStores({
          clientInstanceId: this.options.clientInstanceId,
          conversationId
        })
      ).length > 0;
    if (readsStores && destination.kind !== "personal" && command.visibility === "workspace") {
      throw dataStoreConversationPrivateError();
    }
    if (
      conversation.subject &&
      destination.kind !== "personal" &&
      command.visibility === "workspace"
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "A conversation about an asset stays private: its transcript holds the asset's definition",
        { reason: "subject_conversation_private" },
        { exposeMessage: true }
      );
    }
    const visibility: ConversationVisibility =
      destination.kind === "personal"
        ? "workspace"
        : (command.visibility ??
          (conversation.visibility === "private" ||
          conversation.subject ||
          readsStores ||
          conversation.personalDataAt
            ? "private"
            : destination.defaultConversationVisibility));
    if (
      conversation.personalDataAt &&
      destination.kind !== "personal" &&
      visibility !== "private"
    ) {
      throw personalConversationPrivateError();
    }
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
    // The audit names the binding where one is configured: a provider's model id can hold a
    // cloud account id, which belongs in the usage ledger alone.
    const modelName: Record<string, string> = modelSelection.binding
      ? { modelBindingId: modelSelection.binding.id }
      : { model: modelSelection.model };

    try {
      const completion = await this.options.modelGateway.complete({
        binding,
        messages: createTitlePrompt(
          firstUserMessage,
          user.locale ?? this.options.config.localization.defaultLocale
        ),
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
          ...modelName,
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
          ...modelName,
          ...toAuditErrorMetadata(error)
        }
      });
      throw error;
    }
  }

  private async findActiveUser(
    userId: UserId
  ): Promise<(AuthenticatedUser & { locale: LocaleCode | undefined }) | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user || user.status !== "active") {
      return undefined;
    }
    const identity = user.identities[0];
    return {
      // The language the account chose, which a job writes the person's text in.
      locale: user.locale,
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
    context: RuntimeCallContext,
    discardEmpty = false
  ): Promise<Conversation> {
    if (!discardEmpty && !this.options.config.retention.allowUserDelete) {
      throw new AppError(
        "FORBIDDEN",
        "User conversation deletion is disabled for this client instance"
      );
    }
    await this.requireChatConversationAccess(conversationId, user);
    const deletedAt = new Date().toISOString();
    const deleted = await this.options.stores.conversations.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt,
      ...(discardEmpty ? { discardEmptyByUserId: asUserId(getSubjectUserId(user)) } : {})
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
   * The single access check for a Conversation and everything that hangs off it:
   * `requireConversationAccess`. A missing Conversation, one in a workspace the caller is not a
   * member of, and another member's private Conversation are indistinguishable to the caller.
   */
  requireConversationAccess(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    return requireConversationAccess(this.options, conversationId, user);
  }

  /** The same check for a write only a chat Conversation takes; a run thread is read only. */
  requireChatConversationAccess(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    return requireChatConversationAccess(this.options, conversationId, user);
  }

  async resolveTargetWorkspace(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined
  ): Promise<CollaborationWorkspace> {
    return (await this.workspaceToWorkIn(user, collaborationWorkspaceId)).workspace;
  }

  /**
   * The workspace a conversation of the user is started or continued in: the named one, as
   * `requireWorkspaceToWorkIn` lets the user work there, or the user's Personal Workspace.
   */
  async workspaceToWorkIn(
    user: AuthenticatedUser,
    collaborationWorkspaceId: CollaborationWorkspaceId | undefined
  ): Promise<{ workspace: CollaborationWorkspace; member: boolean }> {
    if (!collaborationWorkspaceId) {
      const workspace = await this.options.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId: this.options.clientInstanceId,
        userId: asUserId(getSubjectUserId(user))
      });
      return { workspace, member: true };
    }
    const { member } = await requireWorkspaceToWorkIn(this.options, user, collaborationWorkspaceId);
    const workspace = await this.options.stores.workspaces.getWorkspace(
      this.options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (!workspace) {
      throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    }
    return { workspace, member };
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
