import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  apiOperations,
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  createConversationRunRequestSchema,
  runObservationSchema,
  runCommandRequestSchema,
  runCommandResponseSchema,
  startConversationRunRequestSchema,
  startConversationRunResponseSchema
} from "@vivd-catalyst/api-contract";
import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationId,
  type RuntimeCallContext,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  getSubjectUserId,
  requireAuthScope
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId, parseBody, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerAgentRunRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);
  const titleGenerationTasks = new Map<string, Promise<Conversation | undefined>>();
  const lifecycleMonitorTasks = new Set<AgentRunId>();

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
