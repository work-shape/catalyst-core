import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  apiOperations,
  chatStreamChunkSchema,
  chatStreamRoutePath,
  chatStreamRequestSchema,
  type ChatStreamChunk,
  type ChatStreamRequest
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  type AgentRunId,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationId,
  type RuntimeCallContext,
  asAgentRunId,
  asConversationId,
  isAppError
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
    const conversationId = getConversationId(request);
    return (
      (await generateTitleForConversationOnce(conversationId, user, context)) ??
      (await readCurrentConversation(conversationId, user))
    );
  });

  app.post(chatStreamRoutePath, async (request, reply) => {
    const { user, context } = await authenticateRequest(options, request);
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
      ownerUserId: user.id
    });
    void generateTitleForConversationOnce(conversationId, user, localizedContext).catch((error: unknown) => {
      request.log.warn(
        { err: error, conversationId, runId },
        "Conversation title generation failed after first user message"
      );
    });

    return createRunStreamResponse({
      conversationId,
      conversations,
      localizedContext,
      recordLifecycle: true,
      reply,
      runId,
      streamId: runId,
      user
    });
  });

  app.get("/api/chat/runs/:runId/stream", async (request, reply) => {
    const { user, context } = await authenticateRequest(options, request);
    const params = request.params as { runId?: string };
    const runId = asAgentRunId(params.runId ?? "");
    const resumableRun = resumableRuns.readForUser(runId, user.id);
    if (!resumableRun) {
      return reply.status(204).send();
    }
    const runStatus = await conversations.getRunStatus(runId, context).catch(() => undefined);
    if (!isObservableRunStatus(runStatus)) {
      resumableRuns.forget(runId);
      return reply.status(204).send();
    }

    return createRunStreamResponse({
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

  function createRunStreamResponse({
    conversationId,
    conversations,
    localizedContext,
    recordLifecycle,
    reply,
    runId,
    streamId,
    user
  }: {
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

        for await (const event of conversations.observeRun(runId, localizedContext)) {
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
  return status === "running" || status === "waiting_for_permission";
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
