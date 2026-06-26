import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  apiOperations,
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  chatStreamChunkSchema,
  chatStreamRoutePath,
  chatStreamRequestSchema,
  createConversationRunRequestSchema,
  runObservationSchema,
  runCommandRequestSchema,
  runCommandResponseSchema,
  startConversationRunRequestSchema,
  startConversationRunResponseSchema,
  type ChatStreamChunk,
  type ChatStreamRequest
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationId,
  type RuntimeCallContext,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  getSubjectUserId,
  isAppError,
  requireAuthScope
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { createConversationTitle } from "../conversation-title";
import { authenticateRequest, getConversationId, parseBody, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";
import { sendWebResponse } from "./better-auth-routes";
import { RESUMABLE_STREAM_ID_HEADER } from "./chat-stream-headers";
import { ResumableRunRegistry } from "./resumable-run-registry";

export function registerChatStreamRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);
  const titleGenerationTasks = new Map<string, Promise<Conversation | undefined>>();
  const lifecycleMonitorTasks = new Set<AgentRunId>();
  const resumableRuns = new ResumableRunRegistry();

  function generateTitleForConversationOnce(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<Conversation | undefined> {
    const key = `${options.clientInstanceId}:${user.id}:${conversationId}`;
    const existingTask = titleGenerationTasks.get(key);
    if (existingTask) {
      return existingTask;
    }

    const task = conversations.generateTitleForConversation(conversationId, user, context).finally(() => {
      titleGenerationTasks.delete(key);
    });
    titleGenerationTasks.set(key, task);
    return task;
  }

  async function readCurrentConversation(conversationId: ConversationId, user: AuthenticatedUser): Promise<Conversation> {
    const conversation = (await conversations.listConversations(user)).find((candidate) => candidate.id === conversationId);
    if (!conversation) {
      throw new AppError("NOT_FOUND", "Conversation not found");
    }
    return conversation;
  }

  app.post(apiOperations.generateConversationTitle.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const conversationId = getConversationId(request);
    return (
      (await generateTitleForConversationOnce(conversationId, user, context)) ??
      (await readCurrentConversation(conversationId, user))
    );
  });

  app.post(chatStreamRoutePath, async (request, reply) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    requireAuthScope(user, "run:start");
    const body = parseBody(chatStreamRequestSchema, request.body);
    const localizedContext = withRequestLocale(context, options, request, body.locale);
    const text = extractSubmittedUserText(body.messages);
    const conversation =
      body.conversationId === undefined
        ? await conversations.createConversation(user, localizedContext, {
            title: createConversationTitle(text)
          })
        : undefined;
    const conversationId = asConversationId(body.conversationId ?? conversation?.id ?? "");
    if (!conversationId) {
      throw new AppError("BAD_REQUEST", "Missing conversation id");
    }

    const { runId } = await conversations.startMessageRun(conversationId, user, localizedContext, {
      agentName: body.agentName,
      text
    });
    resumableRuns.remember(runId, {
      conversationId,
      ownerUserId: getSubjectUserId(user)
    });
    void generateTitleForConversationOnce(conversationId, user, localizedContext).catch((error: unknown) => {
      request.log.warn(
        { err: error, conversationId, runId },
        "Conversation title generation failed after first user message"
      );
    });
    monitorRunLifecycleOnce({
      conversationId,
      context: localizedContext,
      runId,
      user
    });

    return createRunStreamResponse({
      afterSequence: 0,
      conversationId,
      conversations,
      localizedContext,
      recordLifecycle: false,
      reply,
      runId,
      streamId: runId,
      user
    });
  });

  app.get("/api/chat/runs/:runId/stream", async (request, reply) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "run:observe");
    const params = request.params as { runId?: string };
    const runId = asAgentRunId(params.runId ?? "");
    const afterSequence = readAfterSequence(request);
    const persistedRun = await conversations.getRunForUser(runId, user);
    if (persistedRun) {
      if (!isObservableRunStatus(persistedRun.status) && afterSequence >= persistedRun.lastSequence) {
        resumableRuns.forget(runId);
        return reply.status(204).send();
      }
      return createRunStreamResponse({
        afterSequence,
        conversationId: persistedRun.conversationId,
        conversations,
        localizedContext: withRequestLocale(context, options, request, undefined),
        recordLifecycle: false,
        reply,
        runId,
        streamId: runId,
        user
      });
    }

    const resumableRun = resumableRuns.readForUser(runId, getSubjectUserId(user));
    if (!resumableRun) {
      return reply.status(204).send();
    }
    const runStatus = await conversations.getRunStatus(runId, context).catch(() => undefined);
    if (!isObservableRunStatus(runStatus)) {
      resumableRuns.forget(runId);
      return reply.status(204).send();
    }

    return createRunStreamResponse({
      afterSequence,
      conversationId: resumableRun.conversationId,
      conversations,
      localizedContext: withRequestLocale(context, options, request, undefined),
      recordLifecycle: false,
      reply,
      runId,
      streamId: runId,
      user
    });
  });

  async function cancelRun(request: FastifyRequest) {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "run:cancel");
    const params = request.params as { conversationId?: string; runId?: string };
    const conversationId = asConversationId(params.conversationId ?? "");
    const runId = asAgentRunId(params.runId ?? "");
    const body = parseBody(cancelRunRequestSchema, request.body ?? {});
    const run = await conversations.cancelRun(
      conversationId,
      runId,
      user,
      withRequestLocale(context, options, request, undefined),
      body.reason
    );
    return cancelRunResponseSchema.parse({ run });
  }

  app.post(apiOperations.cancelConversationRun.path, cancelRun);

  app.post("/api/chat/conversations/:conversationId/runs/:runId/cancel", cancelRun);

  app.post(apiOperations.startConversationRun.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    requireAuthScope(user, "run:start");
    const conversationId = getConversationId(request);
    const body = parseBody(startConversationRunRequestSchema, request.body);
    const localizedContext = withRequestLocale(context, options, request, body.locale);
    const started = await conversations.startMessageRun(conversationId, user, localizedContext, {
      agentName: body.agentName,
      idempotencyKey: body.idempotencyKey,
      text: body.message.text
    });
    void generateTitleForConversationOnce(conversationId, user, localizedContext).catch((error: unknown) => {
      request.log.warn(
        { err: error, conversationId, runId: started.runId },
        "Conversation title generation failed after public run start"
      );
    });
    if (isObservableRunStatus(started.run.status)) {
      monitorRunLifecycleOnce({
        conversationId,
        context: localizedContext,
        runId: started.runId,
        user
      });
    }
    return createStartRunResponse(
      request,
      await readCurrentConversation(conversationId, user),
      started.userMessage,
      started.run,
      user
    );
  });

  app.post(apiOperations.createConversationRun.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    requireAuthScope(user, "run:start");
    const body = parseBody(createConversationRunRequestSchema, request.body);
    const localizedContext = withRequestLocale(context, options, request, body.locale);
    const started = await conversations.createConversationAndStartMessageRun(
      user,
      localizedContext,
      {
        agentName: body.agentName,
        idempotencyKey: body.idempotencyKey,
        text: body.message.text,
        title: body.conversation?.title
      }
    );
    void generateTitleForConversationOnce(started.conversation.id, user, localizedContext).catch((error: unknown) => {
      request.log.warn(
        { err: error, conversationId: started.conversation.id, runId: started.runId },
        "Conversation title generation failed after public create-and-run"
      );
    });
    if (isObservableRunStatus(started.run.status)) {
      monitorRunLifecycleOnce({
        conversationId: started.conversation.id,
        context: localizedContext,
        runId: started.runId,
        user
      });
    }
    return createStartRunResponse(
      request,
      started.conversation,
      started.userMessage,
      started.run,
      user
    );
  });

  app.post(apiOperations.commandConversationRun.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "run:command");
    const params = request.params as { conversationId?: string; runId?: string };
    const conversationId = asConversationId(params.conversationId ?? "");
    const runId = asAgentRunId(params.runId ?? "");
    const body = parseBody(runCommandRequestSchema, request.body);
    const run = await conversations.commandRun(
      conversationId,
      runId,
      user,
      withRequestLocale(context, options, request, undefined),
      toRuntimeRunCommand(body.command)
    );
    return runCommandResponseSchema.parse({ run });
  });

  app.get(apiOperations.observeConversationRun.path, async (request, reply) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "run:observe");
    const params = request.params as { conversationId?: string; runId?: string };
    const conversationId = asConversationId(params.conversationId ?? "");
    const runId = asAgentRunId(params.runId ?? "");
    const afterSequence = readAfterSequence(request);
    const localizedContext = withRequestLocale(context, options, request, undefined);

    const run = await conversations.getConversationRunForUser(conversationId, runId, user);
    if (!run) {
      return reply.status(204).send();
    }
    if (!isObservableRunStatus(run.status) && afterSequence >= run.lastSequence) {
      return reply.status(204).send();
    }

    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    reply.header("cache-control", "no-store");
    reply.header("connection", "keep-alive");
    reply.header("content-type", "text/event-stream; charset=utf-8");
    return reply.send(
      Readable.from(
        (async function* streamRunObservations() {
          for await (const event of conversations.observeRun(runId, localizedContext, { afterSequence })) {
            if (closed) {
              return;
            }
            const observation = runObservationSchema.parse({
              clientInstanceId: options.clientInstanceId,
              runId,
              conversationId,
              ownerUserId: getSubjectUserId(user),
              sequence: event.sequence,
              type: event.type,
              payload: event,
              createdAt: event.createdAt
            });
            yield `id: ${observation.sequence}\nevent: ${observation.type}\ndata: ${JSON.stringify(observation)}\n\n`;
          }
        })()
      )
    );
  });

  function monitorRunLifecycleOnce(input: {
    conversationId: ConversationId;
    context: RuntimeCallContext;
    runId: AgentRunId;
    user: AuthenticatedUser;
  }): void {
    if (lifecycleMonitorTasks.has(input.runId)) {
      return;
    }
    lifecycleMonitorTasks.add(input.runId);
    void (async () => {
      let assistantMessageCount = 0;
      for await (const event of conversations.observeRun(input.runId, input.context)) {
        if (event.type === "message_completed") {
          assistantMessageCount += 1;
        }
        if (event.type === "run_failed") {
          resumableRuns.forget(input.runId);
          await conversations.recordRunFailed(
            input.conversationId,
            input.user,
            input.context,
            input.runId,
            assistantMessageCount,
            event
          );
          lifecycleMonitorTasks.delete(input.runId);
          return;
        }
        if (event.type === "run_cancelled") {
          resumableRuns.forget(input.runId);
          await conversations.recordRunCancelled(
            input.conversationId,
            input.user,
            input.context,
            input.runId,
            assistantMessageCount,
            event
          );
          lifecycleMonitorTasks.delete(input.runId);
          return;
        }
        if (event.type === "run_completed") {
          resumableRuns.forget(input.runId);
          await conversations.recordRunCompleted(
            input.conversationId,
            input.user,
            input.context,
            input.runId,
            assistantMessageCount
          );
          lifecycleMonitorTasks.delete(input.runId);
          return;
        }
      }
      lifecycleMonitorTasks.delete(input.runId);
    })().catch((error: unknown) => {
      lifecycleMonitorTasks.delete(input.runId);
      app.log.warn({ err: error, conversationId: input.conversationId, runId: input.runId }, "Agent run lifecycle monitor failed");
    });
  }

  async function createStartRunResponse(
    request: FastifyRequest,
    conversation: Conversation,
    userMessage: ChatMessage,
    run: AgentRun,
    user: AuthenticatedUser
  ) {
    const eventsUrl = apiOperations.observeConversationRun.buildPath({
      params: {
        conversationId: conversation.id,
        runId: run.id
      }
    });
    const requestHost = request.headers.host ?? request.hostname;
    return startConversationRunResponseSchema.parse({
      conversation,
      userMessage,
      run,
      thread: await conversations.getThreadSnapshot(conversation.id, user),
      eventsUrl: new URL(eventsUrl, `${request.protocol}://${requestHost}`).toString()
    });
  }

  function createRunStreamResponse({
    afterSequence,
    conversationId,
    conversations,
    localizedContext,
    recordLifecycle,
    reply,
    runId,
    streamId,
    user
  }: {
    afterSequence: number;
    conversationId: ConversationId;
    conversations: ConversationWorkflow;
    localizedContext: RuntimeCallContext;
    recordLifecycle: boolean;
    reply: FastifyReply;
    runId: AgentRunId;
    streamId: string;
    user: AuthenticatedUser;
  }) {
    const responseMessageId = runId;
    const stream = createUIMessageStream<UIMessage>({
      execute: async ({ writer }) => {
        let textPartId: string | undefined;
        let textPartIndex = 0;
        const activeReasoningPartIds = new Set<string>();
        let assistantMessageCount = 0;

        function writeChunk(chunk: ChatStreamChunk): void {
          writer.write(chatStreamChunkSchema.parse(chunk) as Parameters<typeof writer.write>[0]);
        }

        function ensureTextPart(): string {
          if (!textPartId) {
            textPartId = `${responseMessageId}:text:${textPartIndex}`;
            textPartIndex += 1;
            writeChunk({
              type: "text-start",
              id: textPartId
            });
          }
          return textPartId;
        }

        function closeTextPart(): void {
          if (!textPartId) {
            return;
          }
          writeChunk({
            type: "text-end",
            id: textPartId
          });
          textPartId = undefined;
        }

        function ensureReasoningPart(id: string): void {
          if (activeReasoningPartIds.has(id)) {
            return;
          }
          activeReasoningPartIds.add(id);
          writeChunk({
            type: "reasoning-start",
            id
          });
        }

        function closeReasoningParts(): void {
          for (const id of activeReasoningPartIds) {
            writeChunk({
              type: "reasoning-end",
              id
            });
          }
          activeReasoningPartIds.clear();
        }

        writeChunk({
          type: "start",
          messageId: responseMessageId,
          messageMetadata: {
            conversationId,
            runId
          }
        });
        writeChunk({
          type: "start-step"
        });

        for await (const event of conversations.observeRun(runId, localizedContext, { afterSequence })) {
          if (event.type === "reasoning_delta") {
            closeTextPart();
            ensureReasoningPart(event.id);
            writeChunk({
              type: "reasoning-delta",
              id: event.id,
              delta: event.delta
            });
          }

          if (event.type === "message_delta") {
            closeReasoningParts();
            const activeTextPartId = ensureTextPart();
            writeChunk({
              type: "text-delta",
              id: activeTextPartId,
              delta: event.delta
            });
          }

          if (event.type === "tool_call_started") {
            closeTextPart();
            closeReasoningParts();
            writeChunk({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              dynamic: true,
              title: event.toolName
            });
          }

          if (event.type === "tool_permission_requested") {
            closeTextPart();
            closeReasoningParts();
            writeChunk({
              type: "tool-approval-request",
              approvalId: `${event.toolCallId}:approval`,
              toolCallId: event.toolCallId
            });
          }

          if (event.type === "tool_call_completed") {
            closeTextPart();
            closeReasoningParts();
            writeChunk({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: toToolUiOutput(event),
              dynamic: true
            });
          }

          if (event.type === "tool_call_failed") {
            closeTextPart();
            closeReasoningParts();
            writeChunk({
              type: "tool-output-error",
              toolCallId: event.toolCallId,
              errorText: toToolUiError(event),
              dynamic: true
            });
          }

          if (event.type === "message_completed") {
            const assistantMessage = await conversations.persistAssistantMessage(conversationId, event);
            assistantMessageCount += 1;
            writeChunk({
              type: "message-metadata",
              messageMetadata: toAssistantMessageMetadata(conversationId, runId, assistantMessage)
            });
          }

          if (event.type === "run_failed") {
            closeTextPart();
            closeReasoningParts();
            resumableRuns.forget(runId);
            if (recordLifecycle) {
              await conversations.recordRunFailed(
                conversationId,
                user,
                localizedContext,
                runId,
                assistantMessageCount,
                event
              );
            }
            writeChunk({
              type: "error",
              errorText: event.error.message
            });
            return;
          }

          if (event.type === "run_cancelled") {
            closeTextPart();
            closeReasoningParts();
            resumableRuns.forget(runId);
            if (recordLifecycle) {
              await conversations.recordRunCancelled(
                conversationId,
                user,
                localizedContext,
                runId,
                assistantMessageCount,
                event
              );
            }
          }

          if (event.type === "run_completed") {
            resumableRuns.forget(runId);
            if (recordLifecycle) {
              await conversations.recordRunCompleted(
                conversationId,
                user,
                localizedContext,
                runId,
                assistantMessageCount
              );
            }
          }
        }

        closeTextPart();
        closeReasoningParts();
        writeChunk({
          type: "finish-step"
        });
        writeChunk({
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            conversationId,
            runId
          }
        });
      },
      onError(error) {
        return isAppError(error) && error.code !== "INTERNAL" ? error.message : "Message failed";
      }
    });

    return sendWebResponse(
      reply,
      createUIMessageStreamResponse({
        stream,
        headers: {
          "cache-control": "no-store",
          [RESUMABLE_STREAM_ID_HEADER]: streamId
        }
      })
    );
  }
}

