import {
  createPlatformId,
  readObjectBytes,
  type ClientInstanceId,
  type ConversationId,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceMetadataStore,
  type ObjectStorage
} from "@work-shape/catalyst-core";
import { putWorkspaceFile, upsertStoredWorkspaceFile } from "./workspace-file-bytes";
import { normalizeWorkspaceFilePath } from "./workspace-paths";
import { createWorkspaceChecksum } from "./workspace-tool-results";
import { DEFAULT_LIMITS } from "./workspace-tool-schemas";

/**
 * Files of a Conversation's Execution Workspace written and read by the platform itself, not
 * by an agent's tool: the input a Workflow agent step's worker puts in before the first turn,
 * and a dataset file the engine reads back after the run (An agent step with a workspace).
 * The same stores and keys as `workspace.write_file`; no command is queued.
 */
export function createWorkspaceFileAccess(options: {
  clientInstanceId: ClientInstanceId;
  store: ExecutionWorkspaceMetadataStore &
    Pick<ExecutionWorkspaceFileStore, "upsertWorkspaceFile" | "getWorkspaceFile">;
  objects: ObjectStorage;
  maxWorkspaceBytes?: number;
  now?: () => string;
}) {
  const { clientInstanceId, store, objects } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const maxBytes = options.maxWorkspaceBytes ?? DEFAULT_LIMITS.maxWorkspaceBytes;
  const pathOf = (path: string) => {
    const normalized = normalizeWorkspaceFilePath(path, DEFAULT_LIMITS);
    return normalized.status === "success" ? normalized.value : undefined;
  };
  return {
    maxBytes,
    async write(input: {
      conversationId: ConversationId;
      ownerUserId: string;
      files: readonly { path: string; bytes: Uint8Array; mimeType?: string }[];
    }): Promise<void> {
      const workspace = await store.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        now: now()
      });
      for (const file of input.files) {
        const path = pathOf(file.path);
        if (!path) throw new Error(`Invalid workspace file path: ${file.path}`);
        const checksum = createWorkspaceChecksum(file.bytes);
        const stored = await putWorkspaceFile(objects, {
          clientInstanceId,
          conversationId: workspace.conversationId,
          workspaceId: workspace.id,
          commandId: createPlatformId<"WorkspaceCommandId">("wcmd_file"),
          path,
          bytes: file.bytes,
          checksum,
          ...(file.mimeType ? { mimeType: file.mimeType } : {})
        });
        await upsertStoredWorkspaceFile(store, objects, undefined, {
          clientInstanceId,
          workspaceId: workspace.id,
          path,
          objectKey: stored.objectKey,
          byteSize: file.bytes.byteLength,
          checksum,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          metadata: { source: "workflow_step_input" },
          updatedAt: now()
        });
      }
    },
    async read(input: {
      conversationId: ConversationId;
      path: string;
    }): Promise<Uint8Array | undefined> {
      const path = pathOf(input.path);
      if (!path) return undefined;
      const workspace = await store.getExecutionWorkspaceForConversation({
        clientInstanceId,
        conversationId: input.conversationId
      });
      const file =
        workspace &&
        (await store.getWorkspaceFile({ clientInstanceId, workspaceId: workspace.id, path }));
      if (!file || file.byteSize > maxBytes) return undefined;
      return readObjectBytes(objects, file.objectKey);
    }
  };
}
