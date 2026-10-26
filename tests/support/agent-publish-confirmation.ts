import {
  asAgentRunId,
  asToolCallId,
  createPlatformId,
  type CollaborationWorkspaceId,
  type JsonObject,
  type OperationCall
} from "@work-shape/catalyst-core";
import {
  executeConfirmedOperation,
  runOperation,
  type ApprovedOperationEnd,
  type OperationOutcome
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId } from "./access-instance";
import type { AppActionsInstance } from "./app-actions";
import { withTestSql } from "./test-sql";

/**
 * Kai's agent calls `assets.publish` with `input` in a conversation of Kai's in `workspaceId`.
 * Answers what the call answered and, where it waits for Kai's confirmation, `confirm`: Kai
 * confirms the card, and it answers what the Agent Run's worker then executes. Each `attempt`
 * is its own Agent Run. No Agent Run exists or resumes: the decision is written on the call's
 * run as the card's click writes it.
 */
export async function agentPublishes(
  t: AppActionsInstance,
  workspaceId: CollaborationWorkspaceId,
  input: JsonObject,
  attempt: string
): Promise<{ made: OperationOutcome; confirm(): Promise<ApprovedOperationEnd> }> {
  t.state.agentTools.set("assistant", ["assets.publish"]);
  const conversation = await t.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    createdByUserId: t.kai.id,
    createdByExternalUserId: t.kai.id,
    visibility: "private",
    title: "Publish",
    retainedUntil: "2099-01-01T00:00:00.000Z"
  });
  const agentRunId = asAgentRunId(`agent-publish-${attempt}`);
  const call: OperationCall = {
    operation: "assets.publish",
    effect: "changing",
    input,
    actor: {
      id: t.kai.id,
      externalUserId: t.kai.id,
      displayLabel: t.kai.displayLabel,
      roles: t.kai.roles,
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    },
    origin: {
      kind: "agent",
      agentRunId,
      conversationId: conversation.id,
      agentName: "assistant",
      toolCallId: asToolCallId(`call-${attempt}`),
      toolName: "assets.publish"
    },
    workspaceId,
    correlationId: `agent-publish-${attempt}`
  };
  const deps = t.operationCalls.deps;
  // Only the worker of the Agent Run holds a call for its person's confirmation.
  const lease = { jobId: createPlatformId<"JobId">("job"), leaseToken: attempt };
  const made = await runOperation(call, deps, { runFence: { runId: agentRunId, lease } });
  return {
    made,
    async confirm() {
      if (made.result.status !== "pending_confirmation") {
        throw new Error(`The call does not wait for a confirmation: ${JSON.stringify(made.run)}`);
      }
      const confirmed = { mode: "confirmed", by: t.kai.id, at: new Date().toISOString() };
      await withTestSql(
        (sql) =>
          sql`update operation_runs set decision = ${sql.json(confirmed)} where id = ${made.run.id}`
      );
      return executeConfirmedOperation({ runId: made.run.id, call }, deps, {});
    }
  };
}
