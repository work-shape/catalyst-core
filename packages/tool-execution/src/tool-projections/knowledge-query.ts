import {
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_QUERY_TOOL_NAME,
  knowledgeToolCall,
  type ToolExecutionRequest,
  type ToolHandlerFailureResult
} from "@work-shape/catalyst-core";
import { isKnowledgeAddFilesOperation } from "../knowledge-add-files-tool";
import type { RunOperationDeps } from "../operation-execution";
import { failed } from "../tool-results";
import type { ToolProjection } from "./projection";

/**
 * The one knowledge tool, as the query of the Knowledge Base its input names. The operations
 * of a Knowledge Base read, except adding files, which its own projection names.
 */
export const knowledgeQueryProjection: ToolProjection = {
  toolName: KNOWLEDGE_QUERY_TOOL_NAME,
  project: (request, { deps }) => knowledgeQueryRequest(request, deps),
  operationEffect: (operation) =>
    operation.startsWith(KNOWLEDGE_OPERATION_PREFIX) && !isKnowledgeAddFilesOperation(operation)
      ? "reading"
      : undefined
};

/**
 * A call of the one knowledge tool as the call of the operation it stands for: the query of
 * the Knowledge Base its input names, with the rest of its input. The agent's own list is
 * asked first, so an agent reaches no Knowledge Base it does not list, whatever its model
 * sends. The operation then answers like any other: the person's `knowledge_base.use` is asked
 * of each call, and each call is one run.
 */
async function knowledgeQueryRequest(
  request: ToolExecutionRequest,
  deps: RunOperationDeps
): Promise<{ request: ToolExecutionRequest } | { refusal: ToolHandlerFailureResult }> {
  const call = knowledgeToolCall(request.input);
  if (!call) {
    return {
      refusal: failed(
        "validation_failed",
        'Name the Knowledge Base to read under "knowledgeBase", by one of the ids the tool lists.'
      )
    };
  }
  const listed = (await deps.agentToolNames?.(request.agentName, request.conversationId)) ?? [];
  if (!listed.includes(call.operation)) {
    return {
      refusal: failed(
        "not_allowed",
        `The Knowledge Base '${call.knowledgeBase}' is not assigned to this agent. Read one of the Knowledge Bases the tool lists.`,
        { reason: "knowledge_base_not_assigned", knowledgeBase: call.knowledgeBase }
      )
    };
  }
  return { request: { ...request, toolName: call.operation, input: call.input } };
}
