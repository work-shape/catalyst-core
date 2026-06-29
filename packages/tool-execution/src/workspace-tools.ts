import { posix as path } from "node:path";
import { z } from "zod";
import {
  type ExecutionWorkspaceId,
  type ConversationId,
  type JsonObject,
  type ManagedArtifactRef,
  type PlatformStore,
  type ToolExecutionContext,
  type ToolExecutionErrorCode,
  type ToolHandlerResult,
  type WorkspaceCommand,
  type WorkspaceCommandCapacityLimits,
  type WorkspaceCommandChangedFile,
  type WorkspaceCommandLimits,
  type WorkspaceCommandOutput,
  type WorkspaceCommandPromotedArtifact,
  type WorkspaceExpectedOutput,
  type WorkspaceFile,
  getRuntimeSubjectUserId,
  isAppError,
  isJsonObject
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

const DEFAULT_LIMITS: WorkspaceCommandServiceLimits = {
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 300,
  idleTimeoutSeconds: 30,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 64 * 1024,
  maxWorkspaceBytes: 100 * 1024 * 1024,
  maxReadFileBytes: 128 * 1024,
  maxReadPreviewBytes: 16 * 1024,
  maxCommandLength: 8192,
  maxExpectedOutputs: 32,
  maxPathLength: 512,
  perConversationActiveCommands: 1,
  perUserActiveCommands: 1,
  globalActiveCommands: 4
};

const workspacePathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
const expectedOutputInputSchema = z
  .object({
    path: workspacePathSchema,
    kind: z.string().min(1).max(160).optional(),
    promote: z.boolean().optional()
  })
  .strict();

const workspaceExecInputSchema = z
  .object({
    command: z.string().min(1).max(DEFAULT_LIMITS.maxCommandLength),
    cwd: workspacePathSchema.optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    expectedOutputs: z.array(expectedOutputInputSchema).max(DEFAULT_LIMITS.maxExpectedOutputs).optional()
  })
  .strict();

const workspaceListFilesInputSchema = z.object({}).strict();

const workspaceReadFileInputSchema = z
  .object({
    path: workspacePathSchema
  })
  .strict();

const workspacePromoteArtifactInputSchema = z
  .object({
    path: workspacePathSchema,
    kind: z.string().min(1).max(160).default("workspace.file"),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(160).optional()
  })
  .strict();

const changedFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number(),
  checksum: z.string(),
  mimeType: z.string().optional(),
  artifactId: z.string().optional()
});
const promotedArtifactOutputSchema = z.object({
  artifactId: z.string(),
  path: z.string(),
  kind: z.string(),
  mimeType: z.string().optional()
});

const workspaceExecOutputSchema = z.object({
  commandId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  limits: z.object({
    timeoutSeconds: z.number(), idleTimeoutSeconds: z.number().optional(),
    maxStdoutBytes: z.number().optional(), maxStderrBytes: z.number().optional(),
    maxWorkspaceBytes: z.number().optional()
  }),
  exitCode: z.number().nullable(),
  stdoutPreview: z.string(),
  stderrPreview: z.string(),
  durationMs: z.number().nullable(),
  changedFiles: z.array(changedFileOutputSchema),
  promotedArtifacts: z.array(promotedArtifactOutputSchema),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() })
});

const workspaceListFilesOutputSchema = z.object({
  workspaceId: z.string(),
  files: z.array(
    z.object({
      path: z.string(), byteSize: z.number(), checksum: z.string(),
      mimeType: z.string().optional(), updatedAt: z.string(), lastCommandId: z.string().optional(),
      promotedArtifacts: z
        .array(
          z.object({ artifactId: z.string(), kind: z.string(), promotedAt: z.string() })
        )
        .optional()
    })
  )
});

const workspaceReadFileOutputSchema = z.object({
  workspaceId: z.string(), path: z.string(), byteSize: z.number(), mimeType: z.string().optional(),
  encoding: z.literal("utf-8"), contentPreview: z.string(), truncated: z.boolean()
});

const workspacePromoteArtifactOutputSchema = z.object({
  artifactId: z.string(), path: z.string(), kind: z.string(), filename: z.string(),
  mimeType: z.string(), byteSize: z.number(), checksum: z.string()
});

const workspaceExecInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: DEFAULT_LIMITS.maxCommandLength },
    cwd: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 300 },
    expectedOutputs: {
      type: "array", maxItems: DEFAULT_LIMITS.maxExpectedOutputs,
      items: {
        type: "object", additionalProperties: false, required: ["path"],
        properties: {
          path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
          kind: { type: "string", maxLength: 160 },
          promote: { type: "boolean", default: false }
        }
      }
    }
  }
};

const emptyObjectInputJsonSchema: JsonObject = {
  type: "object", additionalProperties: false, properties: {}
};

const workspacePathInputJsonSchema: JsonObject = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength } }
};

const workspacePromoteArtifactInputJsonSchema: JsonObject = {
  ...workspacePathInputJsonSchema,
  properties: {
    path: { type: "string", maxLength: DEFAULT_LIMITS.maxPathLength },
    kind: { type: "string", maxLength: 160, default: "workspace.file" },
    filename: { type: "string", maxLength: 255 },
    mimeType: { type: "string", maxLength: 160 }
  }
};

export type WorkspaceToolStore = Pick<
  PlatformStore,
  | "ensureExecutionWorkspace" | "listWorkspaceFiles" | "upsertWorkspaceFile"
  | "enqueueWorkspaceCommand" | "createManagedArtifact"
>;

export interface WorkspaceObjectStore {
  getObject(key: string): Promise<Uint8Array>;
}

