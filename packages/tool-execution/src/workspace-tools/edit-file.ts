import type { z } from "zod";
import {
  type ToolExecutionContext,
  type ToolHandlerResult,
  readObjectBytes
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_EDIT_MAX_EDITS,
  workspaceEditFileInputJsonSchema,
  workspaceEditFileInputSchema,
  workspaceEditFileOutputSchema
} from "../workspace-file-write-schemas";
import { applyWorkspaceTextEdits, type WorkspaceTextEditFailure } from "../workspace-text-edits";
import { decodeTextFile, failed } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { checkWorkspaceRoom, resolveTextFilePath, storeTextFile } from "./stored-text-file";
import { resolveWorkspaceHandle } from "./workspace";

export function workspaceEditFileTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.edit_file",
    title: { en: "Edit workspace file", de: "Datei bearbeiten" },
    summary: {
      en: "Changes exact passages of a file in the conversation.",
      de: "Ändert genaue Stellen einer Datei in der Unterhaltung."
    },
    group: "files",
    icon: "text",
    effect: "changing",
    // Runs on the agent's own call. Without a mode the instance default for changes would apply.
    permission: { mode: "allow" },
    description:
      "Replace exact text in one /workspace text file. Each oldText must occur exactly once in the file as it is now; all edits apply or none. For a new file or a full rewrite use workspace.write_file. Search, move, delete and scripts stay with workspace.exec.",
    inputSchema: workspaceEditFileInputSchema,
    inputJsonSchema: workspaceEditFileInputJsonSchema,
    outputSchema: workspaceEditFileOutputSchema,
    execute(input, context) {
      return editWorkspaceFile(deps, input, context);
    }
  });
}

export async function editWorkspaceFile(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceEditFileInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceEditFileOutputSchema>>> {
  const { fileStore, objectStore } = deps;
  if (!fileStore || !objectStore) {
    return failed(
      "handler_failed",
      "This instance has no storage for workspace files, so workspace.edit_file cannot run. Tell the user; an operator has to configure it."
    );
  }
  const path = resolveTextFilePath(input.path, deps.limits);
  if (path.status === "failed") {
    return path.result;
  }
  if (input.edits.length > WORKSPACE_EDIT_MAX_EDITS) {
    return failed(
      "validation_failed",
      `workspace.edit_file takes at most ${WORKSPACE_EDIT_MAX_EDITS} edits per call (WORKSPACE_EDIT_MAX_EDITS) and got ${input.edits.length}. Nothing was changed. Send the edits in several calls.`,
      { path: path.value, edits: input.edits.length, maxEdits: WORKSPACE_EDIT_MAX_EDITS }
    );
  }
  const binaryEdit = input.edits.findIndex((edit) => edit.newText.includes("\0"));
  if (binaryEdit !== -1) {
    return failed(
      "validation_failed",
      `edits[${binaryEdit}].newText holds a NUL character, and workspace.edit_file writes text only. Nothing was changed. Change a binary file with a command in workspace.exec.`,
      { path: path.value, edit: binaryEdit }
    );
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.handle.id
  });
  const existing = files.find((file) => file.path === path.value);
  if (!existing) {
    return failed(
      "handler_failed",
      `Workspace file '${path.value}' was not found. Call workspace.list_files to see the files, or create the file with workspace.write_file.`,
      { path: path.value }
    );
  }
  // The file is searched as a whole, so it is one the reading tool takes as well.
  if (existing.byteSize > deps.limits.maxReadFileBytes) {
    return failed(
      "handler_failed",
      `'${path.value}' has ${existing.byteSize} bytes and workspace.edit_file edits files of at most ${deps.limits.maxReadFileBytes} (maxReadFileBytes). Nothing was changed. Change the file with a command in workspace.exec.`,
      {
        path: path.value,
        byteSize: existing.byteSize,
        maxReadFileBytes: deps.limits.maxReadFileBytes
      }
    );
  }
  const storedBytes = await readObjectBytes(objectStore, existing.objectKey);
  const decoded = decodeTextFile(storedBytes, existing.mimeType);
  if (decoded.status === "failed") {
    return failed(
      "handler_failed",
      `'${path.value}' is not a UTF-8 text file, and workspace.edit_file changes text only. Change the file with a command in workspace.exec.`,
      { path: path.value, ...(existing.mimeType ? { mimeType: existing.mimeType } : {}) }
    );
  }

  const edited = applyWorkspaceTextEdits(decoded.value, input.edits);
  if (edited.status === "failed") {
    return editRefusal(path.value, edited.failure);
  }
  // Decoding drops a byte order mark. The file keeps the one it had.
  const editedBytes = new TextEncoder().encode(edited.text);
  const bytes = startsWithByteOrderMark(storedBytes)
    ? concatBytes(UTF8_BYTE_ORDER_MARK, editedBytes)
    : editedBytes;
  const room = checkWorkspaceRoom(deps, files, path.value, bytes.byteLength);
  if (room.status === "failed") {
    return room.result;
  }
  const file = await storeTextFile({ ...deps, fileStore }, context, {
    toolName: "workspace.edit_file",
    workspace: workspace.value,
    path: path.value,
    bytes,
    existing
  });
  const editsApplied = input.edits.length;
  return toolSuccess(
    { path: file.path, byteSize: file.byteSize, editsApplied },
    {
      // Names, sizes and a count. Neither oldText nor newText is in an audit event or a run.
      auditSummary: {
        action: "workspace.edit_file",
        subject: file.path,
        metadata: {
          byteSizeBefore: existing.byteSize,
          byteSizeAfter: file.byteSize,
          editCount: editsApplied
        }
      }
    }
  );
}

