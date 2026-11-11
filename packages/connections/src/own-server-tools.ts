import {
  connectionOperationName,
  isOwnServerOwner,
  ownServersOn,
  ownerOnlyOwnerOf,
  parseConnectionOperationName,
  type ClientInstanceId,
  type ConnectionOperationConfig,
  type Conversation,
  type ConversationId,
  type OperationRunStore,
  type OperationOrigin,
  type PolicyValue
} from "@work-shape/catalyst-core";
import { readConnections, type ConnectionOperationSourceDeps } from "./connection-reads";

// The tools of a person's own MCP server (PMCP-4, connections-and-secrets.md, point 5). Such a
// server is on no agent: its accepted operations join the tools of the runs its owner starts in
// their own private chats, where the agent lets them in, and nobody else's. Its calls ask more
// than another personal Connection's, because nobody vetted the server:
// - a changing tool asks before each call, and an admin's `allow` does not lower that;
// - a reading tool asks too in a conversation where an operation of any other Connection ran,
//   in the chat or in one of its run threads, so what another system answered does not leave
//   for this one unasked. Where that cannot be read, it asks.

/** The tools of people's own servers, as a conversation's offer asks for them. */
export interface OwnServerTools {
  /**
   * The tool names of the servers the person added for themselves that an agent of their own
   * chat may be offered: switched on, exposed to agents. None while the operator's switch is off.
   */
  toolNamesOf(ownerUserId: string): Promise<string[]>;
  /** Of the names, those of an operation of anybody's own server. */
  ownServerToolNames(toolNames: readonly string[]): Promise<string[]>;
  /** Whether the operator's switch lets people add and use their own servers. */
  isOn(): boolean;
}

export function createOwnServerTools(deps: ConnectionOperationSourceDeps): OwnServerTools {
  return {
    isOn: () => ownServersOn(deps.ownServers),
    async toolNamesOf(ownerUserId) {
      if (!ownServersOn(deps.ownServers)) return [];
      return (await readConnections(deps))
        .filter(
          (connection) =>
            connection.config.enabled && isOwnServerOwner({ id: ownerUserId }, connection.config)
        )
        .flatMap((connection) =>
          connection.config.operations
            .filter((operation) => operation.enabled && operation.exposure.includes("agent"))
            .map((operation) => connectionOperationName(connection.config.name, operation.name))
        );
    },
    async ownServerToolNames(toolNames) {
      const named = toolNames.flatMap((toolName) => {
        const parsed = parseConnectionOperationName(toolName);
        return parsed ? [{ toolName, connection: parsed.connection }] : [];
      });
      if (named.length === 0) return [];
      const own = new Set(
        (await readConnections(deps))
          .filter((connection) => ownerOnlyOwnerOf(connection.config) !== undefined)
          .map((connection) => connection.config.name)
      );
      return named.filter((entry) => own.has(entry.connection)).map((entry) => entry.toolName);
    }
  };
}

/**
 * The floor of one call of a person's own server (ruling 10): for an agent's call, reading or
 * changing, `confirm` where an operation of another Connection ran in the conversation or one
 * of its threads, or where that cannot be read; a tool its owner always allows asks there too.
 * Outside an agent's run a changing call is `confirm`. Nothing else: that an agent's change
 * asks in a chat where only this server ran is the policy's, which the owner's "Always allow"
 * lowers (PMCP-4b).
 */
export async function ownServerPolicyFloor(
  deps: OwnServerFloorDeps,
  connectionName: string,
  operation: Pick<ConnectionOperationConfig, "effect">,
  origin: OperationOrigin
): Promise<PolicyValue | undefined> {
  // Outside an agent's run no person's setting applies, and a change asks all the same.
  if (origin.kind !== "agent") return operation.effect === "changing" ? "confirm" : undefined;
  return (await otherConnectionRan(deps, connectionName, origin.conversationId))
    ? "confirm"
    : undefined;
}

/** What the floor of a person's own server reads: the conversation's tree and its runs. */
export interface OwnServerFloorDeps {
  clientInstanceId: ClientInstanceId;
  stores: {
    conversations: {
      getConversation(
        clientInstanceId: ClientInstanceId,
        conversationId: ConversationId
      ): Promise<Pick<Conversation, "id" | "kind" | "parentConversationId"> | undefined>;
    };
    operationRuns: Pick<OperationRunStore, "connectionOperationsIn">;
  };
}

/** Whether an operation of another Connection than `name` ran in the conversation's tree. */
async function otherConnectionRan(
  deps: OwnServerFloorDeps,
  name: string,
  conversationId: ConversationId
): Promise<boolean> {
  try {
    // A subagent's call is in its run thread: its root chat and every thread under it count.
    const root = await chatOf(deps, conversationId);
    if (root === undefined) return true;
    const ran = await deps.stores.operationRuns.connectionOperationsIn({
      clientInstanceId: deps.clientInstanceId,
      conversationId: root
    });
    return ran.some((operation) => parseConnectionOperationName(operation)?.connection !== name);
  } catch {
    return true;
  }
}

/** How many run threads deep a subagent's thread may sit below its chat. */
const THREAD_DEPTH_MAX = 16;

/** The chat a conversation is, or the chat its run thread is under at any depth. */
async function chatOf(
  deps: OwnServerFloorDeps,
  conversationId: ConversationId
): Promise<ConversationId | undefined> {
  let id = conversationId;
  for (let depth = 0; depth <= THREAD_DEPTH_MAX; depth += 1) {
    const conversation = await deps.stores.conversations.getConversation(deps.clientInstanceId, id);
    if (!conversation) return undefined;
    if (conversation.kind !== "run_thread") return conversation.id;
    if (!conversation.parentConversationId) return undefined;
    id = conversation.parentConversationId;
  }
  return undefined;
}
