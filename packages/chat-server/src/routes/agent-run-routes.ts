import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  apiOperations,
  cancelRunResponseSchema,
  runObservationSchema,
  runCommandResponseSchema,
  startConversationRunResponseSchema
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
  asCollaborationWorkspaceId,
  asConversationId,
  asToolCallId,
  requireAuthScope
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, withRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerAgentRunRoutes(
  route: Route,
  options: ChatServerOptions,
  log: FastifyBaseLogger
): void {
  const conversations = new ConversationWorkflow(options);
  // The monitors of the runs started here, each until it has recorded how its run ended.
  const lifecycleMonitorTasks = new Map<AgentRunId, Promise<void>>();

  async function readCurrentConversation(
    conversationId: ConversationId,
    user: AuthenticatedUser
  ): Promise<Conversation> {
    return conversations.requireConversationAccess(conversationId, user);
  }

  route(
    apiOperations["conversations.runs.cancel"],
    async ({ user, context, params, body, request }) => {
      const conversationId = asConversationId(params.conversationId);
      const runId = asAgentRunId(params.runId);
      const run = await conversations.cancelRun(
        conversationId,
        runId,
        user,
        withRequestLocale(context, options, request, undefined),
        body.reason
      );
      return cancelRunResponseSchema.parse({ run });
    }
  );

  route(
    apiOperations["conversations.runs.start"],
    async ({ user, context, params, body, request }) => {
      // The descriptor carries one scope; starting a run needs this second one as well.
      requireAuthScope(user, "run:start");
      const conversationId = conversationIdParam(params);
      const localizedContext = withRequestLocale(context, options, request, body.locale);
      const started = await conversations.startMessageRun(conversationId, user, localizedContext, {
        agentName: body.agentName,
        modelBindingId: body.modelBindingId,
        reasoningEffort: body.reasoningEffort,
        idempotencyKey: body.idempotencyKey,
        text: body.message.text
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
    }
  );

  route(apiOperations["conversations.runs.create"], async ({ user, context, body, request }) => {
    // The descriptor carries one scope; starting a run needs this second one as well.
    requireAuthScope(user, "run:start");
    const localizedContext = withRequestLocale(context, options, request, body.locale);
    const started = await conversations.createConversationAndStartMessageRun(
      user,
      localizedContext,
      {
        agentName: body.agentName,
        modelBindingId: body.modelBindingId,
        reasoningEffort: body.reasoningEffort,
        idempotencyKey: body.idempotencyKey,
        text: body.message.text,
        title: body.conversation?.title,
        collaborationWorkspaceId: body.conversation?.collaborationWorkspaceId
          ? asCollaborationWorkspaceId(body.conversation.collaborationWorkspaceId)
          : undefined
      }
    );
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

  route(
    apiOperations["conversations.runs.command"],
    async ({ user, context, params, body, request }) => {
      const conversationId = asConversationId(params.conversationId);
      const runId = asAgentRunId(params.runId);
      const run = await conversations.commandRun(
        conversationId,
        runId,
        user,
        withRequestLocale(context, options, request, undefined),
        toRuntimeRunCommand(body.command)
      );
      return runCommandResponseSchema.parse({ run });
    }
  );

  route(
    apiOperations["conversations.runs.observe"],
    async ({ user, context, params, query, request, reply }) => {
      const conversationId = asConversationId(params.conversationId);
      const runId = asAgentRunId(params.runId);
      const afterSequence = readAfterSequence(query.after, request.headers["last-event-id"]);
      const localizedContext = withRequestLocale(context, options, request, undefined);

      const run = await conversations.getConversationRunForUser(conversationId, runId, user);
      if (!run) {
        throw new AppError("NOT_FOUND", "Agent run is not available");
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
            for await (const event of conversations.observeRun(runId, localizedContext, {
              afterSequence
            })) {
              if (closed) {
                return;
              }
              if (isTerminalRunEventType(event.type)) {
                // The monitor records the end of the run in the audit behind the event. Whoever
                // hears that a run has ended reads back what is recorded, the audit included.
                await lifecycleMonitorTasks.get(runId);
              }
              const observation = runObservationSchema.parse({
                clientInstanceId: options.clientInstanceId,
                runId,
                conversationId,
                ownerUserId: run.ownerUserId,
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
    }
  );

  function monitorRunLifecycleOnce(input: {
    conversationId: ConversationId;
    context: RuntimeCallContext;
    runId: AgentRunId;
    user: AuthenticatedUser;
  }): void {
    if (lifecycleMonitorTasks.has(input.runId)) {
      return;
    }
    const task = (async () => {
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
          return;
        }
      }
    })()
      .catch((error: unknown) => {
        log.warn(
          { err: error, conversationId: input.conversationId, runId: input.runId },
          "Agent run lifecycle monitor failed"
        );
      })
      .finally(() => {
        lifecycleMonitorTasks.delete(input.runId);
      });
    lifecycleMonitorTasks.set(input.runId, task);
  }

  async function createStartRunResponse(
    request: FastifyRequest,
    conversation: Conversation,
    userMessage: ChatMessage,
    run: AgentRun,
    user: AuthenticatedUser
  ) {
    const eventsUrl = apiOperations["conversations.runs.observe"].buildPath({
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

function isTerminalRunEventType(type: AgentRuntimeEvent["type"]): boolean {
  return type === "run_completed" || type === "run_cancelled" || type === "run_failed";
}

function isObservableRunStatus(status: string | undefined): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

function readAfterSequence(
  queryAfter: string | undefined,
  headerAfter: string | string[] | undefined
): number {
  const rawValue = queryAfter ?? (Array.isArray(headerAfter) ? headerAfter[0] : headerAfter);
  if (!rawValue) {
    return 0;
  }
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function toRuntimeRunCommand(
  command:
    | {
        type: "continue";
      }
    | {
        type: "tool_permission_decision";
        toolCallId: string;
        approved: boolean;
        reason?: string;
      }
) {
  if (command.type === "continue") {
    return command;
  }
  return {
    ...command,
    toolCallId: asToolCallId(command.toolCallId)
  };
}
