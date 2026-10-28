import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  dataStoreOperationName,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  ownerReachRefusal,
  type ActorAccess,
  type AuditRecorder,
  type AuthenticatedUser,
  type Conversation,
  type RuntimeCallContext,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { DATA_STORE_USE_VERBS, type DataStoreUsed } from "@work-shape/catalyst-tool-execution";
import { accessResource } from "../assets/asset-access";
import { assetTitle } from "../assets/asset-reference-labels";
import type { AssetWorkflowOptions } from "../types";
import { requireOwnTranscript } from "./platform-asset-subject";

// A Data Store added to a conversation for reading (STORE-USE-1), beside what the conversation
// is about. The agent's `data_store.use` adds the person's own store in their own conversation
// at once; any other store waits for the person's click on a card, which
// `conversations.data_stores.add` carries. The row grants nothing: the store's read tools ask
// the person's `data_store.read` on every call, as they do for a conversation about the store.
// Only a conversation nobody else reads takes a store: the answers from it stand in the
// transcript, and the person cannot consent for the others who read it.

type Options = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "stores" | "configAssets" | "modules" | "auditRecorder"
>;

/** One refusal for a store that is not there, of a module that is off, or one the person may not read. */
const unavailable = () =>
  new AppError("NOT_FOUND", "This Data Store is not available to you.", undefined, {
    exposeMessage: true
  });

/**
 * Refuses a call that is not the person's own turn in their own session: a subagent, a
 * Workflow step's agent, a scheduled start, a Workflow draft test and a run started with a key
 * (a personal API key, an embedding host's token) or for a delegated actor. A worker rebuilds
 * the actor of a run without its key, so there the run's own record decides (`firstPartyRun`).
 */
export function requirePersonsTurn(context: ToolExecutionContext): void {
  const actor = context.user;
  const workerCall =
    context.runFence !== undefined && context.runFence.runId === context.toolRequest?.agentRunId;
  const ownTurn =
    context.toolRequest !== undefined &&
    context.subagent !== true &&
    context.workflowAgent !== true &&
    context.unattended !== true &&
    context.workflowDraft === undefined &&
    !isAuthenticatedServicePrincipal(actor) &&
    actor.keyScopes === undefined &&
    actor.delegatedActor === undefined &&
    (!workerCall || context.firstPartyRun === true);
  if (ownTurn) return;
  throw new AppError(
    "FORBIDDEN",
    "Only the person can add a Data Store to their conversation, in their own turn of it: never a subagent, a Workflow step, a scheduled start or a call with a key. Nothing was added. Tell the person to ask for it in the conversation themselves.",
    { reason: "data_store_use_not_persons_turn" },
    { exposeMessage: true }
  );
}

/**
 * Refuses a conversation that others read: one shared with its workspace, outside a Personal
 * Workspace. They would read what the agent answers from the store, which the person's step
 * cannot allow for them.
 */
function requireOwnConversation(options: Options, conversation: Conversation) {
  return requireOwnTranscript(options, conversation, {
    message:
      "Others read this conversation, so no Data Store is added to it: they would see the answers from it. Nothing was added. Tell the person to start a chat of their own and ask there.",
    reason: "data_store_conversation_shared"
  });
}

/**
 * Adds a Data Store to a conversation for reading, or answers that it waits for the person.
 * `confirmed` is the person's own step (their click on the card); without it, only the
 * person's own store in their own Personal Workspace's conversation is added. Refuses a store
 * that is not there, not published or not readable by the person, and a Personal Workspace's
 * store in a conversation outside it (owner reach). Audits an add with ids only.
 */
export async function useDataStoreInConversation(
  options: Options,
  input: {
    conversation: Conversation;
    actor: AuthenticatedUser;
    access: Pick<ActorAccess, "authorize">;
    name: string;
    confirmed: boolean;
    context: Pick<RuntimeCallContext, "correlationId" | "locale">;
    audit?: AuditRecorder;
    /** The agent's call the person confirmed, when the card carried it. */
    toolCallId?: string;
  }
): Promise<DataStoreUsed> {
  const { conversation, actor, name } = input;
  if (options.modules.offModuleOf("kind", DATA_STORE_ASSET_KIND) !== undefined) throw unavailable();
  // Before the store is read: a shared conversation learns nothing of it.
  await requireOwnConversation(options, conversation);
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name
  });
  if (
    row?.status !== "active" ||
    !input.access.authorize(
      DATA_STORE_ACTIONS.read,
      accessResource(row.kind, row.name, row.scope, row.id)
    ).allowed
  )
    throw unavailable();
  const owner =
    row.scope.kind === "workspace"
      ? await options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(row.scope.workspaceId)
        )
      : undefined;
  if (
    row.scope.kind === "workspace" &&
    ownerReachRefusal(
      { kind: "workspace", workspaceId: row.scope.workspaceId, workspaceKind: owner?.kind },
      { kind: "conversation", workspaceId: conversation.collaborationWorkspaceId }
    ) !== undefined
  )
    throw new AppError(
      "FORBIDDEN",
      "This Data Store belongs to a Personal Workspace and is read only in its owner's own conversations there. Nothing was added.",
      { reason: "owner_reach" },
      { exposeMessage: true }
    );
  if (row.publishedRevision === undefined)
    throw new AppError(
      "CONFLICT",
      "This Data Store has not been published yet, so it has no rows to read. Nothing was added.",
      { reason: "data_store_unpublished" },
      { exposeMessage: true }
    );
  const title = assetTitle(
    options.configAssets.kinds.kinds,
    DATA_STORE_ASSET_KIND,
    row.name,
    row.publishedConfig ?? row.config ?? {},
    input.context.locale
  );
  const answer = (added: boolean): DataStoreUsed => ({
    name: row.name,
    title,
    added,
    ...(added ? {} : { awaitsPerson: true as const }),
    readTools: DATA_STORE_USE_VERBS.map((verb) => dataStoreOperationName(row.name, verb))
  });
  const listed = await options.stores.conversations.listConversationDataStores({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id
  });
  if (listed.some((store) => store.assetId === row.id)) return answer(true);
  // The person's own store, in a conversation of their own Personal Workspace, which nobody
  // else reads: the person's request is their step, as an open of their own asset is.
  const userId = getSubjectUserId(actor);
  const own =
    owner?.kind === "personal" &&
    owner.personalUserId === userId &&
    row.scope.kind === "workspace" &&
    row.scope.workspaceId === conversation.collaborationWorkspaceId;
  if (!own && !input.confirmed) return answer(false);
  const added = await options.stores.conversations.addConversationDataStore({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id,
    assetId: row.id,
    addedByUserId: userId,
    addedAt: new Date().toISOString()
  });
  if (!added) {
    // Added meanwhile by a second tab or a retry, shared with its workspace meanwhile, or gone.
    const now = await options.stores.conversations.listConversationDataStores({
      clientInstanceId: options.clientInstanceId,
      conversationId: conversation.id
    });
    if (now.some((store) => store.assetId === row.id)) return answer(true);
    const current = await options.stores.conversations.getConversation(
      options.clientInstanceId,
      conversation.id
    );
    if (current) await requireOwnConversation(options, current);
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  await (input.audit ?? options.auditRecorder).record({
    type: "conversation.data_store_added",
    status: "success",
    actor: auditActorFromIdentity(actor),
    subject: conversation.id,
    correlationId: input.context.correlationId,
    metadata: {
      storeAssetId: row.id,
      by: input.confirmed ? "card" : "own_store",
      ...(input.toolCallId === undefined ? {} : { confirmsToolCallId: input.toolCallId })
    }
  });
  return answer(true);
}
