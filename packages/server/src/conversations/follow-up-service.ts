import {
  AppError,
  asAgentRunId,
  asConversationId,
  asUserId,
  defineJobHandler,
  getSubjectUserId,
  isAppError,
  requireAuthScope,
  type AgentRunAuthorization,
  type AuthenticatedUser,
  type ConversationId,
  type JobControl,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { dispatchConversationFollowUpJob } from "../jobs/job-kinds";
import { ConversationWorkflow } from "./conversation-service";
import { RunStartWorkflow } from "./run-start-service";

// Conversation dispatches this API process starts together; the rest wait in the job queue.
const FOLLOW_UP_DISPATCH_SLOTS = 4;

export class FollowUpWorkflow {
  private readonly conversations: ConversationWorkflow;
  constructor(private readonly options: ChatServerOptions) {
    this.conversations = new ConversationWorkflow(options);
  }

  async withdraw(conversationId: ConversationId, followUpId: string, user: AuthenticatedUser) {
    await this.conversations.requireConversationAccess(conversationId, user);
    return this.options.stores.followUps.cancel({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      followUpId,
      authorUserId: getSubjectUserId(user)
    });
  }

  async requestDispatch(
    conversationId: ConversationId,
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<void> {
    requireAuthScope(user, "run:start");
    await this.conversations.requireConversationAccess(conversationId, user);
    await this.options.stores.transaction(async (stores) => {
      const scope = { clientInstanceId: this.options.clientInstanceId, conversationId };
      const oldest = await stores.followUps.getOldestPending(scope);
      if (!oldest) return;
      if (oldest.authorUserId !== getSubjectUserId(user))
        throw new AppError("FORBIDDEN", "Only the author may send this follow-up now");
      if (await stores.agentRuns.getActiveConversationAgentRun(scope))
        throw new AppError("CONFLICT", "Conversation already has an active agent run");
      const latest = await stores.agentRuns.getLatestConversationAgentRun(scope);
      if (!latest) throw new AppError("CONFLICT", "Conversation has no ended run");
      await stores.jobs.enqueue(
        dispatchConversationFollowUpJob,
        { conversationId, afterRunId: latest.id },
        {
          clientInstanceId: this.options.clientInstanceId,
          subject: conversationId,
          dedupeKey: conversationId,
          concurrencyKey: conversationId,
          correlationId: context.correlationId
        }
      );
    });
  }
}

export function createFollowUpDispatchHandler(options: ChatServerOptions) {
  return defineJobHandler({
    kind: dispatchConversationFollowUpJob,
    slots: FOLLOW_UP_DISPATCH_SLOTS,
    async run(job, control) {
      const scope = {
        clientInstanceId: options.clientInstanceId,
        conversationId: asConversationId(job.payload.conversationId)
      };
      // A retry of an old wake-up must never consume a second message or restart a paused queue.
      const latest = await options.stores.agentRuns.getLatestConversationAgentRun(scope);
      if (
        latest?.id !== job.payload.afterRunId ||
        (await options.stores.agentRuns.getActiveConversationAgentRun(scope))
      )
        return;
      const followUp = await options.stores.followUps.getOldestPending(scope);
      if (!followUp) return;
      const authorization = await options.stores.followUps.getAuthorization({
        ...scope,
        followUpId: followUp.id
      });
      const user = await loadFollowUpAuthor(options, followUp.authorUserId, authorization);
      try {
        if (
          !user ||
          !authorization ||
          authorization.subjectUserId !== followUp.authorUserId ||
          authorization.principal.clientInstanceId !== options.clientInstanceId ||
          !Array.isArray(authorization.scopes) ||
          authorization.scopes.some((scope) => typeof scope !== "string")
        )
          throw new AppError("FORBIDDEN", "Follow-up authorization is unavailable");
        const conversations = new ConversationWorkflow(options);
        const conversation = await conversations.requireConversationAccess(
          scope.conversationId,
          user
        );
        await conversations.requireMemberWorkspace(user, conversation.collaborationWorkspaceId);
        await new RunStartWorkflow(options, (fn) => control.transaction(fn)).startMessageRun(
          scope.conversationId,
          user,
          {
            ...authorization,
            user,
            clientInstanceId: options.clientInstanceId,
            correlationId: job.correlationId,
            signal: control.signal
          },
          {
            text: followUp.text,
            agentName: followUp.agentName,
            modelBindingId: followUp.modelBindingId,
            reasoningEffort: followUp.reasoningEffort,
            dispatchFollowUpId: followUp.id,
            dispatchAfterRunId: asAgentRunId(job.payload.afterRunId),
            dispatchJobId: job.id
          }
        );
      } catch (error) {
        if (isAppError(error) && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
          await cancelUnavailableFollowUp(options, control, scope.conversationId, followUp.id);
          return;
        }
        // Another start, withdrawal or dispatch won the conversation lock. Its outcome stands.
        if (isAppError(error) && error.code === "CONFLICT") {
          const latest = await options.stores.agentRuns.getLatestConversationAgentRun(scope);
          if (
            latest?.id !== job.payload.afterRunId ||
            (await options.stores.agentRuns.getActiveConversationAgentRun(scope))
          )
            return;
          // A withdrawal won, but this wake-up still belongs to the idle turn. Retry against
          // its new oldest item rather than pausing a queue whose previous run succeeded.
        }
        throw error;
      }
    }
  });
}

async function cancelUnavailableFollowUp(
  options: ChatServerOptions,
  control: JobControl,
  conversationId: ConversationId,
  followUpId: string
): Promise<void> {
  try {
    await control.transaction((stores) =>
      stores.followUps.cancel({
        clientInstanceId: options.clientInstanceId,
        conversationId,
        followUpId
      })
    );
  } catch (error) {
    if (!isAppError(error) || (error.code !== "NOT_FOUND" && error.code !== "CONFLICT"))
      throw error;
  }
}

async function loadFollowUpAuthor(
  options: ChatServerOptions,
  userId: string,
  authorization: AgentRunAuthorization | undefined
): Promise<AuthenticatedUser | undefined> {
  const user = await options.stores.users.getUser({
    clientInstanceId: options.clientInstanceId,
    userId: asUserId(userId)
  });
  if (!user || user.status !== "active") return undefined;
  const principal = authorization?.principal;
  const identity =
    principal?.kind === "user"
      ? user.identities.find(
          (identity) =>
            identity.authSource === principal.authSource &&
            identity.externalUserId === principal.externalUserId
        )
      : user.identities[0];
  return {
    id: user.id,
    subjectUserId: user.id,
    externalUserId: identity?.externalUserId ?? user.id,
    authSource: identity?.authSource ?? "follow-up-dispatch",
    clientInstanceId: user.clientInstanceId,
    displayLabel: user.displayLabel,
    email: user.email,
    roles: user.roles,
    permissionRefs: user.permissionRefs,
    permissions: user.permissions,
    principal: authorization?.principal,
    delegatedActor: authorization?.delegatedActor,
    scopes: authorization?.scopes
  };
}
