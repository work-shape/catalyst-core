import type { z } from "zod";
import {
  type ConversationId,
  type ExecutionWorkspaceId,
  type ManagedFileId,
  type ToolExecutionContext,
  type ToolHandlerResult,
  createPlatformId,
  isAppError
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { upsertStoredWorkspaceFile } from "../workspace-file-bytes";
import {
  workspaceImportFilesInputSchema,
  workspaceImportFilesOutputSchema
} from "../workspace-tool-schemas";
import {
  createWorkspaceChecksum,
  failed,
  failedValidationResult,
  normalizeWorkspaceFilePath,
  validationFailed,
  workspacePathFromFilename,
  type ValidationResult
} from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { resolveWorkspaceHandle } from "./workspace";

export function workspaceImportFilesTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.import_files",
    description:
      "Copy uploaded managed conversation files into the execution workspace by fileId. The result returns a shell-safe workspace path in importedFiles[].path; use that exact path in workspace.exec and do not invent shortened filenames. This uses managed file access and never exposes object-storage credentials.",
    inputSchema: workspaceImportFilesInputSchema,
    outputSchema: workspaceImportFilesOutputSchema,
    execute(input, context) {
      return importWorkspaceFiles(deps, input, context);
    }
  });
}

export async function importWorkspaceFiles(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceImportFilesInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceImportFilesOutputSchema>>> {
  if (!deps.fileStore || !deps.sourceFileReader) {
    return failed("handler_failed", "Workspace source file import is not configured");
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }

  const files = await loadImportSourceFiles(deps, input, context, workspace.value.conversationId);
  if (files.status === "failed") {
    return files.result;
  }
  const capacity = await validateImportCapacity(
    deps,
    workspace.value.handle.id,
    context,
    files.value
  );
  if (capacity.status === "failed") {
    return capacity.result;
  }

  const importedFiles = [];
  for (const file of files.value) {
    const stored = await deps.fileStore.putWorkspaceFile({
      clientInstanceId: context.clientInstanceId,
      conversationId: workspace.value.conversationId,
      workspaceId: workspace.value.handle.id,
      commandId: createPlatformId<"WorkspaceCommandId">("wcmd_import"),
      path: file.path,
      bytes: file.bytes,
      checksum: file.checksum,
      mimeType: file.mimeType
    });
    await upsertStoredWorkspaceFile(
      deps.store.executionWorkspaces,
      deps.fileStore,
      deps.telemetry,
      {
        clientInstanceId: context.clientInstanceId,
        workspaceId: workspace.value.handle.id,
        path: file.path,
        objectKey: stored.objectKey,
        byteSize: file.byteSize,
        checksum: file.checksum,
        mimeType: file.mimeType,
        metadata: {
          source: "managed_file_upload",
          sourceFileId: file.fileId,
          filename: file.filename
        },
        updatedAt: deps.now()
      }
    );
    importedFiles.push({
      fileId: file.fileId,
      path: file.path,
      filename: file.filename,
      byteSize: file.byteSize,
      checksum: file.checksum,
      mimeType: file.mimeType
    });
  }

  return toolSuccess(
    {
      workspaceId: workspace.value.handle.id,
      importedFiles
    },
    {
      auditSummary: {
        action: "workspace.import_files",
        subject: workspace.value.handle.id,
        metadata: {
          count: importedFiles.length
        }
      }
    }
  );
}

async function loadImportSourceFiles(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceImportFilesInputSchema>,
  context: ToolExecutionContext,
  conversationId: ConversationId
): Promise<
  ValidationResult<
    Array<{
      fileId: ManagedFileId;
      path: string;
      filename: string;
      mimeType?: string;
      byteSize: number;
      checksum: string;
      bytes: Uint8Array;
    }>
  >
> {
  if (!deps.sourceFileReader) {
    return failedValidationResult("Workspace source file import is not configured");
  }

  const seenPaths = new Set<string>();
  const files = [];
  for (const fileInput of input.files) {
    let source;
    try {
      source = await deps.sourceFileReader.readSourceFile({
        clientInstanceId: context.clientInstanceId,
        conversationId,
        fileId: fileInput.fileId
      });
    } catch (error) {
      return {
        status: "failed",
        result: failed(
          "handler_failed",
          isAppError(error) ? error.message : "Managed source file is not available",
          { fileId: fileInput.fileId }
        )
      };
    }
    const normalizedPath = normalizeWorkspaceFilePath(
      fileInput.path ?? workspacePathFromFilename(source.filename, source.fileId),
      deps.limits
    );
    if (normalizedPath.status === "failed") {
      return normalizedPath;
    }
    if (seenPaths.has(normalizedPath.value)) {
      return validationFailed("Imported workspace file paths must be unique", {
        path: normalizedPath.value
      });
    }
    seenPaths.add(normalizedPath.value);
    const checksum = createWorkspaceChecksum(source.bytes);
    files.push({
      fileId: source.fileId,
      path: normalizedPath.value,
      filename: source.filename,
      mimeType: source.mimeType,
      byteSize: source.bytes.byteLength,
      checksum,
      bytes: source.bytes
    });
  }
  return {
    status: "success",
    value: files
  };
}

async function validateImportCapacity(
  deps: WorkspaceToolDependencies,
  workspaceId: ExecutionWorkspaceId,
  context: ToolExecutionContext,
  files: ReadonlyArray<{ path: string; byteSize: number }>
): Promise<ValidationResult<void>> {
  const existingFiles = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId
  });
  const importsByPath = new Map(files.map((file) => [file.path, file.byteSize]));
  const existingBytes = existingFiles
    .filter((file) => !importsByPath.has(file.path))
    .reduce((total, file) => total + file.byteSize, 0);
  const totalBytes = existingBytes + files.reduce((total, file) => total + file.byteSize, 0);
  if (totalBytes > deps.limits.maxWorkspaceBytes) {
    return validationFailed("Imported files would exceed the workspace size limit", {
      totalBytes,
      maxWorkspaceBytes: deps.limits.maxWorkspaceBytes
    });
  }
  return {
    status: "success",
    value: undefined
  };
}
