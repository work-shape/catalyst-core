import { auditActorFromUser } from "@vivd-catalyst/core";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type CollaborationWorkspace,
  type ConversationId,
  type ReasoningEffortConfig,
  type RuntimeCallContext,
  type RunStartCommand,
  type RunStartCommandKind,
  createUserMessageMetadata,
  createPlatformId,
  getAuthPrincipal,
  getAuthScopes,
  getSubjectUserId,
  defaultReasoningEffortForAgentBinding,
  isModelBindingUserSelectableForAgent,
  reasoningEffortChoiceForBinding
} from "@vivd-catalyst/core";
import { resolveModelBinding } from "@vivd-catalyst/config-schema";
import { getWorkspaceAssetSnapshot } from "../agent-availability";
import { createEmptyAttachmentManifest } from "../attachments";
import { createConversationTitle } from "../conversation-title";
import { generateConversationTitleJob } from "../job-kinds";
import type { ChatServerOptions } from "../types";
import { ConversationWorkflow, type CreateConversationCommand } from "./conversation-workflow";

export interface SendConversationMessageCommand {
  agentName?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  idempotencyKey?: string;
  text: string;
}

export interface StartedConversationMessageRun {
  userMessage: ChatMessage;
  run: AgentRun;
  runId: AgentRunId;
}

// How long a repeated run start waits for the first one with the same idempotency key, and how
// often it looks. A caller that waits longer gets 409 "Run start command is still pending".
const IDEMPOTENCY_WAIT_MS = 10_000;
const IDEMPOTENCY_WAIT_STEP_MS = 100;
const IDEMPOTENCY_PENDING_RECLAIM_MS = 5 * 60 * 1000;

export class RunStartWorkflow {
  private readonly options: ChatServerOptions;
  private readonly conversations: ConversationWorkflow;

  constructor(options: ChatServerOptions) {
    this.options = options;
    this.conversations = new ConversationWorkflow(options);
  }

