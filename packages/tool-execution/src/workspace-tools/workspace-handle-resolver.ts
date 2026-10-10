import {
  type ExecutionWorkspaceMetadataStore,
  type ISODateString,
  type WorkspaceHandleResolver,
  getRuntimeSubjectUserId
} from "@vivd-catalyst/core";

export function createExecutionWorkspaceHandleResolver(options: {
  store: ExecutionWorkspaceMetadataStore;
  now: () => ISODateString;
}): WorkspaceHandleResolver {
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
    }
  };
}
