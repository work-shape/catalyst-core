import { AppError } from "./errors";
import {
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity
} from "./identity";
import type { ClientInstanceId, ConversationId } from "./ids";
import type { OperationOrigin } from "./operations";
import type { PlatformStores } from "./platform-store";

/** A subagent inherits its root chat's readers and permanent personal-data mark. */
export async function rootConversationOf(
  stores: Pick<PlatformStores, "conversations">,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
) {
  const thread = await stores.conversations.getConversation(clientInstanceId, conversationId);
  if (thread?.kind === "run_thread" && thread.parentConversationId) {
    return stores.conversations.getConversation(clientInstanceId, thread.parentConversationId);
  }
  return thread;
}

export function personalConnectionContextError(reason: string): AppError {
  return new AppError(
    "FORBIDDEN",
    `A personal connection cannot run here: ${reason}`,
    {
      reason: "personal_connection_context"
    },
    { exposeMessage: true }
  );
}

/** Owner-bound admission, independent of roles, grants and the current browser session. */
export async function requirePersonalConnectionContext(input: {
  stores: Pick<PlatformStores, "conversations" | "agentRuns" | "workspaces">;
  clientInstanceId: ClientInstanceId;
  actor: AuthenticatedIdentity | undefined;
  origin: OperationOrigin | undefined;
  byAppAction?: boolean;
}) {
  const { actor, origin, stores, clientInstanceId } = input;
  if (!origin || origin.kind !== "agent" || origin.boundBy || input.byAppAction) {
    throw personalConnectionContextError(
      "only an owner's agent call outside an App or Workflow may use it"
    );
  }
  if (
    !actor ||
    isAuthenticatedServicePrincipal(actor) ||
    actor.delegatedActor ||
    actor.keyScopes !== undefined
  ) {
    throw personalConnectionContextError(
      "the actor must be a person without a delegated actor or API key"
    );
  }
  const owner = getSubjectUserId(actor);
  const run = await stores.agentRuns.getAgentRun({ clientInstanceId, runId: origin.agentRunId });
  if (
    !run ||
    run.conversationId !== origin.conversationId ||
    run.ownerUserId !== owner ||
    run.workflowStepRunId ||
    run.principalId ||
    run.authorization?.personalConnectionsAllowed !== true ||
    run.authorization.subjectUserId !== owner ||
    run.authorization.principal.kind !== "user" ||
    run.authorization.principal.id !== owner ||
    run.authorization.principal.clientInstanceId !== clientInstanceId ||
    run.authorization.delegatedActor
  ) {
    throw personalConnectionContextError(
      "the run must record its owner's first-party session or authorized scheduled start and belong to no Workflow"
    );
  }
  // Workflow run threads are deliberately absent from the person-facing conversation store.
  const conversation = await rootConversationOf(stores, clientInstanceId, origin.conversationId);
  if (
    !conversation ||
    conversation.kind !== "chat" ||
    conversation.status !== "active" ||
    conversation.createdByUserId !== owner
  ) {
    throw personalConnectionContextError(
      "the root must be an active chat conversation created by this person, outside a Workflow run"
    );
  }
  const workspace = await stores.workspaces.getWorkspace(
    clientInstanceId,
    conversation.collaborationWorkspaceId
  );
  if (
    !workspace ||
    (workspace.kind === "personal"
      ? workspace.personalUserId !== owner
      : conversation.visibility !== "private")
  ) {
    throw personalConnectionContextError("only its creator may read the conversation");
  }
  return conversation;
}

/** No content is included in the refusal. */
export function personalConversationPrivateError(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    "A conversation containing personal data must stay private",
    { reason: "personal_conversation_private" },
    { exposeMessage: true }
  );
}
