import type { z } from "zod";
import {
  type ExecutionWorkspaceId,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type WorkspaceFile,
  createPlatformId
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  applyWorkspacePatchToText,
  parseWorkspaceApplyPatch,
  type WorkspacePatchChange
} from "../workspace-apply-patch";
import { upsertStoredWorkspaceFile } from "../workspace-file-bytes";
import {
  workspaceApplyPatchInputSchema,
  workspaceApplyPatchOutputSchema
} from "../workspace-tool-schemas";
import {
  createWorkspaceChecksum,
  decodeTextFile,
  failed,
  failedValidationResult,
  validationFailed,
  type ValidationResult
} from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { resolveWorkspaceHandle } from "./workspace";

export function workspaceApplyPatchTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.apply_patch",
    description:
      "Apply a unified diff patch to text files in /workspace. Supports create, update, and delete for workspace paths; rejects path traversal, renames, and binary files. Use workspace.exec for normal shell work and scripts.",
    inputSchema: workspaceApplyPatchInputSchema,
    outputSchema: workspaceApplyPatchOutputSchema,
    execute(input, context) {
      return applyWorkspacePatch(deps, input, context);
    }
  });
}

export async function applyWorkspacePatch(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceApplyPatchInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceApplyPatchOutputSchema>>> {
  if (!deps.fileStore || !deps.objectStore) {
    return failed("handler_failed", "Workspace patch editing is not configured");
  }
  const changes = parseWorkspaceApplyPatch(input.patch, deps.limits);
  if (changes.status === "failed") {
    return changes.result;
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const prepared = await preparePatchChanges(deps, {
    changes: changes.value,
    context,
    workspaceId: workspace.value.handle.id
  });
  if (prepared.status === "failed") {
    return prepared.result;
  }
  const capacity = validateWorkspaceCapacity(deps, prepared.value.existingFiles, {
    writes: prepared.value.writes,
    deletes: prepared.value.deletes
  });
  if (capacity.status === "failed") {
    return capacity.result;
  }

  // A patch is not a workspace command: nothing is queued, leased or run. Like an import, it
  // stores no command row, so its files name no last command. The id only keeps the object
  // keys of this patch apart.
  const patchObjectKeyId = createPlatformId<"WorkspaceCommandId">("wcmd_patch");
  const changedFiles = [];
  for (const write of prepared.value.writes) {
    const stored = await deps.fileStore.putWorkspaceFile({
      clientInstanceId: context.clientInstanceId,
      conversationId: workspace.value.conversationId,
      workspaceId: workspace.value.handle.id,
      commandId: patchObjectKeyId,
      path: write.path,
      bytes: write.bytes,
      checksum: write.checksum,
      mimeType: write.mimeType
    });
    const file = await upsertStoredWorkspaceFile(
      deps.store.executionWorkspaces,
      deps.fileStore,
      deps.telemetry,
      {
        clientInstanceId: context.clientInstanceId,
        workspaceId: workspace.value.handle.id,
        path: write.path,
        objectKey: stored.objectKey,
        byteSize: write.bytes.byteLength,
        checksum: write.checksum,
        mimeType: write.mimeType,
        metadata: {
          ...(write.existing?.metadata ?? {}),
          ...(write.existing
            ? { modifiedBy: "workspace.apply_patch" }
            : { source: "workspace.apply_patch" })
        },
        updatedAt: deps.now()
      }
    );
    changedFiles.push({
      path: file.path,
      byteSize: file.byteSize,
      checksum: file.checksum,
      ...(file.mimeType ? { mimeType: file.mimeType } : {})
    });
  }

  const deletedFiles = [];
  for (const deletion of prepared.value.deletes) {
    const deleted = await deps.store.executionWorkspaces.deleteWorkspaceFile({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.value.handle.id,
      path: deletion.path,
      deletedAt: deps.now()
    });
    if (deleted) {
      deletedFiles.push({ path: deleted.path });
    }
  }

  return toolSuccess(
    {
      workspaceId: workspace.value.handle.id,
      changedFiles,
      deletedFiles
    },
    {
      auditSummary: {
        action: "workspace.apply_patch",
        subject: workspace.value.handle.id,
        metadata: {
          changedCount: changedFiles.length,
          deletedCount: deletedFiles.length
        }
      }
    }
  );
}

async function preparePatchChanges(
  deps: WorkspaceToolDependencies,
  input: {
    changes: readonly WorkspacePatchChange[];
    context: ToolExecutionContext;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<
  ValidationResult<{
    existingFiles: WorkspaceFile[];
    writes: Array<{
      path: string;
      bytes: Uint8Array;
      checksum: string;
      mimeType: string;
      existing?: WorkspaceFile;
    }>;
    deletes: Array<{
      path: string;
    }>;
  }>
> {
  if (!deps.objectStore) {
    return failedValidationResult("Workspace file bytes are not available");
  }
  const existingFiles = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: input.context.clientInstanceId,
    workspaceId: input.workspaceId
  });
  const filesByPath = new Map(existingFiles.map((file) => [file.path, file]));
  const writes = [];
  const deletes = [];

  for (const change of input.changes) {
    const existing = filesByPath.get(change.path);
    if (change.operation === "create" && existing) {
      return validationFailed("Workspace patch cannot create a file that already exists", {
        path: change.path
      });
    }
    if (change.operation !== "create" && !existing) {
      return validationFailed("Workspace patch target file was not found", {
        path: change.path
      });
    }

    const currentText = existing
      ? await readPatchTargetText(deps, existing)
      : { status: "success" as const, value: "" };
    if (currentText.status === "failed") {
      return currentText;
    }
    const patched = applyWorkspacePatchToText(currentText.value, change);
    if (patched.status === "failed") {
      return patched;
    }
    if (change.operation === "delete") {
      if (patched.value.length > 0) {
        return validationFailed("Workspace delete patch must remove the entire file", {
          path: change.path
        });
      }
      deletes.push({ path: change.path });
      continue;
    }

    const bytes = new TextEncoder().encode(patched.value);
    writes.push({
      path: change.path,
      bytes,
      checksum: createWorkspaceChecksum(bytes),
      mimeType: existing?.mimeType ?? "text/plain",
      ...(existing ? { existing } : {})
    });
  }

  return {
    status: "success",
    value: {
      existingFiles,
      writes,
      deletes
    }
  };
}

async function readPatchTargetText(
  deps: WorkspaceToolDependencies,
  file: WorkspaceFile
): Promise<ValidationResult<string>> {
  if (!deps.objectStore) {
    return failedValidationResult("Workspace file bytes are not available");
  }
  const bytes = await deps.objectStore.getObject(file.objectKey);
  return decodeTextFile(bytes, file.mimeType);
}

function validateWorkspaceCapacity(
  deps: WorkspaceToolDependencies,
  existingFiles: readonly WorkspaceFile[],
  changes: {
    writes: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
    deletes: ReadonlyArray<{ path: string }>;
  }
): ValidationResult<void> {
  const writePaths = new Set(changes.writes.map((file) => file.path));
  const deletePaths = new Set(changes.deletes.map((file) => file.path));
  const existingBytes = existingFiles
    .filter((file) => !writePaths.has(file.path) && !deletePaths.has(file.path))
    .reduce((total, file) => total + file.byteSize, 0);
  const totalBytes =
    existingBytes + changes.writes.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (totalBytes > deps.limits.maxWorkspaceBytes) {
    return validationFailed("Patched files would exceed the workspace size limit", {
      totalBytes,
      maxWorkspaceBytes: deps.limits.maxWorkspaceBytes
    });
  }
  return {
    status: "success",
    value: undefined
  };
}
