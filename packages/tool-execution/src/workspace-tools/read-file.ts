import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import {
  boundTextByBytes,
  decodeTextFile,
  failed,
  normalizeWorkspaceFilePath
} from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { findWorkspaceFile } from "./workspace";

export function workspaceReadFileTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.read_file",
    description:
      "Read a bounded UTF-8 preview of a text file from the conversation execution workspace.",
    inputSchema: workspaceReadFileInputSchema,
    outputSchema: workspaceReadFileOutputSchema,
    execute(input, context) {
      return readWorkspaceFile(deps, input, context);
    }
  });
}

export async function readWorkspaceFile(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceReadFileInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceReadFileOutputSchema>>> {
  const normalizedPath = normalizeWorkspaceFilePath(input.path, deps.limits);
  if (normalizedPath.status === "failed") {
    return normalizedPath.result;
  }
  if (!deps.objectStore) {
    return failed("handler_failed", "Workspace file bytes are not available");
  }
  const file = await findWorkspaceFile(deps, context, normalizedPath.value);
  if (file.status === "failed") {
    return file.result;
  }
  if (file.value.file.byteSize > deps.limits.maxReadFileBytes) {
    return failed("handler_failed", "Workspace file is too large to preview", {
      path: file.value.file.path,
      byteSize: file.value.file.byteSize,
      maxReadFileBytes: deps.limits.maxReadFileBytes
    });
  }

  const bytes = await deps.objectStore.getObject(file.value.file.objectKey);
  const decoded = decodeTextFile(bytes, file.value.file.mimeType);
  if (decoded.status === "failed") {
    return decoded.result;
  }
  const preview = boundTextByBytes(decoded.value, deps.limits.maxReadPreviewBytes);
  return toolSuccess(
    {
      workspaceId: file.value.workspaceId,
      path: file.value.file.path,
      byteSize: file.value.file.byteSize,
      mimeType: file.value.file.mimeType,
      encoding: "utf-8",
      contentPreview: preview.text,
      truncated: preview.truncated
    },
    {
      auditSummary: {
        action: "workspace.read_file",
        subject: file.value.file.path,
        metadata: {
          byteSize: file.value.file.byteSize,
          truncated: preview.truncated
        }
      }
    }
  );
}
