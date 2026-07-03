import type { WorkspaceCommandServiceLimits } from "./workspace-tool-schemas";
import { normalizeWorkspaceFilePath } from "./workspace-tool-results";
import { validationFailed, type ValidationResult } from "./workspace-tool-results";

export interface WorkspacePatchChange {
  operation: "create" | "update" | "delete";
  path: string;
  hunks: WorkspacePatchHunk[];
}

interface WorkspacePatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: WorkspacePatchLine[];
}

type WorkspacePatchLine =
  | { kind: "context"; text: string }
  | { kind: "delete"; text: string }
  | { kind: "add"; text: string };

export function parseWorkspaceApplyPatch(
  patch: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<WorkspacePatchChange[]> {
  if (patch.length > limits.maxApplyPatchBytes) {
    return validationFailed("Workspace patch is too large", {
      maxApplyPatchBytes: limits.maxApplyPatchBytes
    });
  }
  if (patch.includes("\0")) {
    return validationFailed("Workspace patch cannot contain NUL bytes");
  }

  const lines = splitPatchLines(patch);
  const changes: WorkspacePatchChange[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.startsWith("diff --git ") || isGitMetadataLine(line)) {
      index += 1;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      return validationFailed("Workspace patch cannot apply binary file changes");
    }
    if (!line.startsWith("--- ")) {
      return validationFailed("Workspace patch must use unified diff file headers", {
        line: index + 1
      });
    }

    const oldPath = normalizePatchHeaderPath(line.slice(4), limits);
    if (oldPath.status === "failed") {
      return oldPath;
    }
    index += 1;
    const next = lines[index] ?? "";
    if (!next.startsWith("+++ ")) {
      return validationFailed("Workspace patch file header is missing a +++ line", {
        line: index + 1
      });
    }
    const newPath = normalizePatchHeaderPath(next.slice(4), limits);
    if (newPath.status === "failed") {
      return newPath;
    }
    index += 1;

    const operation = resolvePatchOperation(oldPath.value, newPath.value);
    if (operation.status === "failed") {
      return operation;
    }

    const hunks: WorkspacePatchHunk[] = [];
    while (index < lines.length) {
      const hunkLine = lines[index] ?? "";
      if (hunkLine.startsWith("--- ") || hunkLine.startsWith("diff --git ")) {
        break;
      }
      if (hunkLine.trim().length === 0 || isGitMetadataLine(hunkLine)) {
        index += 1;
        continue;
      }
      if (hunkLine.startsWith("Binary files ") || hunkLine.startsWith("GIT binary patch")) {
        return validationFailed("Workspace patch cannot apply binary file changes");
      }
      if (!hunkLine.startsWith("@@ ")) {
        return validationFailed("Workspace patch hunk is missing an @@ header", {
          line: index + 1,
          path: operation.value.path
        });
      }
      const hunk = parseHunk(lines, index, operation.value.path);
      if (hunk.status === "failed") {
        return hunk;
      }
      hunks.push(hunk.value.hunk);
      index = hunk.value.nextIndex;
    }

    if (hunks.length === 0) {
      return validationFailed("Workspace patch file change must include at least one hunk", {
        path: operation.value.path
      });
    }
    changes.push({
      operation: operation.value.operation,
      path: operation.value.path,
      hunks
    });
  }

  if (changes.length === 0) {
    return validationFailed("Workspace patch must include at least one file change");
  }
  const seenPaths = new Set<string>();
  for (const change of changes) {
    if (seenPaths.has(change.path)) {
      return validationFailed("Workspace patch must not modify the same path more than once", {
        path: change.path
      });
    }
    seenPaths.add(change.path);
  }
  return {
    status: "success",
    value: changes
  };
}

export function applyWorkspacePatchToText(
  existingText: string,
  change: WorkspacePatchChange
): ValidationResult<string> {
  const existing = splitTextLines(existingText);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of change.hunks) {
    const startIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (startIndex < cursor || startIndex > existing.lines.length) {
      return validationFailed("Workspace patch hunk does not apply at the expected line", {
        path: change.path,
        line: hunk.oldStart
      });
    }
    output.push(...existing.lines.slice(cursor, startIndex));
    cursor = startIndex;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      const current = existing.lines[cursor];
      if (current !== line.text) {
        return validationFailed("Workspace patch context did not match file content", {
          path: change.path,
          line: cursor + 1
        });
      }
      if (line.kind === "context") {
        output.push(current);
      }
      cursor += 1;
    }
  }

  output.push(...existing.lines.slice(cursor));
  if (output.length === 0) {
    return {
      status: "success",
      value: ""
    };
  }
  return {
    status: "success",
    value: `${output.join("\n")}\n`
  };
}

