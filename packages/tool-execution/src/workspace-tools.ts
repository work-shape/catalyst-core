import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinFsPath, posix as path } from "node:path";
import type { z } from "zod";
import {
  type ClientInstanceId,
  type ExecutionWorkspaceId,
  type ConversationId,
  type AuditRecorder,
  type JsonObject,
  type ManagedFileId,
  type PlatformStore,
  type SupportedImageMimeType,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type WorkspaceCommand,
  type WorkspaceCommandCapacityLimits,
  type WorkspaceCommandLimits,
  type WorkspaceExpectedOutput,
  type WorkspaceFile,
  createPlatformId,
  getRuntimeSubjectUserId,
  isAppError
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { enqueueArtifactPreviewJobForPromotedArtifact } from "./artifact-preview-jobs";
import type { WorkspaceFileByteStore, WorkspaceObjectStore } from "./workspace-file-bytes";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  workspaceCommandCountsMetadata,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";
import { validateWorkspaceShellCommand } from "./workspace-command-validation";
import {
  DEFAULT_LIMITS,
  emptyObjectInputJsonSchema,
  expectedOutputInputSchema,
  workspaceApplyPatchInputJsonSchema,
  workspaceApplyPatchInputSchema,
  workspaceApplyPatchOutputSchema,
  workspaceExecInputJsonSchema,
  workspaceExecInputSchema,
  workspaceExecOutputSchema,
  workspaceImportFilesInputJsonSchema,
  workspaceImportFilesInputSchema,
  workspaceImportFilesOutputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema,
  workspacePathInputJsonSchema,
  workspacePromoteArtifactInputJsonSchema,
  workspacePromoteArtifactInputSchema,
  workspacePromoteArtifactOutputSchema,
  workspacePreviewImagesInputJsonSchema,
  workspacePreviewImagesInputSchema,
  workspacePreviewImagesOutputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema,
  type WorkspaceCommandServiceLimits
} from "./workspace-tool-schemas";
import {
  commandArtifacts,
  commandToExecOutput,
  createWorkspaceChecksum,
  decodeTextFile,
  failed,
  failedValidationResult,
  boundTextByBytes,
  mergePromotedFileArtifacts,
  normalizeWorkspaceDirectory,
  normalizeWorkspaceFilePath,
  readPromotedFileArtifacts,
  validateExpectedOutputResult,
  validationFailed,
  workspacePathFromFilename,
  type ValidationResult
} from "./workspace-tool-results";
import {
  createWorkspaceArtifactPreviewMetadata,
  type WorkspaceArtifactPreviewGenerator
} from "./workspace-artifact-previews";
import {
  applyWorkspacePatchToText,
  parseWorkspaceApplyPatch,
  type WorkspacePatchChange
} from "./workspace-apply-patch";
import { resolveWorkspacePreviewImages } from "./workspace-preview-images";

export { shapeWorkspaceCommandOutput, type WorkspaceRawCommandOutput } from "./workspace-tool-results";
export type { WorkspaceCommandServiceLimits } from "./workspace-tool-schemas";

export type WorkspaceToolStore = Pick<
  PlatformStore,
  | "ensureExecutionWorkspace" | "listWorkspaceFiles" | "upsertWorkspaceFile"
  | "deleteWorkspaceFile"
  | "enqueueWorkspaceCommand" | "getWorkspaceCommand" | "requestWorkspaceCommandCancellation"
  | "countActiveWorkspaceCommands" | "createManagedArtifact" | "getManagedArtifact"
  | "enqueueArtifactPreviewJob" | "getArtifactPreviewJob" | "getArtifactPreviewManifest"
>;

export interface WorkspaceSourceFileReader {
  readSourceFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: string;
  }): Promise<{
    fileId: ManagedFileId;
    filename: string;
    mimeType?: string;
    byteSize: number;
    bytes: Uint8Array;
  }>;
}

export interface WorkspaceCommandResultSource {
  resolveWorkspaceCommand(input: { command: WorkspaceCommand; context: ToolExecutionContext }): Promise<WorkspaceCommand | undefined>;
}

export interface WorkspaceCommandServiceOptions {
  store: WorkspaceToolStore;
  objectStore?: WorkspaceObjectStore;
  fileStore?: WorkspaceFileByteStore;
  sourceFileReader?: WorkspaceSourceFileReader;
  commandResults?: WorkspaceCommandResultSource;
  artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  limits?: Partial<WorkspaceCommandServiceLimits>;
  execResultWaitMs?: number;
  execResultPollIntervalMs?: number;
  now?: () => string;
}

export class WorkspaceCommandService {
  private readonly store: WorkspaceToolStore;
  private readonly objectStore?: WorkspaceObjectStore;
  private readonly fileStore?: WorkspaceFileByteStore;
  private readonly sourceFileReader?: WorkspaceSourceFileReader;
  private readonly commandResults?: WorkspaceCommandResultSource;
  private readonly artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  private readonly auditRecorder?: AuditRecorder;
  private readonly telemetry?: WorkspaceCommandTelemetry;
  private readonly limits: WorkspaceCommandServiceLimits;
  private readonly execResultWaitMs?: number;
  private readonly execResultPollIntervalMs: number;
  private readonly now: () => string;

