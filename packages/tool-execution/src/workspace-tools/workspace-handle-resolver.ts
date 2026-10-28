import {
  type ConversationId,
  type ExecutionWorkspaceMetadataStore,
  type ISODateString,
  type ToolExecutionContext,
  type WorkspaceHandle,
  type WorkspaceHandleResolver,
  getRuntimeSubjectUserId
} from "@work-shape/catalyst-core";

/** The conversation of a call and its workspace, when it has one. */
interface ExistingWorkspaceLookup {
  conversationId: ConversationId;
  handle?: WorkspaceHandle;
}

export interface ExecutionWorkspaceHandleResolver extends WorkspaceHandleResolver {
  /**
   * Looks the workspace of the call's conversation up and creates nothing: the way a reading
   * tool addresses it. Undefined when the call carries no tool request.
   */
  findWorkspaceHandle(context: ToolExecutionContext): Promise<ExistingWorkspaceLookup | undefined>;
  /**
   * The conversation and the agent run of the call, without a lookup: what the project folder
   * of the conversation is found by (PRJ-2). Undefined when the call carries no tool request.
   */
  callOf(
    context: ToolExecutionContext
  ): { conversationId: ConversationId; agentRunId: string } | undefined;
}

export function createExecutionWorkspaceHandleResolver(options: {
  store: ExecutionWorkspaceMetadataStore;
  now: () => ISODateString;
}): ExecutionWorkspaceHandleResolver {
  return {
    async resolveWorkspaceHandle(context) {
      const conversationId = context.toolRequest?.conversationId;
      if (!conversationId) {
        return undefined;
      }
      const workspace = await options.store.ensureExecutionWorkspace({
        clientInstanceId: context.clientInstanceId,
        conversationId,
        ownerUserId: getRuntimeSubjectUserId(context),
        now: options.now()
      });
      return {
        handle: { kind: "execution_workspace", id: workspace.id },
        conversationId: workspace.conversationId
      };
    },
    callOf(context) {
      const conversationId = context.toolRequest?.conversationId;
      const agentRunId = context.toolRequest?.agentRunId;
      return conversationId && agentRunId ? { conversationId, agentRunId } : undefined;
    },
    async findWorkspaceHandle(context) {
      const conversationId = context.toolRequest?.conversationId;
      if (!conversationId) {
        return undefined;
      }
      const workspace = await options.store.findExecutionWorkspaceOfActiveConversation({
        clientInstanceId: context.clientInstanceId,
        conversationId
      });
      return {
        conversationId,
        ...(workspace ? { handle: { kind: "execution_workspace", id: workspace.id } } : {})
      };
    }
  };
}
