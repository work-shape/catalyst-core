import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { FastifyInstance } from "fastify";
import {
  chatStreamChunkSchema,
  chatStreamRequestSchema,
  type ChatStreamChunk,
  type ChatStreamRequest
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  type AgentRunId,
  type AgentRuntimeEvent,
  type ChatMessage,
  asConversationId
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { createConversationTitle } from "../conversation-title";
import { authenticateRequest, parseBody, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";
import { sendWebResponse } from "./better-auth-routes";

export function registerChatStreamRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.post("/api/chat", async (request, reply) => {
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
    const responseMessageId = runId;
    const stream = createUIMessageStream<UIMessage>({
      execute: async ({ writer }) => {
        let textPartId: string | undefined;
        let textPartIndex = 0;
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
          if (event.type === "message_delta") {
            const activeTextPartId = ensureTextPart();
            writeChunk({
              type: "text-delta",
              id: activeTextPartId,
              delta: event.delta
            });
          }

          if (event.type === "tool_call_started") {
            closeTextPart();
            writeChunk({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: {},
              dynamic: true,
              title: event.toolName
            });
          }

          if (event.type === "tool_permission_requested") {
            closeTextPart();
            writeChunk({
              type: "tool-approval-request",
              approvalId: `${event.toolCallId}:approval`,
              toolCallId: event.toolCallId
            });
          }

          if (event.type === "tool_call_completed") {
            closeTextPart();
            writeChunk({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: toToolUiOutput(event),
              dynamic: true
            });
          }

          if (event.type === "tool_call_failed") {
            closeTextPart();
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
            await conversations.recordRunFailed(
              conversationId,
              user,
              localizedContext,
              runId,
              assistantMessageCount,
              event
            );
            writeChunk({
              type: "error",
              errorText: event.error.message
            });
            return;
          }

          if (event.type === "run_completed") {
            await conversations.recordRunCompleted(
              conversationId,
              user,
              localizedContext,
              runId,
              assistantMessageCount
            );
            void conversations
              .generateTitleForFirstExchange(conversationId, user, localizedContext)
              .catch((error: unknown) => {
                request.log.warn(
                  { err: error, conversationId, runId },
                  "Conversation title generation failed after chat stream completion"
                );
              });
          }
        }

        closeTextPart();
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
        return error instanceof Error ? error.message : "Message failed";
      }
    });

    return sendWebResponse(
      reply,
      createUIMessageStreamResponse({
        stream,
        headers: {
          "cache-control": "no-store"
        }
      })
    );
  });
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
