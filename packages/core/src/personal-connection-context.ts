import { CONNECTION_CALL_REASONS, connectionCallSentence } from "./connection-operations";
import { AppError, PersonalDataModelRegionError } from "./errors";
import {
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity
} from "./identity";
import type { AgentRunId, ClientInstanceId, ConversationId } from "./ids";
import type { OperationCallRuntime, OperationOrigin } from "./operations";
import type { PlatformStores } from "./platform-store";

/** A subagent inherits its root chat's readers and permanent personal-data mark. */
export async function rootConversationOf(
  stores: { conversations: Pick<PlatformStores["conversations"], "getConversation"> },
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
) {
  const thread = await stores.conversations.getConversation(clientInstanceId, conversationId);
  if (thread?.kind === "run_thread" && thread.parentConversationId) {
    return stores.conversations.getConversation(clientInstanceId, thread.parentConversationId);
  }
  return thread;
}

/** Unknown roots and failed reads are restricted; a known Workflow run cannot read personal Connections. */
export async function personalDataConversation(
  stores: Parameters<typeof rootConversationOf>[0] & {
    agentRuns?: Pick<PlatformStores["agentRuns"], "getAgentRun">;
  },
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  runId?: AgentRunId
): Promise<boolean> {
  try {
    const conversation = await rootConversationOf(stores, clientInstanceId, conversationId);
    if (conversation)
      return conversation.kind !== "chat" || conversation.personalDataAt !== undefined;
    // Workflow threads are deliberately absent from getConversation. Only matching, recorded
    // run provenance may admit them; an existing conversation's mark always takes precedence.
    const run = runId && (await stores.agentRuns?.getAgentRun({ clientInstanceId, runId }));
    return !(
      run &&
      run.conversationId === conversationId &&
      run.workflowStepRunId &&
      run.authorization &&
      run.authorization.personalConnectionsAllowed !== true
    );
  } catch {
    return true;
  }
}

/** Refuse unattended work that could carry personal data beyond its conversation. */
export async function requireUnmarkedConversation(
  stores: Parameters<typeof personalDataConversation>[0],
  clientInstanceId: ClientInstanceId,
  origin: OperationOrigin
): Promise<void> {
  if (
    (origin.kind === "agent" || origin.kind === "app") &&
    origin.conversationId !== undefined &&
    (await personalDataConversation(
      stores,
      clientInstanceId,
      origin.conversationId,
      origin.kind === "agent" ? origin.agentRunId : undefined
    ))
  ) {
    throw new AppError(
      "FORBIDDEN",
      "This action cannot start from a conversation containing personal data",
      { reason: "personal_data_conversation" },
      { exposeMessage: true }
    );
  }
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

/**
 * The regions a model route may declare for a run to call a personal Connection, where release
 * config names none. A route without a region never passes, whatever the list.
 */
export const DEFAULT_PERSONAL_MODEL_REGIONS: readonly string[] = Object.freeze(["eu"]);

/**
 * Whether a model route may carry personal data: its region is in the list. A route without a
 * region never passes. The one rule for a personal call's admission and for every model request
 * of a conversation with the personal-data mark (MODEL-REGION-3).
 */
export function modelRouteAllowedForPersonalData(
  route: { region?: string },
  allowed: readonly string[] = DEFAULT_PERSONAL_MODEL_REGIONS
): boolean {
  return route.region !== undefined && allowed.includes(route.region);
}

/**
 * Refuses a model request on a route outside `allowed` where the conversation carries the
 * personal-data mark. The mark is read only for such a route; a mark that cannot be read counts
 * as set (`personalDataConversation`). A model call that sends a conversation's content goes
 * through this check.
 */
export async function requirePersonalDataModelRoute(input: {
  route: { region?: string };
  allowed: readonly string[];
  marked: () => Promise<boolean>;
}): Promise<void> {
  if (modelRouteAllowedForPersonalData(input.route, input.allowed)) return;
  if (await input.marked()) throw new PersonalDataModelRegionError(input.allowed);
}

/** Owner-bound admission, independent of roles, grants and the current browser session. */
export async function requirePersonalConnectionContext(input: {
  stores: Pick<PlatformStores, "conversations" | "agentRuns" | "workspaces">;
  clientInstanceId: ClientInstanceId;
  actor: AuthenticatedIdentity | undefined;
  origin: OperationOrigin | undefined;
  byAppAction?: boolean;
  modelRoutes?: OperationCallRuntime["modelRoutes"];
  /** `modules.connections.personalModelRegions`; left out, `DEFAULT_PERSONAL_MODEL_REGIONS`. */
  personalModelRegions?: readonly string[];
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
  const allowed = input.personalModelRegions ?? DEFAULT_PERSONAL_MODEL_REGIONS;
  if (
    !input.modelRoutes?.length ||
    input.modelRoutes.some((route) => !modelRouteAllowedForPersonalData(route, allowed))
  ) {
    throw personalConnectionRegionError(allowed);
  }
  return conversation;
}

/**
 * The region refusal names the regions the instance allows, never a route's name or region.
 * The details carry the reason alone, so no Connect card is offered.
 */
function personalConnectionRegionError(allowed: readonly string[]): AppError {
  const regions = allowed.length > 0 ? allowed.join(", ") : "none";
  return new AppError(
    CONNECTION_CALL_REASONS.personal_connection_region,
    `${connectionCallSentence("personal_connection_region", undefined)} Every model route of the run has to declare one of the regions allowed for personal Connections: ${regions}.`,
    { reason: "personal_connection_region" },
    { exposeMessage: true }
  );
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