function isObservableRunStatus(status: string | undefined): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

function readAfterSequence(request: {
  query: unknown;
  headers: Record<string, string | string[] | undefined>;
}): number {
  const queryAfter = (request.query as { after?: unknown }).after;
  const headerAfter = request.headers["last-event-id"];
  const rawValue =
    typeof queryAfter === "string"
      ? queryAfter
      : Array.isArray(headerAfter)
        ? headerAfter[0]
        : headerAfter;
  if (!rawValue) {
    return 0;
  }
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function extractSubmittedUserText(messages: ChatStreamRequest["messages"]): string {
  const userMessage = messages.findLast((message) => message.role === "user");
  const text =
    userMessage?.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? "";
  if (!text) {
    throw new AppError("VALIDATION_FAILED", "A user text message is required");
  }
  return text;
}

function toAssistantMessageMetadata(
  conversationId: string,
  runId: AgentRunId,
  message: ChatMessage
): Record<string, unknown> {
  return {
    conversationId,
    runId,
    persistedMessageId: message.id,
    createdAt: message.createdAt
  };
}

function toToolUiOutput(event: Extract<AgentRuntimeEvent, { type: "tool_call_completed" }>): Record<string, unknown> {
  if (event.result.status === "success") {
    return {
      status: "success",
      output: event.result.output,
      display: event.result.display,
      artifacts: event.result.artifacts,
      projectionNotice: event.projectionNotice
    };
  }

  return {
    status: "failed",
    error: event.result.error,
    projectionNotice: event.projectionNotice
  };
}

function toToolUiError(event: Extract<AgentRuntimeEvent, { type: "tool_call_failed" }>): string {
  if (event.result.status === "failed") {
    return event.result.error.message;
  }
  return "Tool call failed";
}

function toRuntimeRunCommand(command: {
  type: "continue";
} | {
  type: "tool_permission_decision";
  toolCallId: string;
  approved: boolean;
  reason?: string;
}) {
  if (command.type === "continue") {
    return command;
  }
  return {
    ...command,
    toolCallId: asToolCallId(command.toolCallId)
  };
}