export interface WorkspaceCommandResultSource {
  resolveWorkspaceCommand(input: { command: WorkspaceCommand; context: ToolExecutionContext }): Promise<WorkspaceCommand | undefined>;
}

export interface WorkspaceCommandServiceLimits {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  idleTimeoutSeconds?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxWorkspaceBytes: number;
  maxReadFileBytes: number;
  maxReadPreviewBytes: number;
  maxCommandLength: number;
  maxExpectedOutputs: number;
  maxPathLength: number;
  perConversationActiveCommands: number;
  perUserActiveCommands: number;
  globalActiveCommands: number;
}

export interface WorkspaceCommandServiceOptions {
  store: WorkspaceToolStore;
  objectStore?: WorkspaceObjectStore;
  commandResults?: WorkspaceCommandResultSource;
  limits?: Partial<WorkspaceCommandServiceLimits>;
  now?: () => string;
}

export interface WorkspaceRawCommandOutput {
  exitCode: number; stdout: string; stderr: string; durationMs: number;
  changedFiles?: WorkspaceCommandChangedFile[];
  promotedArtifacts?: WorkspaceCommandPromotedArtifact[];
}

export class WorkspaceCommandService {
  private readonly store: WorkspaceToolStore;
  private readonly objectStore?: WorkspaceObjectStore;
  private readonly commandResults?: WorkspaceCommandResultSource;
  private readonly limits: WorkspaceCommandServiceLimits;
  private readonly now: () => string;

  constructor(options: WorkspaceCommandServiceOptions) {
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.commandResults = options.commandResults;
    this.limits = {
      ...DEFAULT_LIMITS,
      ...options.limits
    };
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
    const resolved = await this.commandResults?.resolveWorkspaceCommand({ command: command.value, context });
    if (resolved && resolved.id !== command.value.id) {
      return failed("handler_failed", "Workspace command result source returned the wrong command");
    }
    const resultCommand = resolved ?? command.value;
    const expectedOutputs = normalized.value.expectedOutputs;
    if (resultCommand.output) {
      const expectedValidation = validateExpectedOutputResult(
        expectedOutputs,
        resultCommand.output
      );
      if (expectedValidation) {
        return expectedValidation;
      }
    }

    const output = commandToExecOutput(resultCommand, workspace.value.id);
    const artifacts = commandArtifacts(resultCommand);
    return toolSuccess(output, {
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      auditSummary: {
        action: "workspace.exec",
        subject: resultCommand.id,
        metadata: {
          status: resultCommand.status,
          timeoutSeconds: resultCommand.limits.timeoutSeconds
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

type ValidationResult<T> =
  | {
      status: "success";
      value: T;
    }
  | {
      status: "failed";
      result: ToolHandlerResult<never>;
    };

function commandToExecOutput(command: WorkspaceCommand, workspaceId: ExecutionWorkspaceId) {
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
    changedFiles: output?.changedFiles ?? [],
    promotedArtifacts: output?.promotedArtifacts ?? [],
    truncated: output?.truncated ?? {
      stdout: false,
      stderr: false
    }
  };
}

function commandArtifacts(command: WorkspaceCommand): ManagedArtifactRef[] {
  const promotedArtifacts = command.output?.promotedArtifacts ?? [];
  return promotedArtifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    filename: path.basename(artifact.path),
    mimeType: artifact.mimeType,
    metadata: {
      source: "execution_workspace",
      commandId: command.id,
      workspacePath: artifact.path
    }
  }));
}

function validateExpectedOutputResult(
  expectedOutputs: readonly WorkspaceExpectedOutput[],
  output: WorkspaceCommandOutput
): ToolHandlerResult<never> | undefined {
  for (const expected of expectedOutputs) {
    const changed = output.changedFiles.find((file) => file.path === expected.path);
    if (!changed) {
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

function normalizeWorkspaceFilePath(
  value: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string> {
  const normalized = normalizeWorkspacePath(value, limits);
  if (normalized.status === "failed") {
    return normalized;
  }
  if (normalized.value === ".") {
    return validationFailed("Workspace file path must name a file");
  }
  if (value.endsWith("/")) {
    return validationFailed("Workspace file path must not end with a slash", { path: value });
  }
  return normalized;
}

function normalizeWorkspaceDirectory(
  value: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string> {
  return normalizeWorkspacePath(value, limits);
}

function normalizeWorkspacePath(
  value: string,
  limits: WorkspaceCommandServiceLimits
): ValidationResult<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return validationFailed("Workspace path cannot be blank");
  }
  if (trimmed.length > limits.maxPathLength) {
    return validationFailed("Workspace path is too long", { maxPathLength: limits.maxPathLength });
  }
  if (trimmed.includes("\0")) {
    return validationFailed("Workspace path cannot contain NUL bytes");
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/u.test(trimmed)) {
    return validationFailed("Workspace path must be relative", { path: value });
  }
  if (trimmed.includes("\\")) {
    return validationFailed("Workspace path must use forward slashes", { path: value });
  }
  const normalized = path.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) {
    return validationFailed("Workspace path cannot traverse outside the workspace", { path: value });
  }
  return {
    status: "success",
    value: normalized
  };
}

function readPromotedFileArtifacts(metadata: JsonObject): Array<{
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

function mergePromotedFileArtifacts(
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

function decodeTextFile(bytes: Uint8Array, mimeType: string | undefined): ValidationResult<string> {
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

function boundTextByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)),
    truncated: true
  };
}

function validationFailed(message: string, details?: JsonObject): ValidationResult<never> {
  return {
    status: "failed",
    result: failed("validation_failed", message, details)
  };
}

function failedValidationResult(message: string, details?: JsonObject): ValidationResult<never> {
  return {
    status: "failed",
    result: failed("handler_failed", message, details)
  };
}

function failed(
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
