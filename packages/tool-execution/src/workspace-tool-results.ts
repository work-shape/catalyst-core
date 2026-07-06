import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import {
  type ExecutionWorkspaceId,
  type JsonObject,
  type ManagedArtifactRef,
  type ToolExecutionErrorCode,
  type ToolHandlerResult,
  type WorkspaceCommand,
  type WorkspaceCommandChangedFile,
  type WorkspaceCommandLimits,
  type WorkspaceCommandOutput,
  type WorkspaceCommandPromotedArtifact,
  type WorkspaceExpectedOutput,
  type WorkspaceFile,
  isJsonObject
} from "@vivd-catalyst/core";
import { DEFAULT_LIMITS, type WorkspaceCommandServiceLimits } from "./workspace-tool-schemas";
import {
  normalizeWorkspaceDirectory as normalizeWorkspaceDirectoryPath,
  normalizeWorkspaceFilePath as normalizeWorkspaceFilePathValue
} from "./workspace-paths";

export interface WorkspaceRawCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  changedFiles?: WorkspaceCommandChangedFile[];
  promotedArtifacts?: WorkspaceCommandPromotedArtifact[];
}

export type ValidationResult<T> =
  | {
      status: "success";
      value: T;
    }
  | {
      status: "failed";
      result: ToolHandlerResult<never>;
    };

export function shapeWorkspaceCommandOutput(
  raw: WorkspaceRawCommandOutput,
  limits: WorkspaceCommandLimits
): WorkspaceCommandOutput {
  const stdout = boundTextByBytes(raw.stdout, limits.maxStdoutBytes ?? DEFAULT_LIMITS.maxStdoutBytes);
  const stderr = boundTextByBytes(raw.stderr, limits.maxStderrBytes ?? DEFAULT_LIMITS.maxStderrBytes);
  return {
    exitCode: raw.exitCode,
    stdoutPreview: stdout.text,
    stderrPreview: stderr.text,
    durationMs: raw.durationMs,
    changedFiles: raw.changedFiles ?? [],
    promotedArtifacts: raw.promotedArtifacts ?? [],
    truncated: {
      stdout: stdout.truncated,
      stderr: stderr.truncated
    }
  };
}

export function commandToExecOutput(command: WorkspaceCommand, workspaceId: ExecutionWorkspaceId) {
  const output = command.output;
  return {
    commandId: command.id,
    workspaceId,
    status: command.status,
    limits: command.limits,
    exitCode: output?.exitCode ?? null,
    stdoutPreview: output?.stdoutPreview ?? "",
    stderrPreview: output?.stderrPreview ?? "",
    durationMs: output?.durationMs ?? null,
    changedFiles: (output?.changedFiles ?? []).map(publicChangedFile),
    promotedArtifacts: output?.promotedArtifacts ?? [],
    truncated: output?.truncated ?? {
      stdout: false,
      stderr: false
    }
  };
}

export function commandArtifacts(command: WorkspaceCommand): ManagedArtifactRef[] {
  const promotedArtifacts = command.output?.promotedArtifacts ?? [];
  return promotedArtifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    filename: path.basename(artifact.path),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    metadata: {
      source: "execution_workspace",
      commandId: command.id,
      workspacePath: artifact.path,
      ...(artifact.metadata?.preview ? { preview: artifact.metadata.preview } : {})
    } as unknown as JsonObject
  }));
}

export function validateExpectedOutputResult(
  expectedOutputs: readonly WorkspaceExpectedOutput[],
  output: WorkspaceCommandOutput,
  existingWorkspacePaths: ReadonlySet<string> = new Set()
): ToolHandlerResult<never> | undefined {
  for (const expected of expectedOutputs) {
    const changed = output.changedFiles.find((file) => file.path === expected.path);
    const existsAsFile = Boolean(changed) || existingWorkspacePaths.has(expected.path);
    const expectsDirectory = isDirectoryExpectedOutput(expected);
    const existsAsDirectory = expectsDirectory
      && (
        workspacePathSetContainsChild(existingWorkspacePaths, expected.path)
        || output.changedFiles.some((file) => isWorkspacePathChildOf(file.path, expected.path))
      );
    if (!existsAsFile && !existsAsDirectory) {
      return failed("handler_failed", "Expected workspace output was not produced", {
        path: expected.path
      });
    }
    if (expected.promote) {
      const promoted = output.promotedArtifacts.find((artifact) => artifact.path === expected.path);
      if (!promoted) {
        return failed("handler_failed", "Expected workspace output was not promoted", {
          path: expected.path
        });
      }
    }
  }
  return undefined;
}

function isDirectoryExpectedOutput(expected: WorkspaceExpectedOutput): boolean {
  const kind = expected.kind?.toLowerCase();
  return kind === "directory" || kind === "folder";
}

