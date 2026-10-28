import type { z } from "zod";
import type { ToolHandlerResult } from "@work-shape/catalyst-core";
import type { workspaceEditFileInputSchema } from "../workspace-file-write-schemas";
import { applyWorkspaceTextEdits, type WorkspaceTextEditFailure } from "../workspace-text-edits";
import { decodeTextFile, failed, type ValidationResult } from "../workspace-tool-results";

/** The bytes of a text file with the edits applied, or why they do not apply. */
export function editTextBytes(
  path: string,
  storedBytes: Uint8Array,
  mimeType: string | undefined,
  edits: z.infer<typeof workspaceEditFileInputSchema>["edits"]
): ValidationResult<Uint8Array> {
  const decoded = decodeTextFile(storedBytes, mimeType);
  if (decoded.status === "failed") {
    return {
      status: "failed",
      result: failed(
        "handler_failed",
        `'${path}' is not a UTF-8 text file, and workspace.edit_file changes text only. Change the file with a command in workspace.exec.`,
        { path, ...(mimeType ? { mimeType } : {}) }
      )
    };
  }
  const edited = applyWorkspaceTextEdits(decoded.value, edits);
  if (edited.status === "failed") {
    return { status: "failed", result: editRefusal(path, edited.failure) };
  }
  // Decoding drops a byte order mark. The file keeps the one it had.
  const editedBytes = new TextEncoder().encode(edited.text);
  return {
    status: "success",
    value: startsWithByteOrderMark(storedBytes)
      ? concatBytes(UTF8_BYTE_ORDER_MARK, editedBytes)
      : editedBytes
  };
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
