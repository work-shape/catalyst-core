import {
  isAppError,
  type ClientInstanceId,
  type ConversationId,
  type ExecutionWorkspaceFileStore,
  type ExecutionWorkspaceId,
  type ObjectStorage,
  type UpsertWorkspaceFileInput,
  type WorkspaceCommandId,
  type WorkspaceFile
} from "@vivd-catalyst/core";
import {
  emitWorkspaceCommandTelemetry,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";

/**
 * Records a workspace file whose bytes were just stored under `input.objectKey`. The store
 * refuses the row when the Conversation was deleted in the meantime. No row names the bytes
 * then, so they are removed here, best effort; a failed removal is reported to the telemetry
 * with the key.
 */
export async function upsertStoredWorkspaceFile(
  store: Pick<ExecutionWorkspaceFileStore, "upsertWorkspaceFile">,
  objectStorage: ObjectStorage,
  telemetry: WorkspaceCommandTelemetry | undefined,
  input: UpsertWorkspaceFileInput
): Promise<WorkspaceFile> {
  try {
    return await store.upsertWorkspaceFile(input);
  } catch (error: unknown) {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      try {
        await objectStorage.delete(input.objectKey);
      } catch {
        await emitWorkspaceCommandTelemetry(telemetry, {
          type: "stored_file_removal_failed",
          clientInstanceId: input.clientInstanceId,
          workspaceId: input.workspaceId,
          ...(input.lastCommandId ? { commandId: input.lastCommandId } : {}),
          objectKey: input.objectKey,
          failedCount: 1
        });
      }
    }
    throw error;
  }
}

export interface PutWorkspaceFileBytesInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  workspaceId: ExecutionWorkspaceId;
  commandId: WorkspaceCommandId;
  path: string;
  bytes: Uint8Array;
  checksum: string;
  mimeType?: string;
}

export interface WorkspaceFileObjectKeyFactory {
  createWorkspaceFileObjectKey(input: WorkspaceFileObjectKeyInput): string;
}

export type WorkspaceFileObjectKeyInput = Omit<PutWorkspaceFileBytesInput, "bytes"> & {
  byteSize: number;
};

export const DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY: WorkspaceFileObjectKeyFactory = {
  createWorkspaceFileObjectKey(input) {
    return [
      "execution-workspaces",
      encodeObjectKeySegment(input.clientInstanceId),
      encodeObjectKeySegment(input.conversationId),
      encodeObjectKeySegment(input.workspaceId),
      encodeObjectKeySegment(input.commandId),
      encodeObjectKeySegment(input.checksum),
      ...input.path.split("/").map(encodeObjectKeySegment)
    ].join("/");
  }
};

/** Stores the bytes of one workspace file in the `workspaces` store and returns their key. */
export async function putWorkspaceFile(
  objectStorage: ObjectStorage,
  input: PutWorkspaceFileBytesInput,
  keyFactory: WorkspaceFileObjectKeyFactory = DEFAULT_WORKSPACE_FILE_OBJECT_KEY_FACTORY
): Promise<{ objectKey: string }> {
  const objectKey = keyFactory.createWorkspaceFileObjectKey({
    ...input,
    byteSize: input.bytes.byteLength
  });
  await objectStorage.put(objectKey, input.bytes, { contentType: input.mimeType });
  return { objectKey };
}

function encodeObjectKeySegment(value: string): string {
  return encodeURIComponent(value);
}