function parseHunk(
  lines: readonly string[],
  hunkIndex: number,
  filePath: string
): ValidationResult<{ hunk: WorkspacePatchHunk; nextIndex: number }> {
  const header = lines[hunkIndex] ?? "";
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(header);
  if (!match) {
    return validationFailed("Workspace patch hunk header is invalid", {
      line: hunkIndex + 1,
      path: filePath
    });
  }
  const hunk: WorkspacePatchHunk = {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    lines: []
  };

  let index = hunkIndex + 1;
  let oldLineCount = 0;
  let newLineCount = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("@@ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
      break;
    }
    if (line === "\\ No newline at end of file") {
      index += 1;
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      hunk.lines.push({ kind: "context", text });
      oldLineCount += 1;
      newLineCount += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "delete", text });
      oldLineCount += 1;
    } else if (marker === "+") {
      hunk.lines.push({ kind: "add", text });
      newLineCount += 1;
    } else {
      return validationFailed("Workspace patch hunk line must start with space, +, or -", {
        line: index + 1,
        path: filePath
      });
    }
    index += 1;
  }

  if (oldLineCount !== hunk.oldCount || newLineCount !== hunk.newCount) {
    return validationFailed("Workspace patch hunk line counts do not match the header", {
      path: filePath,
      oldCount: hunk.oldCount,
      actualOldCount: oldLineCount,
      newCount: hunk.newCount,
      actualNewCount: newLineCount
    });
  }
  return {
    status: "success",
    value: {
      hunk,
      nextIndex: index
    }
  };
}

function resolvePatchOperation(
  oldPath: string | undefined,
  newPath: string | undefined
): ValidationResult<{ operation: WorkspacePatchChange["operation"]; path: string }> {
  if (oldPath === undefined && newPath === undefined) {
    return validationFailed("Workspace patch cannot have both old and new paths as /dev/null");
  }
  if (oldPath === undefined) {
    return {
      status: "success",
      value: {
        operation: "create",
        path: newPath!
      }
    };
  }
  if (newPath === undefined) {
    return {
      status: "success",
      value: {
        operation: "delete",
        path: oldPath
      }
    };
  }
  if (oldPath !== newPath) {
    return validationFailed("Workspace patch does not support renames or copies", {
      oldPath,
      newPath
    });
  }
  return {
    status: "success",
    value: {
      operation: "update",
      path: oldPath
    }
  };
}

function normalizePatchHeaderPath(
  headerValue: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string | undefined> {
  const rawPath = headerValue.split("\t", 1)[0]?.trim() ?? "";
  if (rawPath === "/dev/null") {
    return {
      status: "success",
      value: undefined
    };
  }
  const workspacePath = stripWorkspacePatchPrefix(rawPath);
  if (workspacePath.status === "failed") {
    return workspacePath;
  }
  const normalized = normalizeWorkspaceFilePath(workspacePath.value, limits);
  if (normalized.status === "failed") {
    return normalized;
  }
  return {
    status: "success",
    value: normalized.value
  };
}

function stripWorkspacePatchPrefix(rawPath: string): ValidationResult<string> {
  if (rawPath === "/workspace") {
    return validationFailed("Workspace patch path must name a file");
  }
  if (rawPath.startsWith("/workspace/")) {
    return {
      status: "success",
      value: rawPath.slice("/workspace/".length)
    };
  }
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) {
    return validationFailed("Workspace patch path must be under /workspace", {
      path: rawPath
    });
  }
  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return {
      status: "success",
      value: rawPath.slice(2)
    };
  }
  return {
    status: "success",
    value: rawPath
  };
}

function splitPatchLines(patch: string): string[] {
  const lines = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function splitTextLines(text: string): { lines: string[] } {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized.length === 0) {
    return { lines: [] };
  }
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return {
    lines: withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n")
  };
}

function isGitMetadataLine(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}
