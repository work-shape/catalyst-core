import type { z } from "zod";
import {
  type ToolExecutionContext,
  type ToolHandlerResult,
  readObjectBytes
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_READ_DEFAULT_LINES,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import { decodeTextFile, failed, normalizeWorkspaceFilePath } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { readLineRange, type LineRange } from "./read-lines";
import { findExistingWorkspaceFile } from "./workspace";

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
  const decoded = decodeTextFile(bytes, file.mimeType);
  if (decoded.status === "failed") {
    return decoded.result;
  }
  const offset = input.offset ?? 1;
  const range = readLineRange(decoded.value, {
    offset,
    limit: input.limit ?? WORKSPACE_READ_DEFAULT_LINES,
    maxBytes: deps.limits.maxReadPreviewBytes
  });
  if (range.status === "past_end") {
    return failed(
      "validation_failed",
      range.totalLines === 0
        ? `Offset ${offset} is past the end of '${file.path}', which is empty. There is nothing to read.`
        : `Offset ${offset} is past the end of '${file.path}', which has ${range.totalLines} lines. Use an offset from 1 to ${range.totalLines}.`,
      { path: file.path, offset, totalLines: range.totalLines }
    );
  }
  const truncated = range.nextOffset !== undefined || range.cutLine !== undefined;
  const hint = continuationHint(range);
  return toolSuccess(
    {
      workspaceId,
      path: file.path,
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      encoding: "utf-8",
      contentPreview: range.content,
      truncated,
      startLine: range.startLine,
      endLine: range.endLine,
      totalLines: range.totalLines,
      ...(range.nextOffset !== undefined ? { nextOffset: range.nextOffset } : {}),
      ...(range.cutLine ? { lineCut: true } : {}),
      ...(hint ? { hint } : {})
    },
    {
      auditSummary: {
        action: "workspace.read_file",
        subject: file.path,
        metadata: {
          byteSize: file.byteSize,
          startLine: range.startLine,
          endLine: range.endLine,
          totalLines: range.totalLines,
          truncated,
          ...(range.cutLine ? { lineCut: true } : {})
        }
      }
    }
  );
}

function continuationHint(range: Extract<LineRange, { status: "read" }>): string | undefined {
  const next =
    range.nextOffset !== undefined
      ? `Call workspace.read_file again with offset ${range.nextOffset} to continue.`
      : undefined;
  if (range.cutLine) {
    const cut = `Line ${range.cutLine.line} has ${range.cutLine.lineBytes} bytes, more than one answer holds, and was cut after ${range.cutLine.returnedBytes} bytes. Read the rest of that line with a command in workspace.exec, for example sed -n '${range.cutLine.line}p' piped to cut -c.`;
    return next ? `${cut} ${next}` : cut;
  }
  return next
    ? `Lines ${range.startLine} to ${range.endLine} of ${range.totalLines}. ${next}`
    : undefined;
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