  constructor(options: WorkspaceCommandServiceOptions) {
    this.store = options.store;
    this.fileStore = options.fileStore;
    this.objectStore = options.objectStore ?? options.fileStore;
    this.sourceFileReader = options.sourceFileReader;
    this.commandResults = options.commandResults;
    this.artifactPreviewGenerator = options.artifactPreviewGenerator;
    this.auditRecorder = options.auditRecorder;
    this.telemetry = options.telemetry;
    this.limits = {
      ...DEFAULT_LIMITS,
      ...options.limits
    };
    this.execResultWaitMs = options.execResultWaitMs;
    this.execResultPollIntervalMs = options.execResultPollIntervalMs ?? 500;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async exec(
    input: z.infer<typeof workspaceExecInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceExecOutputSchema>>> {
    const normalized = this.normalizeExecInput(input);
    if (normalized.status === "failed") {
      return normalized.result;
    }
    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace.result;
    }

    const command = await this.enqueueCommand(context, workspace.value.id, normalized.value);
    if (command.status === "failed") {
      return command.result;
    }
    await this.recordQueuedCommand(context, command.value);
    const resolvedBySource = await this.commandResults?.resolveWorkspaceCommand({ command: command.value, context });
    if (resolvedBySource && resolvedBySource.id !== command.value.id) {
      return failed("handler_failed", "Workspace command result source returned the wrong command");
    }
    const resultCommand = await this.resolveCommandResult(resolvedBySource ?? command.value);
    if (resultCommand.status === "failed") {
      return resultCommand.result;
    }
    const expectedOutputs = normalized.value.expectedOutputs;
    if (resultCommand.value.output) {
      const existingWorkspacePaths =
        expectedOutputs.length > 0
          ? new Set(
              (
                await this.store.listWorkspaceFiles({
                  clientInstanceId: context.clientInstanceId,
                  workspaceId: workspace.value.id
                })
              ).map((file) => file.path)
            )
          : new Set<string>();
      const expectedValidation = validateExpectedOutputResult(
        expectedOutputs,
        resultCommand.value.output,
        existingWorkspacePaths
      );
      if (expectedValidation) {
        return expectedValidation;
      }
    }

    const output = commandToExecOutput(resultCommand.value, workspace.value.id);
    const artifacts = commandArtifacts(resultCommand.value);
    return toolSuccess(output, {
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      auditSummary: {
        action: "workspace.exec",
        subject: resultCommand.value.id,
        metadata: {
          status: resultCommand.value.status,
          timeoutSeconds: resultCommand.value.limits.timeoutSeconds
        }
      }
    });
  }

  async listFiles(
    _input: z.infer<typeof workspaceListFilesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceListFilesOutputSchema>>> {
    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace.result;
    }
    const files = await this.store.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.value.id
    });
    return toolSuccess(
      {
        workspaceId: workspace.value.id,
        files: files.map((file) => ({
          path: file.path,
          byteSize: file.byteSize,
          checksum: file.checksum,
          mimeType: file.mimeType,
          updatedAt: file.updatedAt,
          lastCommandId: file.lastCommandId,
          promotedArtifacts: readPromotedFileArtifacts(file.metadata)
        }))
      },
      {
        auditSummary: {
          action: "workspace.list_files",
          subject: workspace.value.id,
          metadata: {
            count: files.length
          }
        }
      }
    );
  }

  async importFiles(
    input: z.infer<typeof workspaceImportFilesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceImportFilesOutputSchema>>> {
    if (!this.fileStore || !this.sourceFileReader) {
      return failed("handler_failed", "Workspace source file import is not configured");
    }
    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace.result;
    }

    const files = await this.loadImportSourceFiles(input, context, workspace.value.conversationId);
    if (files.status === "failed") {
      return files.result;
    }
    const capacity = await this.validateImportCapacity(workspace.value.id, context, files.value);
    if (capacity.status === "failed") {
      return capacity.result;
    }

    const importedFiles = [];
    for (const file of files.value) {
      const stored = await this.fileStore.putWorkspaceFile({
        clientInstanceId: context.clientInstanceId,
        conversationId: workspace.value.conversationId,
        workspaceId: workspace.value.id,
        commandId: createPlatformId<"WorkspaceCommandId">("wcmd_import"),
        path: file.path,
        bytes: file.bytes,
        checksum: file.checksum,
        mimeType: file.mimeType
      });
      await this.store.upsertWorkspaceFile({
        clientInstanceId: context.clientInstanceId,
        workspaceId: workspace.value.id,
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
        updatedAt: this.now()
      });
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
        workspaceId: workspace.value.id,
        importedFiles
      },
      {
        auditSummary: {
          action: "workspace.import_files",
          subject: workspace.value.id,
          metadata: {
            count: importedFiles.length
          }
        }
      }
    );
  }

  async readFile(
    input: z.infer<typeof workspaceReadFileInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceReadFileOutputSchema>>> {
    const normalizedPath = normalizeWorkspaceFilePath(input.path, this.limits);
    if (normalizedPath.status === "failed") {
      return normalizedPath.result;
    }
    if (!this.objectStore) {
      return failed("handler_failed", "Workspace file bytes are not available");
    }
    const file = await this.findWorkspaceFile(context, normalizedPath.value);
    if (file.status === "failed") {
      return file.result;
    }
    if (file.value.file.byteSize > this.limits.maxReadFileBytes) {
      return failed("handler_failed", "Workspace file is too large to preview", {
        path: file.value.file.path,
        byteSize: file.value.file.byteSize,
        maxReadFileBytes: this.limits.maxReadFileBytes
      });
    }

    const bytes = await this.objectStore.getObject(file.value.file.objectKey);
    const decoded = decodeTextFile(bytes, file.value.file.mimeType);
    if (decoded.status === "failed") {
      return decoded.result;
    }
    const preview = boundTextByBytes(decoded.value, this.limits.maxReadPreviewBytes);
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

  async applyPatch(
    input: z.infer<typeof workspaceApplyPatchInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceApplyPatchOutputSchema>>> {
    if (!this.fileStore || !this.objectStore) {
      return failed("handler_failed", "Workspace patch editing is not configured");
    }
    const changes = parseWorkspaceApplyPatch(input.patch, this.limits);
    if (changes.status === "failed") {
      return changes.result;
    }
    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace.result;
    }
    const prepared = await this.preparePatchChanges({
      changes: changes.value,
      context,
      workspaceId: workspace.value.id
    });
    if (prepared.status === "failed") {
      return prepared.result;
    }
    const capacity = this.validateWorkspaceCapacity(prepared.value.existingFiles, {
      writes: prepared.value.writes,
      deletes: prepared.value.deletes
    });
    if (capacity.status === "failed") {
      return capacity.result;
    }

    const patchCommandId = createPlatformId<"WorkspaceCommandId">("wcmd_patch");
    const changedFiles = [];
    for (const write of prepared.value.writes) {
      const stored = await this.fileStore.putWorkspaceFile({
        clientInstanceId: context.clientInstanceId,
        conversationId: workspace.value.conversationId,
        workspaceId: workspace.value.id,
        commandId: patchCommandId,
        path: write.path,
        bytes: write.bytes,
        checksum: write.checksum,
        mimeType: write.mimeType
      });
      const file = await this.store.upsertWorkspaceFile({
        clientInstanceId: context.clientInstanceId,
        workspaceId: workspace.value.id,
        path: write.path,
        objectKey: stored.objectKey,
        byteSize: write.bytes.byteLength,
        checksum: write.checksum,
        mimeType: write.mimeType,
        metadata: {
          ...(write.existing?.metadata ?? {}),
          ...(write.existing ? { modifiedBy: "workspace.apply_patch" } : { source: "workspace.apply_patch" })
        },
        lastCommandId: patchCommandId,
        updatedAt: this.now()
      });
      changedFiles.push({
        path: file.path,
        byteSize: file.byteSize,
        checksum: file.checksum,
        ...(file.mimeType ? { mimeType: file.mimeType } : {})
      });
    }

    const deletedFiles = [];
    for (const deletion of prepared.value.deletes) {
      const deleted = await this.store.deleteWorkspaceFile({
        clientInstanceId: context.clientInstanceId,
        workspaceId: workspace.value.id,
        path: deletion.path,
        lastCommandId: patchCommandId,
        deletedAt: this.now()
      });
      if (deleted) {
        deletedFiles.push({ path: deleted.path });
      }
    }

    return toolSuccess(
      {
        workspaceId: workspace.value.id,
        changedFiles,
        deletedFiles
      },
      {
        auditSummary: {
          action: "workspace.apply_patch",
          subject: workspace.value.id,
          metadata: {
            changedCount: changedFiles.length,
            deletedCount: deletedFiles.length
          }
        }
      }
    );
  }

  async promoteArtifact(
    input: z.infer<typeof workspacePromoteArtifactInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspacePromoteArtifactOutputSchema>>> {
    const normalizedPath = normalizeWorkspaceFilePath(input.path, this.limits);
    if (normalizedPath.status === "failed") {
      return normalizedPath.result;
    }
    const file = await this.findWorkspaceFile(context, normalizedPath.value);
    if (file.status === "failed") {
      return file.result;
    }
    const filename = input.filename ?? path.basename(file.value.file.path);
    const mimeType = input.mimeType ?? file.value.file.mimeType ?? "application/octet-stream";
    const previewMetadata = await this.createPreviewMetadataForPromotedWorkspaceFile({
      conversationId: file.value.conversationId,
      file: file.value.file,
      filename,
      kind: input.kind,
      mimeType,
      workspaceId: file.value.workspaceId
    });
    const artifact = await this.store.createManagedArtifact({
      clientInstanceId: context.clientInstanceId,
      conversationId: file.value.conversationId,
      kind: input.kind,
      objectKey: file.value.file.objectKey,
      filename,
      mimeType,
      byteSize: file.value.file.byteSize,
      checksum: file.value.file.checksum,
      metadata: {
        source: "execution_workspace",
        workspaceId: file.value.workspaceId,
        workspacePath: file.value.file.path,
        ...(previewMetadata ? (previewMetadata as unknown as JsonObject) : {})
      }
    });
    await enqueueArtifactPreviewJobForPromotedArtifact(this.store, artifact);
    await this.markFilePromoted(file.value.file, {
      artifactId: artifact.id,
      kind: artifact.kind,
      promotedAt: artifact.createdAt
    });

    const output = {
      artifactId: artifact.id,
      path: file.value.file.path,
      kind: artifact.kind,
      filename,
      mimeType,
      byteSize: file.value.file.byteSize,
      checksum: file.value.file.checksum,
      ...(previewMetadata ? { metadata: previewMetadata as unknown as Record<string, unknown> } : {})
    };
    return toolSuccess(output, {
      artifacts: [
        {
          artifactId: artifact.id,
          kind: artifact.kind,
          filename,
          mimeType,
          metadata: {
            source: "execution_workspace",
            workspaceId: file.value.workspaceId,
            workspacePath: file.value.file.path,
            byteSize: file.value.file.byteSize,
            checksum: file.value.file.checksum,
            ...(previewMetadata ? (previewMetadata as unknown as JsonObject) : {})
          }
        }
      ],
      auditSummary: {
        action: "workspace.promote_artifact",
        subject: artifact.id,
        metadata: {
          path: file.value.file.path,
          kind: artifact.kind
        }
      }
    });
  }

  async previewImages(
    input: z.infer<typeof workspacePreviewImagesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspacePreviewImagesOutputSchema>>> {
    if (input.path || input.paths) {
      return this.previewWorkspaceImagePaths(input, context);
    }
    return resolveWorkspacePreviewImages(input, context, {
      store: this.store,
      maxImages: this.limits.maxPreviewImages
    });
  }

  private async previewWorkspaceImagePaths(
    input: z.infer<typeof workspacePreviewImagesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspacePreviewImagesOutputSchema>>> {
    const rawPaths = input.paths ?? (input.path ? [input.path] : []);
    const maxImages = Math.min(input.maxImages ?? this.limits.maxPreviewImages, this.limits.maxPreviewImages);
    if (rawPaths.length > maxImages) {
      return failed("handler_failed", "workspace.preview_images path count exceeds maxImages", {
        pathCount: rawPaths.length,
        maxImages
      });
    }

    const normalizedPaths = [];
    const seenPaths = new Set<string>();
    for (const rawPath of rawPaths) {
      const normalizedPath = normalizeWorkspaceFilePath(rawPath, this.limits);
      if (normalizedPath.status === "failed") {
        return normalizedPath.result;
      }
      if (seenPaths.has(normalizedPath.value)) {
        return failed("handler_failed", "workspace.preview_images paths must be unique", {
          path: normalizedPath.value
        });
      }
      seenPaths.add(normalizedPath.value);
      normalizedPaths.push(normalizedPath.value);
    }

    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace.result;
    }
    const files = await this.store.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.value.id
    });
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const images: z.infer<typeof workspacePreviewImagesOutputSchema>["images"] = [];
    const artifacts = [];
    const warnings: z.infer<typeof workspacePreviewImagesOutputSchema>["warnings"] = [];

    for (const imagePath of normalizedPaths) {
      const file = filesByPath.get(imagePath);
      if (!file) {
        return failed("handler_failed", `Workspace preview image '${imagePath}' was not found`);
      }
      const mimeType = readPreviewImageMimeType(file.mimeType, file.path);
      if (!mimeType) {
        return failed("handler_failed", "Workspace preview image must be a supported image file", {
          path: file.path,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          supportedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"]
        });
      }
      const artifact = await this.store.createManagedArtifact({
        clientInstanceId: context.clientInstanceId,
        conversationId: workspace.value.conversationId,
        kind: previewImageKind(mimeType),
        objectKey: file.objectKey,
        filename: path.basename(file.path),
        mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        metadata: {
          source: "execution_workspace_preview",
          workspaceId: workspace.value.id,
          workspacePath: file.path
        }
      });
      images.push({
        sourceArtifactId: artifact.id,
        imageArtifactId: artifact.id,
        mimeType,
        status: "ready"
      });
      artifacts.push({
        artifactId: artifact.id,
        kind: artifact.kind,
        filename: artifact.filename,
        mimeType,
        modelVisibility: {
          type: "image" as const,
          mimeType
        },
        metadata: {
          sourceArtifactId: artifact.id,
          status: "ready",
          workspacePath: file.path
        }
      });
    }

    return toolSuccess(
      {
        artifactId: images[0]?.imageArtifactId ?? "",
        status: "ready",
        maxImages,
        images,
        warnings
      },
      {
        artifacts: artifacts.length > 0 ? artifacts : undefined,
        auditSummary: {
          action: "workspace.preview_images",
          subject: workspace.value.id,
          metadata: {
            status: "ready",
            source: "workspace_path",
            imageCount: images.length,
            maxImages,
            warningCount: warnings.length
          }
        }
      }
    );
  }

  private normalizeExecInput(
    input: z.infer<typeof workspaceExecInputSchema>
  ): ValidationResult<{
    command: string;
    cwd?: string;
    limits: WorkspaceCommandLimits;
    expectedOutputs: WorkspaceExpectedOutput[];
  }> {
    const command = input.command.trim();
    if (command.length === 0) {
      return validationFailed("Workspace command cannot be blank");
    }
    if (command.includes("\0")) {
      return validationFailed("Workspace command cannot contain NUL bytes");
    }
    if (command.length > this.limits.maxCommandLength) {
      return validationFailed("Workspace command is too long", {
        maxCommandLength: this.limits.maxCommandLength
      });
    }
    const commandUsage = validateWorkspaceShellCommand(command);
    if (commandUsage.status === "failed") {
      return commandUsage;
    }
    const cwd = input.cwd ? normalizeWorkspaceDirectory(input.cwd, this.limits) : undefined;
    if (cwd?.status === "failed") {
      return cwd;
    }
    const limits = this.resolveCommandLimits(input.timeoutSeconds);
    if (limits.status === "failed") {
      return limits;
    }
    const expectedOutputs = this.normalizeExpectedOutputs(input.expectedOutputs ?? []);
    if (expectedOutputs.status === "failed") {
      return expectedOutputs;
    }
    return {
      status: "success",
      value: {
        command,
        cwd: cwd?.value === "." ? undefined : cwd?.value,
        limits: limits.value,
        expectedOutputs: expectedOutputs.value
      }
    };
  }

  private resolveCommandLimits(timeoutSeconds: number | undefined): ValidationResult<WorkspaceCommandLimits> {
    const resolvedTimeout = timeoutSeconds ?? this.limits.defaultTimeoutSeconds;
    if (resolvedTimeout > this.limits.maxTimeoutSeconds) {
      return validationFailed("Workspace command timeout exceeds the configured maximum", {
        timeoutSeconds: resolvedTimeout,
        maxTimeoutSeconds: this.limits.maxTimeoutSeconds
      });
    }
    return {
      status: "success",
      value: {
        timeoutSeconds: resolvedTimeout,
        idleTimeoutSeconds: this.limits.idleTimeoutSeconds,
        maxStdoutBytes: this.limits.maxStdoutBytes,
        maxStderrBytes: this.limits.maxStderrBytes,
        maxWorkspaceBytes: this.limits.maxWorkspaceBytes
      }
    };
  }

  private normalizeExpectedOutputs(
    outputs: readonly z.infer<typeof expectedOutputInputSchema>[]
  ): ValidationResult<WorkspaceExpectedOutput[]> {
    if (outputs.length > this.limits.maxExpectedOutputs) {
      return validationFailed("Too many expected workspace outputs", {
        maxExpectedOutputs: this.limits.maxExpectedOutputs
      });
    }
    const seenPaths = new Set<string>();
    const normalized: WorkspaceExpectedOutput[] = [];
    for (const output of outputs) {
      const normalizedPath = normalizeWorkspaceFilePath(output.path, this.limits);
      if (normalizedPath.status === "failed") {
        return normalizedPath;
      }
      if (seenPaths.has(normalizedPath.value)) {
        return validationFailed("Expected workspace output paths must be unique", {
          path: normalizedPath.value
        });
      }
      seenPaths.add(normalizedPath.value);
      normalized.push({
        path: normalizedPath.value,
        kind: output.kind,
        promote: output.promote ?? false
      });
    }
    return {
      status: "success",
      value: normalized
    };
  }

  private async enqueueCommand(
    context: ToolExecutionContext,
    workspaceId: ExecutionWorkspaceId,
    command: {
      command: string;
      cwd?: string;
      limits: WorkspaceCommandLimits;
      expectedOutputs: WorkspaceExpectedOutput[];
    }
  ): Promise<ValidationResult<WorkspaceCommand>> {
    try {
      return {
        status: "success",
        value: await this.store.enqueueWorkspaceCommand({
          clientInstanceId: context.clientInstanceId,
          workspaceId,
          ownerUserId: getRuntimeSubjectUserId(context),
          agentRunId: context.toolRequest?.agentRunId,
          toolCallId: context.toolRequest?.toolCallId,
          command: command.command,
          cwd: command.cwd,
          limits: command.limits,
          expectedOutputs: command.expectedOutputs,
          capacity: this.commandCapacityLimits(),
          queuedAt: this.now()
        })
      };
    } catch (error) {
      if (isAppError(error) && error.code === "CONFLICT") {
        return {
          status: "failed",
          result: failed("handler_failed", error.message, error.details as JsonObject | undefined)
        };
      }
      throw error;
    }
  }

  private commandCapacityLimits(): WorkspaceCommandCapacityLimits {
    return {
      perConversationActiveCommands: this.limits.perConversationActiveCommands,
      perUserActiveCommands: this.limits.perUserActiveCommands,
      globalActiveCommands: this.limits.globalActiveCommands
    };
  }

  private async recordQueuedCommand(
    context: ToolExecutionContext,
    command: WorkspaceCommand
  ): Promise<void> {
    const activeCounts = await this.readActiveCommandCounts(context.clientInstanceId);
    await recordWorkspaceCommandLifecycleAudit({
      auditRecorder: this.auditRecorder,
      type: "workspace_command.queued",
      status: "success",
      command,
      user: context.user,
      correlationId: context.correlationId,
      metadata: {
        timeoutSeconds: command.limits.timeoutSeconds,
        expectedOutputCount: command.expectedOutputs.length,
        promotedExpectedOutputCount: command.expectedOutputs.filter((output) => output.promote).length,
        cwdProvided: command.cwd !== undefined,
        ...(activeCounts ? { activeCounts: workspaceCommandCountsMetadata(activeCounts) } : {})
      }
    });
    await emitWorkspaceCommandTelemetry(
      this.telemetry,
      workspaceCommandTelemetryEvent("queued", command, {
        activeCounts
      })
    );
  }

  private async resolveCommandResult(command: WorkspaceCommand): Promise<ValidationResult<WorkspaceCommand>> {
    if (isTerminalWorkspaceCommand(command)) {
      return { status: "success", value: command };
    }

    const waitMs = this.execResultWaitMs ?? ((command.limits.timeoutSeconds * 1000) + 5000);
    if (waitMs <= 0) {
      return { status: "success", value: command };
    }

    const deadlineMs = Date.now() + waitMs;
    let current = command;
    while (Date.now() < deadlineMs) {
      await sleep(Math.min(this.execResultPollIntervalMs, Math.max(1, deadlineMs - Date.now())));
      const latest = await this.store.getWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id
      });
      if (!latest) {
        return failedValidationResult("Workspace command is no longer available", {
          commandId: command.id
        });
      }
      current = latest;
      if (isTerminalWorkspaceCommand(current)) {
        return { status: "success", value: current };
      }
    }

    let cancelled: WorkspaceCommand;
    try {
      cancelled = await this.store.requestWorkspaceCommandCancellation({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        reason: "Workspace command did not complete before the tool wait limit",
        requestedAt: this.now()
      });
    } catch (error) {
      if (isAppError(error) && error.code === "CONFLICT") {
        const latest = await this.store.getWorkspaceCommand({
          clientInstanceId: command.clientInstanceId,
          commandId: command.id
        });
        if (latest && isTerminalWorkspaceCommand(latest)) {
          return { status: "success", value: latest };
        }
      }
      throw error;
    }
    return failedValidationResult("Workspace command did not complete before the tool wait limit", {
      commandId: command.id,
      status: cancelled.status,
      waitMs
    });
  }

  private async readActiveCommandCounts(
    clientInstanceId: ClientInstanceId
  ): Promise<Awaited<ReturnType<WorkspaceToolStore["countActiveWorkspaceCommands"]>> | undefined> {
    try {
      return await this.store.countActiveWorkspaceCommands({ clientInstanceId });
    } catch {
      return undefined;
    }
  }

  private async findWorkspaceFile(
    context: ToolExecutionContext,
    filePath: string
  ): Promise<
    ValidationResult<{
      file: WorkspaceFile;
      workspaceId: ExecutionWorkspaceId;
      conversationId: ConversationId;
    }>
  > {
    const workspace = await this.ensureWorkspace(context);
    if (workspace.status === "failed") {
      return workspace;
    }
    const files = await this.store.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId: workspace.value.id
    });
    const file = files.find((candidate) => candidate.path === filePath);
    if (!file) {
      return {
        status: "failed",
        result: failed("handler_failed", `Workspace file '${filePath}' was not found`)
      };
    }
    return {
      status: "success",
      value: {
        file,
        workspaceId: workspace.value.id,
        conversationId: workspace.value.conversationId
      }
    };
  }

  private async loadImportSourceFiles(
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
    if (!this.sourceFileReader) {
      return failedValidationResult("Workspace source file import is not configured");
    }

    const seenPaths = new Set<string>();
    const files = [];
    for (const fileInput of input.files) {
      let source;
      try {
        source = await this.sourceFileReader.readSourceFile({
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
        this.limits
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

  private async validateImportCapacity(
    workspaceId: ExecutionWorkspaceId,
    context: ToolExecutionContext,
    files: ReadonlyArray<{ path: string; byteSize: number }>
  ): Promise<ValidationResult<void>> {
    const existingFiles = await this.store.listWorkspaceFiles({
      clientInstanceId: context.clientInstanceId,
      workspaceId
    });
    const importsByPath = new Map(files.map((file) => [file.path, file.byteSize]));
    const existingBytes = existingFiles
      .filter((file) => !importsByPath.has(file.path))
      .reduce((total, file) => total + file.byteSize, 0);
    const totalBytes = existingBytes + files.reduce((total, file) => total + file.byteSize, 0);
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      return validationFailed("Imported files would exceed the workspace size limit", {
        totalBytes,
        maxWorkspaceBytes: this.limits.maxWorkspaceBytes
      });
    }
    return {
      status: "success",
      value: undefined
    };
  }

  private async preparePatchChanges(input: {
    changes: readonly WorkspacePatchChange[];
    context: ToolExecutionContext;
    workspaceId: ExecutionWorkspaceId;
  }): Promise<
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
    if (!this.objectStore) {
      return failedValidationResult("Workspace file bytes are not available");
    }
    const existingFiles = await this.store.listWorkspaceFiles({
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
        ? await this.readPatchTargetText(existing)
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

  private async readPatchTargetText(file: WorkspaceFile): Promise<ValidationResult<string>> {
    if (!this.objectStore) {
      return failedValidationResult("Workspace file bytes are not available");
    }
    const bytes = await this.objectStore.getObject(file.objectKey);
    return decodeTextFile(bytes, file.mimeType);
  }

  private validateWorkspaceCapacity(
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
    const totalBytes = existingBytes + changes.writes.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      return validationFailed("Patched files would exceed the workspace size limit", {
        totalBytes,
        maxWorkspaceBytes: this.limits.maxWorkspaceBytes
      });
    }
    return {
      status: "success",
      value: undefined
    };
  }

  private async ensureWorkspace(
    context: ToolExecutionContext
  ): Promise<ValidationResult<Awaited<ReturnType<WorkspaceToolStore["ensureExecutionWorkspace"]>>>> {
    const conversationId = context.toolRequest?.conversationId;
    if (!conversationId) {
      return failedValidationResult("Workspace tools require an active tool request");
    }
    return {
      status: "success",
      value: await this.store.ensureExecutionWorkspace({
        clientInstanceId: context.clientInstanceId,
        conversationId,
        ownerUserId: getRuntimeSubjectUserId(context),
        now: this.now()
      })
    };
  }

  private async markFilePromoted(
    file: WorkspaceFile,
    artifact: {
      artifactId: string;
      kind: string;
      promotedAt: string;
    }
  ): Promise<void> {
    await this.store.upsertWorkspaceFile({
      clientInstanceId: file.clientInstanceId,
      workspaceId: file.workspaceId,
      path: file.path,
      objectKey: file.objectKey,
      byteSize: file.byteSize,
      checksum: file.checksum,
      mimeType: file.mimeType,
      metadata: {
        ...file.metadata,
        promotedArtifacts: mergePromotedFileArtifacts(file.metadata, artifact)
      },
      lastCommandId: file.lastCommandId,
      updatedAt: this.now()
    });
  }

  private async createPreviewMetadataForPromotedWorkspaceFile(input: {
    conversationId: ConversationId;
    file: WorkspaceFile;
    filename: string;
    kind: string;
    mimeType: string;
    workspaceId: ExecutionWorkspaceId;
  }) {
    if (!this.objectStore || !this.fileStore || !this.artifactPreviewGenerator) {
      return undefined;
    }

    const tempDirectory = await mkdtemp(joinFsPath(tmpdir(), "catalyst-promoted-preview-"));
    try {
      const sourceDirectory = joinFsPath(tempDirectory, "source");
      await mkdir(sourceDirectory, { recursive: true });
      const sourcePath = joinFsPath(sourceDirectory, safeLocalFilename(input.filename));
      await writeFile(sourcePath, await this.objectStore.getObject(input.file.objectKey));
      return await createWorkspaceArtifactPreviewMetadata({
        artifactKind: input.kind,
        artifactMimeType: input.mimeType,
        byteStore: this.fileStore,
        clientInstanceId: input.file.clientInstanceId,
        commandId: input.file.lastCommandId ?? createPlatformId<"WorkspaceCommandId">("wcmd_preview"),
        conversationId: input.conversationId,
        filename: input.filename,
        generator: this.artifactPreviewGenerator,
        sourcePath,
        store: this.store,
        workspaceId: input.workspaceId,
        workspacePath: input.file.path
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

function isTerminalWorkspaceCommand(command: WorkspaceCommand): boolean {
  return command.status === "completed" || command.status === "failed" || command.status === "cancelled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLocalFilename(filename: string): string {
  const basename = path.basename(filename.replaceAll("\\", "/")).trim();
  return basename && basename !== "." && basename !== ".." ? basename : "artifact";
}

function readPreviewImageMimeType(
  mimeType: string | undefined,
  filePath: string
): SupportedImageMimeType | undefined {
  if (isSupportedPreviewImageMimeType(mimeType)) {
    return mimeType;
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return undefined;
}

function isSupportedPreviewImageMimeType(value: string | undefined): value is SupportedImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function previewImageKind(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "image.jpeg";
    case "image/webp":
      return "image.webp";
    case "image/gif":
      return "image.gif";
    case "image/png":
      return "image.png";
  }
}

export function createWorkspaceToolDefinitions(
  options: WorkspaceCommandServiceOptions | { service: WorkspaceCommandService }
): AnyToolDefinition[] {
  const service =
    "service" in options ? options.service : new WorkspaceCommandService(options);

  return [
    defineTool({
      name: "workspace.exec",
      description:
        "Run a bounded Bash command from /workspace in the conversation execution workspace. Each call starts in /workspace unless cwd is provided for that call; cwd, processes, and files outside /workspace do not persist. The standard project directories scripts, artifacts, previews, and tmp are available at the start of every command. Pass a complete shell command or multiline script. Files created or changed under /workspace persist across calls and stay internal until promoted. For multiline create-and-verify commands, put `set -e` on its own line before later commands so helpers do not run after a failed script. Run artifact helpers directly. Do not prefix helpers with `set -e`, and do not pass helper flags such as `--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet` to `cat`, `ls`, or `printf`.",
      inputSchema: workspaceExecInputSchema,
      outputSchema: workspaceExecOutputSchema,
      inputJsonSchema: workspaceExecInputJsonSchema,
      execute(input, context) {
        return service.exec(input, context);
      }
    }),
    defineTool({
      name: "workspace.list_files",
      description:
        "List internal files currently tracked in the conversation execution workspace.",
      inputSchema: workspaceListFilesInputSchema,
      outputSchema: workspaceListFilesOutputSchema,
      inputJsonSchema: emptyObjectInputJsonSchema,
      execute(input, context) {
        return service.listFiles(input, context);
      }
    }),
    defineTool({
      name: "workspace.import_files",
      description:
        "Copy uploaded managed conversation files into the execution workspace by fileId. The result returns a shell-safe workspace path in importedFiles[].path; use that exact path in workspace.exec and do not invent shortened filenames. This uses managed file access and never exposes object-storage credentials.",
      inputSchema: workspaceImportFilesInputSchema,
      outputSchema: workspaceImportFilesOutputSchema,
      inputJsonSchema: workspaceImportFilesInputJsonSchema,
      execute(input, context) {
        return service.importFiles(input, context);
      }
    }),
    defineTool({
      name: "workspace.read_file",
      description:
        "Read a bounded UTF-8 preview of a text file from the conversation execution workspace.",
      inputSchema: workspaceReadFileInputSchema,
      outputSchema: workspaceReadFileOutputSchema,
      inputJsonSchema: workspacePathInputJsonSchema,
      execute(input, context) {
        return service.readFile(input, context);
      }
    }),
    defineTool({
      name: "workspace.apply_patch",
      description:
        "Apply a unified diff patch to text files in /workspace. Supports create, update, and delete for workspace paths; rejects path traversal, renames, and binary files. Use workspace.exec for normal shell work and scripts.",
      inputSchema: workspaceApplyPatchInputSchema,
      outputSchema: workspaceApplyPatchOutputSchema,
      inputJsonSchema: workspaceApplyPatchInputJsonSchema,
      execute(input, context) {
        return service.applyPatch(input, context);
      }
    }),
    defineTool({
      name: "workspace.promote_artifact",
      description:
        "Promote an internal workspace file to a managed artifact visible to the user. Prefer final outputs under /workspace/artifacts; do not promote scripts, scratch files, or preview images unless the user explicitly needs those files.",
      inputSchema: workspacePromoteArtifactInputSchema,
      outputSchema: workspacePromoteArtifactOutputSchema,
      inputJsonSchema: workspacePromoteArtifactInputJsonSchema,
      execute(input, context) {
        return service.promoteArtifact(input, context);
      }
    }),
    defineTool({
      name: "workspace.preview_images",
      description:
        "Load bounded rendered preview images into model-visible visual context without promoting preview files to the user. Use path/paths for rendered image files under /workspace/previews, or artifactId with page/slide/sheet/range selectors for managed DOCX/XLSX/PPTX/PDF artifacts. The result reports pending, failed, or unsupported when pixels are not actually attached.",
      inputSchema: workspacePreviewImagesInputSchema,
      outputSchema: workspacePreviewImagesOutputSchema,
      inputJsonSchema: workspacePreviewImagesInputJsonSchema,
      execute(input, context) {
        return service.previewImages(input, context);
      }
    })
  ];
}
