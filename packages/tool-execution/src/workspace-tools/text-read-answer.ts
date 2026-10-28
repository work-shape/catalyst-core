import type { z } from "zod";
import type { ToolHandlerResult } from "@work-shape/catalyst-core";
import { toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_READ_DEFAULT_LINES,
  type workspaceReadFileInputSchema,
  type workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import { decodeTextFile, failed } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { readLineRange, type LineRange } from "./read-lines";

/** The answer of a read: the lines asked for of a file's bytes, or why there are none. */
export function answerTextRead(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceReadFileInputSchema>,
  file: {
    workspaceId: string;
    path: string;
    byteSize: number;
    mimeType?: string;
    /** A file of the project folder: its version. */
    version?: number;
    /**
     * What the audit record names instead of the path: a project file's path can name a client,
     * so its read is recorded by the project and the version.
     */
    auditSubject?: string;
  },
  bytes: Uint8Array
): ToolHandlerResult<z.infer<typeof workspaceReadFileOutputSchema>> {
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
      workspaceId: file.workspaceId,
      path: file.path,
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      ...(file.version !== undefined ? { version: file.version } : {}),
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
        subject: file.auditSubject ?? file.path,
        metadata: {
          ...(file.version !== undefined ? { version: file.version } : {}),
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
