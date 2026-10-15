import {
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  type ConversationId,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import type { PlatformOperationsAudience } from "@work-shape/catalyst-tool-execution";

// Who would call the operations `platform.assets.operations` lists: a step of a Workflow, or a
// `connection` action of an App. Each audience is offered the operations exposed to its own
// surface, as the operation's own rule asks of a call from there.

/**
 * The operations that exist as data, by who names them: a step of a Workflow names any of
 * them; a `connection` action of an App names an operation of a Connection, and reaches a Data
 * Store and a Workflow through actions of their own kinds.
 */
const CALLABLE_PREFIXES: Readonly<Record<PlatformOperationsAudience, readonly string[]>> = {
  workflow: [CONNECTION_OPERATION_PREFIX, DATA_STORE_OPERATION_PREFIX, KNOWLEDGE_OPERATION_PREFIX],
  app: [CONNECTION_OPERATION_PREFIX]
};

/** Whether the audience names an operation of this name at all. */
export function callableByAudience(name: string, audience: PlatformOperationsAudience): boolean {
  return CALLABLE_PREFIXES[audience].some((prefix) => name.startsWith(prefix));
}

/**
 * The origin an operation's rule is asked from for the list: a step of a Workflow, or an action
 * of a Page of the agent's conversation. An operation not exposed to that surface is none the
 * audience may name. A Page names no App, so no App is asked.
 */
export function listingOrigin(
  audience: PlatformOperationsAudience,
  conversationId: ConversationId
): OperationOrigin {
  return audience === "app"
    ? { kind: "app", appRevisionId: "", actionName: "", pageSessionId: "", conversationId }
    : { kind: "workflow", workflowRunId: "", stepRunId: "" };
}