  /**
   * An agent that is unknown and one that is not available in this workspace are
   * indistinguishable to the caller. A requested model must be one this agent offers to
   * users: its own binding or one of its user-selectable bindings. A requested reasoning
   * effort must be one the model that will run offers to users.
   */
  private async resolveRunAgentName(
    workspace: CollaborationWorkspace,
    requestedAgentName: string | undefined,
    requestedModelBindingId: string | undefined,
    requestedReasoningEffort: ReasoningEffortConfig | undefined
  ): Promise<string> {
    const assets = await getWorkspaceAssetSnapshot(this.options, workspace);
    const agentName = requestedAgentName ?? assets.defaultAgentName;
    if (!agentName) {
      throw new AppError(
        "VALIDATION_FAILED",
        "No default agent is configured for this client instance yet"
      );
    }
    const agent = assets.agents.find((candidate) => candidate.name === agentName);
    if (requestedAgentName !== undefined && !agent) {
      throw new AppError("NOT_FOUND", `Agent '${requestedAgentName}' is not defined`);
    }
    if (
      requestedModelBindingId &&
      !(
        agent &&
        isModelBindingUserSelectableForAgent(
          agent,
          this.options.config.modelBindings,
          requestedModelBindingId
        )
      )
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Model binding '${requestedModelBindingId}' is not available for user selection`
      );
    }
    if (requestedReasoningEffort) {
      const bindingId = requestedModelBindingId ?? agent?.modelBindingId;
      const binding = this.options.config.modelBindings.find(
        (candidate) => candidate.id === bindingId
      );
      const selection = binding && resolveModelBinding(this.options.config, binding.id);
      const offered = selection
        ? reasoningEffortChoiceForBinding(
            binding,
            this.options.modelGateway.capabilities({ bindingId: binding.id }).reasoningEfforts,
            (agent && defaultReasoningEffortForAgentBinding(agent, binding)) ??
              selection.reasoningEffort
          ).selectable
        : [];
      if (!offered.includes(requestedReasoningEffort)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Reasoning effort '${requestedReasoningEffort}' is not available for user selection`
        );
      }
    }
    return agentName;
  }

  async startMessageRun(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand
  ): Promise<StartedConversationMessageRun> {
    const conversation = await this.conversations.requireConversationAccess(conversationId, user);
    let runStartCommand: RunStartCommand | undefined;
    if (command.idempotencyKey) {
      const claim = await this.claimOrResolveRunStartCommand({
        commandKind: "start_conversation_run",
        conversationId,
        idempotencyKey: command.idempotencyKey,
        user
      });
      if (claim.status === "resolved") {
        return claim.started;
      }
      runStartCommand = claim.command;
    }

    try {
      const agentName = await this.resolveRunAgentName(
        await this.conversations.requireMemberWorkspace(
          user,
          conversation.collaborationWorkspaceId
        ),
        command.agentName,
        command.modelBindingId,
        command.reasoningEffort
      );
      const attachments = this.options.attachments;
      const draftAttachments = attachments
        ? await attachments.listDraftAttachments(conversationId)
        : [];
      const blockMessage = attachments?.blockingDraftAttachmentMessage(draftAttachments);
      if (blockMessage) {
        throw new AppError("CONFLICT", blockMessage);
      }
      const attachmentManifest =
        attachments?.createAttachmentManifest(draftAttachments) ?? createEmptyAttachmentManifest();
      const userMessageId = createPlatformId<"MessageId">("msg");
      const runId = createPlatformId<"AgentRunId">("run");
      const startedAt = new Date().toISOString();
      // The title job is enqueued in the transaction that writes the first user message, so
      // the message never exists without it and the job never without the message.
      const prepared = await this.options.stores.transaction(async (stores) => {
        const prepared = await stores.agentRuns.prepareConversationRunStart({
          clientInstanceId: this.options.clientInstanceId,
          conversationId,
          ownerUserId: getSubjectUserId(user),
          userMessage: {
            id: userMessageId,
            text: command.text,
            metadata: createUserMessageMetadata({ attachmentManifest })
          },
          run: {
            id: runId,
            clientInstanceId: this.options.clientInstanceId,
            conversationId,
            ownerUserId: getSubjectUserId(user),
            inputMessageId: userMessageId,
            agentName,
            modelBindingId: command.modelBindingId,
            reasoningEffort: command.reasoningEffort,
            locale: context.locale,
            authorization: {
              principal: context.principal ?? getAuthPrincipal(user),
              subjectUserId: context.subjectUserId ?? getSubjectUserId(user),
              delegatedActor: context.delegatedActor ?? user.delegatedActor,
              scopes: [...(context.scopes ?? getAuthScopes(user))]
            },
            status: "queued",
            idempotencyKey: command.idempotencyKey,
            correlationId: context.correlationId,
            startedAt
          },
          ...(command.idempotencyKey
            ? {
                runStartCommand: {
                  idempotencyKey: command.idempotencyKey,
                  commandKind: "start_conversation_run" as const,
                  claimedAt: runStartCommand?.updatedAt
                }
              }
            : {}),
          claimReadyDraftAttachments: attachmentManifest.attachments.length > 0,
          // Only a message a user sends counts as activity. Reading, renaming, moving and
          // background jobs never reach this call.
          ...(this.options.config.retention.extendOnActivity
            ? { extendRetentionDays: this.options.config.retention.conversationDays }
            : {})
        });
        if (prepared.firstUserMessage && this.options.config.conversationTitles.enabled) {
          await stores.jobs.enqueue(
            generateConversationTitleJob,
            { conversationId, userId: getSubjectUserId(user) },
            {
              clientInstanceId: this.options.clientInstanceId,
              subject: conversationId,
              dedupeKey: conversationId,
              concurrencyKey: conversationId,
              correlationId: context.correlationId
            }
          );
        }
        return prepared;
      });

      const run = await this.options.agentRuntime.start(
        {
          agentName: prepared.run.agentName,
          modelBindingId: prepared.run.modelBindingId,
          reasoningEffort: prepared.run.reasoningEffort,
          conversationId,
          idempotencyKey: command.idempotencyKey,
          inputMessageId: prepared.userMessage.id,
          preparedRun: {
            id: prepared.run.id,
            startedAt: prepared.run.startedAt
          },
          message: {
            text: command.text,
            attachmentManifest:
              attachmentManifest.attachments.length > 0 ? attachmentManifest : undefined
          }
        },
        context
      );
      if (run.runId !== prepared.run.id) {
        throw new AppError("INTERNAL", "Prepared agent run id was not started");
      }

      await this.options.auditRecorder.record({
        type: "message.created",
        status: "success",
        actor: auditActorFromUser(user),
        subject: prepared.userMessage.id,
        correlationId: context.correlationId,
        metadata: {
          conversationId,
          attachmentCount: attachmentManifest.attachments.length
        }
      });

      return {
        userMessage: prepared.userMessage,
        run: prepared.run,
        runId: prepared.run.id
      };
    } catch (error) {
      if (command.idempotencyKey) {
        await this.releaseRunStartCommand(
          command.idempotencyKey,
          "start_conversation_run",
          user,
          runStartCommand?.updatedAt
        );
      }
      throw error;
    }
  }

  async createConversationAndStartMessageRun(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: SendConversationMessageCommand & CreateConversationCommand
  ): Promise<{
    conversation: Conversation;
    userMessage: ChatMessage;
    run: AgentRun;
    runId: AgentRunId;
  }> {
    let runStartCommand: RunStartCommand | undefined;
    if (command.idempotencyKey) {
      const claim = await this.claimOrResolveRunStartCommand({
        commandKind: "create_conversation_run",
        idempotencyKey: command.idempotencyKey,
        user
      });
      if (claim.status === "resolved") {
        const conversation = await this.conversations.requireConversationAccess(
          claim.started.run.conversationId,
          user
        );
        return {
          conversation,
          ...claim.started
        };
      }
      runStartCommand = claim.command;
    }

    try {
      // Checked before the Conversation exists so a rejected agent or model leaves nothing behind.
      await this.resolveRunAgentName(
        await this.conversations.resolveTargetWorkspace(user, command.collaborationWorkspaceId),
        command.agentName,
        command.modelBindingId,
        command.reasoningEffort
      );
      const conversation = await this.conversations.createConversation(user, context, {
        title: command.title ?? createConversationTitle(command.text),
        collaborationWorkspaceId: command.collaborationWorkspaceId
      });
      const started = await this.startMessageRun(conversation.id, user, context, {
        ...command,
        idempotencyKey: undefined
      });
      if (command.idempotencyKey) {
        await this.options.stores.agentRuns.completeRunStartCommand({
          clientInstanceId: this.options.clientInstanceId,
          ownerUserId: getSubjectUserId(user),
          idempotencyKey: command.idempotencyKey,
          commandKind: "create_conversation_run",
          claimedAt: runStartCommand?.updatedAt,
          conversationId: conversation.id,
          userMessageId: started.userMessage.id,
          runId: started.runId,
          updatedAt: started.run.startedAt
        });
      }
      return {
        conversation,
        ...started
      };
    } catch (error) {
      if (command.idempotencyKey) {
        await this.releaseRunStartCommand(
          command.idempotencyKey,
          "create_conversation_run",
          user,
          runStartCommand?.updatedAt
        );
      }
      throw error;
    }
  }

  private async claimOrResolveRunStartCommand(input: {
    commandKind: RunStartCommandKind;
    conversationId?: ConversationId;
    idempotencyKey: string;
    user: AuthenticatedUser;
  }): Promise<
    | { status: "claimed"; command: RunStartCommand }
    | { status: "resolved"; started: StartedConversationMessageRun }
  > {
    const claimInput = {
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(input.user),
      idempotencyKey: input.idempotencyKey,
      commandKind: input.commandKind,
      reclaimPendingBefore: new Date(Date.now() - IDEMPOTENCY_PENDING_RECLAIM_MS).toISOString()
    };

    let claim = await this.options.stores.agentRuns.claimRunStartCommand(claimInput);
    if (claim.status === "claimed") {
      return { status: "claimed", command: claim.command };
    }

    for (let waitedMs = 0; waitedMs < IDEMPOTENCY_WAIT_MS; waitedMs += IDEMPOTENCY_WAIT_STEP_MS) {
      if (claim.command.status === "completed") {
        return {
          status: "resolved",
          started: await this.startedRunFromCommand(claim.command, input.user, input.conversationId)
        };
      }

      if (claim.command.status === "failed") {
        throw new AppError("CONFLICT", "Run start command previously failed");
      }

      await delay(IDEMPOTENCY_WAIT_STEP_MS);
      claim = await this.options.stores.agentRuns.claimRunStartCommand(claimInput);
      if (claim.status === "claimed") {
        return { status: "claimed", command: claim.command };
      }
    }

    throw new AppError("CONFLICT", "Run start command is still pending");
  }

  private async startedRunFromCommand(
    command: RunStartCommand,
    user: AuthenticatedUser,
    expectedConversationId?: ConversationId
  ): Promise<StartedConversationMessageRun> {
    if (!command.conversationId || !command.userMessageId || !command.runId) {
      throw new AppError("CONFLICT", "Run start command is still pending");
    }
    if (expectedConversationId && command.conversationId !== expectedConversationId) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    await this.conversations.requireConversationAccess(command.conversationId, user);
    const run = await this.options.stores.agentRuns.getConversationAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: command.conversationId,
      runId: command.runId
    });
    if (!run) {
      throw new AppError("NOT_FOUND", "Agent run is not available");
    }
    return {
      userMessage: await this.requireRunInputMessage(run),
      run,
      runId: run.id
    };
  }

  private async releaseRunStartCommand(
    idempotencyKey: string,
    commandKind: RunStartCommandKind,
    user: AuthenticatedUser,
    claimedAt: string | undefined
  ): Promise<void> {
    await this.options.stores.agentRuns.releaseRunStartCommand({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(user),
      idempotencyKey,
      commandKind,
      claimedAt
    });
  }

  private async requireRunInputMessage(run: AgentRun): Promise<ChatMessage> {
    const messages = await this.options.stores.conversations.listMessages({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: run.conversationId
    });
    const message = messages.find((candidate) => candidate.id === run.inputMessageId);
    if (!message) {
      throw new AppError("INTERNAL", "Agent run input message was not persisted");
    }
    return message;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