function workspacePathSetContainsChild(paths: ReadonlySet<string>, parent: string): boolean {
  for (const candidate of paths) {
    if (isWorkspacePathChildOf(candidate, parent)) {
      return true;
    }
  }
  return false;
}

function isWorkspacePathChildOf(candidate: string, parent: string): boolean {
  return candidate.startsWith(`${parent}/`);
}

export function normalizeWorkspaceFilePath(
  value: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string> {
  return workspacePathValidationToToolValidation(
    normalizeWorkspaceFilePathValue(value, limits)
  );
}

export function normalizeWorkspaceDirectory(
  value: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string> {
  return workspacePathValidationToToolValidation(
    normalizeWorkspaceDirectoryPath(value, limits)
  );
}

export function readPromotedFileArtifacts(metadata: JsonObject): Array<{
  artifactId: string;
  kind: string;
  promotedAt: string;
}> | undefined {
  const raw = metadata.promotedArtifacts;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const artifacts = raw.flatMap((value) => {
    if (!isJsonObject(value)) {
      return [];
    }
    const artifactId = typeof value.artifactId === "string" ? value.artifactId : undefined;
    const kind = typeof value.kind === "string" ? value.kind : undefined;
    const promotedAt = typeof value.promotedAt === "string" ? value.promotedAt : undefined;
    return artifactId && kind && promotedAt ? [{ artifactId, kind, promotedAt }] : [];
  });
  return artifacts.length > 0 ? artifacts : undefined;
}

export function mergePromotedFileArtifacts(
  metadata: JsonObject,
  artifact: {
    artifactId: string;
    kind: string;
    promotedAt: string;
  }
): JsonObject[] {
  const existing = readPromotedFileArtifacts(metadata) ?? [];
  return [
    ...existing
      .filter((candidate) => candidate.artifactId !== artifact.artifactId)
      .map((candidate) => ({
        artifactId: candidate.artifactId,
        kind: candidate.kind,
        promotedAt: candidate.promotedAt
      })),
    {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      promotedAt: artifact.promotedAt
    }
  ];
}

export function decodeTextFile(bytes: Uint8Array, mimeType: string | undefined): ValidationResult<string> {
  if (bytes.includes(0)) {
    return {
      status: "failed",
      result: failed("handler_failed", "Workspace file appears to be binary")
    };
  }
  if (mimeType && !isTextMimeType(mimeType)) {
    return {
      status: "failed",
      result: failed("handler_failed", "Workspace file is not a supported text MIME type", {
        mimeType
      })
    };
  }
  try {
    return {
      status: "success",
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    };
  } catch {
    return {
      status: "failed",
      result: failed("handler_failed", "Workspace file is not valid UTF-8 text")
    };
  }
}

export function boundTextByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)),
    truncated: true
  };
}

export function createWorkspaceChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function workspacePathFromFilename(filename: string, fileId: string): string {
  const normalizedFilename = filename.replaceAll("\\", "/");
  const basename = path.basename(normalizedFilename).trim();
  const extension = safeFileExtension(basename);
  const rawStem = extension ? basename.slice(0, -extension.length) : basename;
  const stem = safeWorkspaceFilenameStem(rawStem) || safeWorkspaceFilenameStem(fileId) || "file";
  return `inputs/${stem}${extension}`;
}

function safeFileExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : "";
}

function safeWorkspaceFilenameStem(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 160);
}

export function validationFailed(message: string, details?: JsonObject): ValidationResult<never> {
  return {
    status: "failed",
    result: failed("validation_failed", message, details)
  };
}

export function failedValidationResult(message: string, details?: JsonObject): ValidationResult<never> {
  return {
    status: "failed",
    result: failed("handler_failed", message, details)
  };
}

export function failed(
  code: ToolExecutionErrorCode,
  message: string,
  details?: JsonObject
): ToolHandlerResult<never> {
  return {
    status: "failed",
    error: {
      code,
      message,
      details
    }
  };
}

function publicChangedFile(file: WorkspaceCommandChangedFile): Omit<WorkspaceCommandChangedFile, "objectKey"> {
  return {
    path: file.path,
    byteSize: file.byteSize,
    checksum: file.checksum,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.artifactId ? { artifactId: file.artifactId } : {})
  };
}

function workspacePathValidationToToolValidation(
  result: ReturnType<typeof normalizeWorkspaceFilePathValue>
): ValidationResult<string> {
  if (result.status === "failed") {
    return validationFailed(result.message, result.details);
  }
  return {
    status: "success",
    value: result.value
  };
}

function isTextMimeType(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(";", 1)[0] ?? "";
  return (
    type === "application/csv" ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/typescript" ||
    type === "application/xml" ||
    type === "application/x-yaml" ||
    type === "application/yaml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    type.startsWith("text/")
  );
}
