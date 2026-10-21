import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  apiOperations,
  cancelRunResponseSchema,
  runObservationSchema,
  runCommandResponseSchema,
  queuedConversationRunResponseSchema,
  startConversationRunResponseSchema
} from "@work-shape/catalyst-api-contract";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AppError,
  type AgentRun,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ChatMessage,
  type Conversation,
  type ConversationId,
  asAgentRunId,
  asCollaborationWorkspaceId,
  asConversationId,
  requireAuthScope,
  withoutAgentPreviewConfig
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { RunObservationWorkflow } from "../conversations/run-observation-service";
import { awaitRunLifecycleAudit } from "../conversations/run-lifecycle-monitor";
import { FollowUpWorkflow } from "../conversations/follow-up-service";
import { RunStartWorkflow } from "../conversations/run-start-service";
import type { Route } from "../http/route";
import { conversationIdParam, withRequestLocale } from "./request-context";
import type { ChatServerOptions } from "../types";

export function registerAgentRunRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);
  const startWorkflow = new RunStartWorkflow(options);
  const followUps = new FollowUpWorkflow(options);
  route(apiOperations["conversations.follow_ups.withdraw"], async ({ user, params }) => ({
    followUp: await followUps.withdraw(conversationIdParam(params), params.followUpId, user)
  }));
  route(apiOperations["conversations.follow_ups.steer"], async ({ user, params }) => ({
    followUp: await followUps.steer(conversationIdParam(params), params.followUpId, user)
  }));
  route(apiOperations["conversations.follow_ups.dispatch"], async ({ user, params, context }) => {
    await followUps.requestDispatch(conversationIdParam(params), user, context);
    return {};
  });
  const runObservation = new RunObservationWorkflow(options);

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
      const run = await runObservation.cancelRun(
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
    async ({ user, access, context, params, body, request }) => {
      // The descriptor carries one scope; starting a run needs this second one as well.
      requireAuthScope(user, "run:start");
      const conversationId = conversationIdParam(params);
      const localizedContext = withRequestLocale(context, options, request, body.locale);
      const started = await startWorkflow.startMessageRun(conversationId, user, localizedContext, {
        agentName: body.agentName,
        modelBindingId: body.modelBindingId,
        reasoningEffort: body.reasoningEffort,
        access,
        idempotencyKey: body.idempotencyKey,
        text: body.message.text,
        followUp: body.followUp
      });
      if ("followUp" in started) return queuedConversationRunResponseSchema.parse(started);
      return createStartRunResponse(
        request,
        await readCurrentConversation(conversationId, user),
        started.userMessage,
        started.run,
        user
      );
    }
  );

  route(
    apiOperations["conversations.runs.create"],
    async ({ user, access, context, body, request }) => {
      // The descriptor carries one scope; starting a run needs this second one as well.
      requireAuthScope(user, "run:start");
      const localizedContext = withRequestLocale(context, options, request, body.locale);
      const started = await startWorkflow.createConversationAndStartMessageRun(
        user,
        localizedContext,
        {
          agentName: body.agentName,
          modelBindingId: body.modelBindingId,
          reasoningEffort: body.reasoningEffort,
          access,
          idempotencyKey: body.idempotencyKey,
          text: body.message.text,
          title: body.conversation?.title,
          collaborationWorkspaceId: body.conversation?.collaborationWorkspaceId
            ? asCollaborationWorkspaceId(body.conversation.collaborationWorkspaceId)
            : undefined,
          ...(body.conversation?.subject ? { subject: body.conversation.subject } : {}),
          ...(body.conversation?.visibility ? { visibility: body.conversation.visibility } : {})
        }
      );
      return createStartRunResponse(
        request,
        started.conversation,
        started.userMessage,
        started.run,
        user
      );
    }
  );

  route(
    apiOperations["conversations.runs.command"],
    async ({ user, context, params, body, request }) => {
      const conversationId = asConversationId(params.conversationId);
      const runId = asAgentRunId(params.runId);
      const run = await runObservation.commandRun(
        conversationId,
        runId,
        user,
        withRequestLocale(context, options, request, undefined),
        body.command
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

      const run = await runObservation.getConversationRunForUser(conversationId, runId, user);
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
            for await (const event of runObservation.observeRun(runId, localizedContext, {
              afterSequence
            })) {
              if (closed) {
                return;
              }
              if (isTerminalRunEventType(event.type)) {
                // The monitor records the end of the run in the audit behind the event. Whoever
                // hears that a run has ended reads back what is recorded, the audit included.
                await awaitRunLifecycleAudit(options.agentRuntime, runId);
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
      userMessage: { ...userMessage, metadata: withoutAgentPreviewConfig(userMessage.metadata) },
      run,
      thread: await runObservation.getThreadSnapshot(conversation.id, user),
      eventsUrl: new URL(eventsUrl, `${request.protocol}://${requestHost}`).toString()
    });
  }
}

function isTerminalRunEventType(type: AgentRuntimeEvent["type"]): boolean {
  return type === "run_completed" || type === "run_cancelled" || type === "run_failed";
}

function isObservableRunStatus(status: string | undefined): boolean {
  return ACTIVE_AGENT_RUN_STATUSES.some((active) => active === status);
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
