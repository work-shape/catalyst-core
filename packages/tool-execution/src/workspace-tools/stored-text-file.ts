import {
  type ToolExecutionContext,
  type ToolHandlerResult,
  type WorkspaceFile,
  createPlatformId,
  type ResolvedWorkspaceHandle
} from "@vivd-catalyst/core";
import { putWorkspaceFile, upsertStoredWorkspaceFile } from "../workspace-file-bytes";
import { normalizeWorkspaceFilePath } from "../workspace-paths";
import { createWorkspaceChecksum, failed, isTextMimeType } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

// What `workspace.write_file` and `workspace.edit_file` share: the path rule, the room check
// and the storing of one text file. Neither queues a command or starts a container.

type TextFileStep<T> =
  { status: "success"; value: T } | { status: "failed"; result: ToolHandlerResult<never> };

/** The path inside the workspace, by the rule every workspace tool has, or what to send instead. */
export function resolveTextFilePath(
  path: string,
  limits: WorkspaceToolDependencies["limits"]
): TextFileStep<string> {
  const normalized = normalizeWorkspaceFilePath(path, limits);
  if (normalized.status === "success") {
    return normalized;
  }
  return refused(
    "validation_failed",
    `${normalized.message}. Send a file path relative to /workspace, such as notes/plan.md.`,
    normalized.details
  );
}

/**
 * Refuses a path that cannot stand beside the files the workspace has. Stored paths are flat,
 * but a command gets them as files on a disk, where a name is a file or a folder and not both.
 */
export function checkPathFitsWorkspace(
  files: readonly WorkspaceFile[],
  path: string
): TextFileStep<void> {
  const folder = files.find((file) => file.path.startsWith(`${path}/`));
  if (folder) {
    return refused(
      "validation_failed",
      `'${path}' is a folder of the workspace. Choose a file path inside it, or another name.`,
      { path }
    );
  }
  const parent = files.find((file) => path.startsWith(`${file.path}/`));
  if (parent) {
    return refused(
      "validation_failed",
      `'${parent.path}' is a file, so nothing can be written below it. Choose another path, or move the file away with workspace.exec.`,
      { path, filePath: parent.path }
    );
  }
  return { status: "success", value: undefined };
}

/** Refuses a file that would take the workspace above its size limit. */
export function checkWorkspaceRoom(
  deps: WorkspaceToolDependencies,
  files: readonly WorkspaceFile[],
  path: string,
  byteSize: number
): TextFileStep<void> {
  const otherBytes = files
    .filter((file) => file.path !== path)
    .reduce((total, file) => total + file.byteSize, 0);
  const totalBytes = otherBytes + byteSize;
  if (totalBytes > deps.limits.maxWorkspaceBytes) {
    return refused(
      "handler_failed",
      `The workspace would hold ${totalBytes} bytes and may hold ${deps.limits.maxWorkspaceBytes} (maxWorkspaceBytes). Nothing was changed. Remove files that are no longer needed with workspace.exec, then call again.`,
      { totalBytes, maxWorkspaceBytes: deps.limits.maxWorkspaceBytes }
    );
  }
  return { status: "success", value: undefined };
}

/**
 * Stores the bytes of one text file and then its row. Two store writes: one object, one row.
 * The object a replaced file had stays until the workspace is cleaned up, as with every
 * workspace write.
 */
export async function storeTextFile(
  deps: WorkspaceToolDependencies & {
    fileStore: NonNullable<WorkspaceToolDependencies["fileStore"]>;
  },
  context: ToolExecutionContext,
  input: {
    toolName: string;
    workspace: ResolvedWorkspaceHandle;
    path: string;
    bytes: Uint8Array;
    existing: WorkspaceFile | undefined;
  }
): Promise<WorkspaceFile> {
  const { existing, workspace } = input;
  const checksum = createWorkspaceChecksum(input.bytes);
  // A file that was text keeps its type. Anything else becomes text, because it is text now.
  const mimeType =
    existing?.mimeType && isTextMimeType(existing.mimeType) ? existing.mimeType : "text/plain";
  // No command is queued. The id only keeps the object keys of this write apart from others.
  const objectKeyId = createPlatformId<"WorkspaceCommandId">("wcmd_file");
  const stored = await putWorkspaceFile(deps.fileStore, {
    clientInstanceId: context.clientInstanceId,
    conversationId: workspace.conversationId,
    workspaceId: workspace.handle.id,
    commandId: objectKeyId,
    path: input.path,
    bytes: input.bytes,
    checksum,
    mimeType
  });
  return upsertStoredWorkspaceFile(deps.store.executionWorkspaces, deps.fileStore, deps.telemetry, {
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.handle.id,
    path: input.path,
    objectKey: stored.objectKey,
    byteSize: input.bytes.byteLength,
    checksum,
    mimeType,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(existing ? { modifiedBy: input.toolName } : { source: input.toolName })
    },
    updatedAt: deps.now()
  });
}

function refused(
  code: "validation_failed" | "handler_failed",
  message: string,
  details?: Parameters<typeof failed>[2]
): { status: "failed"; result: ToolHandlerResult<never> } {
  return { status: "failed", result: failed(code, message, details) };
}
