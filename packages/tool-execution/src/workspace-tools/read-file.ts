import type { z } from "zod";
import {
  type ToolExecutionContext,
  type ToolHandlerResult,
  readObjectBytes
} from "@work-shape/catalyst-core";
import { defineTool } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_READ_DEFAULT_LINES,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import { failed, normalizeWorkspaceFilePath } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { findExistingWorkspaceFile } from "./workspace";
import { projectFolderTarget, readProjectFolderFile } from "./project-folder";
import { answerTextRead } from "./text-read-answer";

export function workspaceReadFileTool(deps: WorkspaceToolDependencies) {
  const answerSize = formatByteSize(deps.limits.maxReadPreviewBytes);
  const fileSize = formatByteSize(deps.limits.maxReadFileBytes);
  return defineTool({
    name: "workspace.read_file",
    title: { en: "Read workspace text", de: "Text einer Datei lesen" },
    summary: {
      en: "Reads a text file of the conversation.",
      de: "Liest eine Textdatei der Unterhaltung."
    },
    group: "files",
    icon: "text",
    effect: "reading",
    description: `Read UTF-8 text from a file in this conversation's execution workspace, by lines. Without offset and limit the answer starts at line 1 and holds up to ${WORKSPACE_READ_DEFAULT_LINES} lines or ${answerSize}, whichever comes first. It ends at a whole line and lines carry no number prefix. The answer says which lines it holds (startLine, endLine) and how many the file has (totalLines). When lines remain, truncated is true and nextOffset is the line to continue with: call again with offset set to nextOffset until nextOffset is absent. One exception: a single line that is longer than one answer is cut inside the line. The answer then has lineCut true and a hint, nextOffset skips the rest of that line, and the rest is read with a command in workspace.exec. Binary files and files above ${fileSize} are refused; read those with a command in workspace.exec.`,
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
  const project = await projectFolderTarget(deps, context, input.path);
  if (project) return readProjectFolderFile(deps, project, input);
  const normalizedPath = normalizeWorkspaceFilePath(input.path, deps.limits);
  if (normalizedPath.status === "failed") {
    return normalizedPath.result;
  }
  if (!deps.objectStore) {
    return failed(
      "handler_failed",
      "Workspace file bytes are not available on this instance. Read the file with a command in workspace.exec."
    );
  }
  const found = await findExistingWorkspaceFile(deps, context, normalizedPath.value);
  if (found.status === "failed") {
    return found.result;
  }
  const { file, workspaceId } = found.value;
  if (file.byteSize > deps.limits.maxReadFileBytes) {
    return failed(
      "handler_failed",
      `Workspace file '${file.path}' has ${file.byteSize} bytes, more than workspace.read_file reads (maxReadFileBytes, ${deps.limits.maxReadFileBytes} bytes). Read it in parts with a command in workspace.exec, for example sed -n '1,200p' or head -c.`,
      {
        path: file.path,
        byteSize: file.byteSize,
        maxReadFileBytes: deps.limits.maxReadFileBytes
      }
    );
  }

  const bytes = await readObjectBytes(deps.objectStore, file.objectKey);
  return answerTextRead(deps, input, { ...file, workspaceId }, bytes);
}

function formatByteSize(bytes: number): string {
  const mebibyte = 1024 * 1024;
  if (bytes >= mebibyte && bytes % mebibyte === 0) {
    return `${bytes / mebibyte} MiB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
}
