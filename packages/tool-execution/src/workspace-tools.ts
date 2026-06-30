import { posix as path } from "node:path";
import type { z } from "zod";
import {
  type ClientInstanceId,
  type ExecutionWorkspaceId,
  type ConversationId,
  type AuditRecorder,
  type JsonObject,
  type ManagedFileId,
  type PlatformStore,
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
import type { WorkspaceFileByteStore, WorkspaceObjectStore } from "./workspace-file-bytes";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  workspaceCommandCountsMetadata,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";
import {
  DEFAULT_LIMITS,
  emptyObjectInputJsonSchema,
  expectedOutputInputSchema,
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

export { shapeWorkspaceCommandOutput, type WorkspaceRawCommandOutput } from "./workspace-tool-results";
export type { WorkspaceCommandServiceLimits } from "./workspace-tool-schemas";

export type WorkspaceToolStore = Pick<
  PlatformStore,
  | "ensureExecutionWorkspace" | "listWorkspaceFiles" | "upsertWorkspaceFile"
  | "enqueueWorkspaceCommand" | "getWorkspaceCommand" | "requestWorkspaceCommandCancellation"
  | "countActiveWorkspaceCommands" | "createManagedArtifact"
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
      const expectedValidation = validateExpectedOutputResult(
        expectedOutputs,
        resultCommand.value.output
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
        workspacePath: file.value.file.path
      }
    });
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
      checksum: file.value.file.checksum
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
            checksum: file.value.file.checksum
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

    const cancelled = await this.store.requestWorkspaceCommandCancellation({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      reason: "Workspace command did not complete before the tool wait limit",
      requestedAt: this.now()
    });
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
}

function isTerminalWorkspaceCommand(command: WorkspaceCommand): boolean {
  return command.status === "completed" || command.status === "failed" || command.status === "cancelled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        "Queue a bounded shell command for the conversation execution workspace. Files created by future runners stay internal until promoted.",
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
        "Copy uploaded managed conversation files into the execution workspace by fileId. This uses managed file access and never exposes object-storage credentials.",
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
      name: "workspace.promote_artifact",
      description:
        "Promote an internal workspace file to a managed artifact visible to the user.",
      inputSchema: workspacePromoteArtifactInputSchema,
      outputSchema: workspacePromoteArtifactOutputSchema,
      inputJsonSchema: workspacePromoteArtifactInputJsonSchema,
      execute(input, context) {
        return service.promoteArtifact(input, context);
      }
    })
  ];
}