const UTF8_BYTE_ORDER_MARK = new Uint8Array([0xef, 0xbb, 0xbf]);

function startsWithByteOrderMark(bytes: Uint8Array): boolean {
  return UTF8_BYTE_ORDER_MARK.every((byte, index) => bytes[index] === byte);
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
}

/**
 * What the agent reads when its edits were refused: which edit, what the file has, and the
 * next step. An edit is named by its position in `edits`; its text is not repeated.
 */
function editRefusal(path: string, failure: WorkspaceTextEditFailure): ToolHandlerResult<never> {
  const edit = `edits[${failure.edit}]`;
  switch (failure.kind) {
    case "empty_old_text":
      return failed(
        "validation_failed",
        `${edit}.oldText is empty. Nothing was changed. Give the exact text to replace, or write the whole file with workspace.write_file.`,
        { path, edit: failure.edit }
      );
    case "no_change":
      return failed(
        "validation_failed",
        `${edit} replaces text with the same text. Nothing was changed. Leave the edit out or change its newText.`,
        { path, edit: failure.edit }
      );
    case "not_found":
      return failed(
        "handler_failed",
        `${edit}.oldText was not found in '${path}'. Nothing was changed. Read the file again with workspace.read_file and copy the text from it: it has to match exactly, including spaces, tabs and line breaks.${
          failure.nearLine === undefined
            ? ""
            : ` The file has this text at line ${failure.nearLine} with other line endings or blanks at line ends.`
        }`,
        {
          path,
          edit: failure.edit,
          occurrences: 0,
          ...(failure.nearLine === undefined ? {} : { nearLine: failure.nearLine })
        }
      );
    case "not_unique":
      return failed(
        "handler_failed",
        `${edit}.oldText occurs ${failure.occurrences} times in '${path}', ${
          failure.occurrences > failure.lines.length ? "first at lines" : "at lines"
        } ${failure.lines.join(", ")}. Nothing was changed. Add surrounding lines to oldText until it occurs exactly once.`,
        { path, edit: failure.edit, occurrences: failure.occurrences, lines: failure.lines }
      );
    case "overlap":
      return failed(
        "validation_failed",
        `${edit} and edits[${failure.other}] change the same text in '${path}'. Nothing was changed. Merge them into one edit.`,
        { path, edit: failure.edit, other: failure.other }
      );
  }
}
