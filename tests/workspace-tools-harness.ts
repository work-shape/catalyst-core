import {
  asAgentRunId,
  asClientInstanceId,
  asManagedFileId,
  asToolCallId,
  StoreBackedAuditRecorder,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createWorkspaceToolDefinitions,
  InProcessToolExecution,
  ToolRegistry,
  WorkspaceCommandService,
  type WorkspaceArtifactPreviewGenerator,
  type WorkspaceCommandTelemetry,
  type WorkspaceFileByteStore,
  type WorkspaceObjectStore
} from "@vivd-catalyst/tool-execution";

export async function createWorkspaceHarness(input: {
  agentToolNames?: string[];
  artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  commandResults?: ConstructorParameters<typeof WorkspaceCommandService>[0]["commandResults"];
  execResultWaitMs?: ConstructorParameters<typeof WorkspaceCommandService>[0]["execResultWaitMs"];
  execResultPollIntervalMs?: ConstructorParameters<typeof WorkspaceCommandService>[0]["execResultPollIntervalMs"];
  limits?: ConstructorParameters<typeof WorkspaceCommandService>[0]["limits"];
  serviceStore?: (
    store: InMemoryPlatformStore
  ) => ConstructorParameters<typeof WorkspaceCommandService>[0]["store"];
  telemetry?: WorkspaceCommandTelemetry;
  withAuditRecorder?: boolean;
  sourceFiles?: Record<
    string,
    {
      filename: string;
      mimeType?: string;
      bytes: Uint8Array;
    }
  >;
} = {}) {
  const clientInstanceId = asClientInstanceId(`workspace_tools_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Workspace tools test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const objectStore = new TestWorkspaceObjectStore();
  const auditRecorder = input.withAuditRecorder
    ? new StoreBackedAuditRecorder({ clientInstanceId, store })
    : undefined;
  const service = new WorkspaceCommandService({
    store: input.serviceStore?.(store) ?? store,
    objectStore,
    ...(input.sourceFiles || input.artifactPreviewGenerator
      ? {
          fileStore: objectStore,
          ...(input.artifactPreviewGenerator ? { artifactPreviewGenerator: input.artifactPreviewGenerator } : {}),
          ...(input.sourceFiles ? {
          sourceFileReader: {
            async readSourceFile(readInput) {
              const source = input.sourceFiles?.[readInput.fileId];
              if (!source) {
                throw new Error("Managed source file is not available");
              }
              return {
                fileId: asManagedFileId(readInput.fileId),
                filename: source.filename,
                ...(source.mimeType ? { mimeType: source.mimeType } : {}),
                byteSize: source.bytes.byteLength,
                bytes: source.bytes
              };
            }
          }
          } : {})
        }
      : {}),
    ...(input.commandResults ? { commandResults: input.commandResults } : {}),
    ...(auditRecorder ? { auditRecorder } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    limits: input.limits,
    execResultWaitMs: input.execResultWaitMs ?? 0,
    execResultPollIntervalMs: input.execResultPollIntervalMs,
    now: () => "2026-06-29T12:00:00.000Z"
  });
  const tools = createWorkspaceToolDefinitions({ service });
  const agentToolNames = input.agentToolNames ?? tools.map((tool) => tool.name);
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => agentToolNames,
    ...(auditRecorder ? { auditRecorder } : {})
  });
  const context = createToolContext(clientInstanceId);
  return {
    clientInstanceId,
    ownerUserId,
    store,
    conversation,
    objectStore,
    tools,
    execution,
    context,
    createRequest(toolName: string, requestInput: unknown) {
      return createToolRequest(conversation, toolName, requestInput);
    },
    async runTool(toolName: string, requestInput: unknown) {
      const request = createToolRequest(conversation, toolName, requestInput);
      const decision = await execution.authorize(request, context);
      if (decision.status !== "allowed") {
        return {
          status: "failed" as const,
          error: {
            code: "not_allowed" as const,
            message: decision.reason
          }
        };
      }
      return execution.execute({ ...request, authorization: decision }, context);
    },
    async putWorkspaceFile(file: {
      path: string;
      objectKey: string;
      bytes: string | Uint8Array;
      mimeType?: string;
    }) {
      const workspace = await store.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId,
        now: "2026-06-29T12:00:00.000Z"
      });
      const bytes = typeof file.bytes === "string" ? new TextEncoder().encode(file.bytes) : file.bytes;
      objectStore.putObject(file.objectKey, bytes);
      return store.upsertWorkspaceFile({
        clientInstanceId,
        workspaceId: workspace.id,
        path: file.path,
        objectKey: file.objectKey,
        byteSize: bytes.byteLength,
        checksum: `sha256:${file.path}`,
        mimeType: file.mimeType,
        updatedAt: "2026-06-29T12:01:00.000Z"
      });
    },
    async seedActiveCommand(seed: { ownerUserId: string }) {
      const seededConversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: seed.ownerUserId,
        ownerExternalUserId: seed.ownerUserId,
        title: "Seeded active command",
        retainedUntil: "2026-07-29T00:00:00.000Z"
      });
      const workspace = await store.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: seededConversation.id,
        ownerUserId: seed.ownerUserId,
        now: "2026-06-29T12:00:00.000Z"
      });
      return store.enqueueWorkspaceCommand({
        clientInstanceId,
        workspaceId: workspace.id,
        ownerUserId: seed.ownerUserId,
        command: "sleep 60",
        limits: { timeoutSeconds: 60 },
        queuedAt: "2026-06-29T12:02:00.000Z"
      });
    }
  };
}

function createToolContext(clientInstanceId: ClientInstanceId): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_workspace_tools",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Workspace Tools User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

function createToolRequest(conversation: Conversation, toolName: string, input: unknown) {
  return {
    toolName,
    toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
    agentRunId: asAgentRunId(`run_${globalThis.crypto.randomUUID()}`),
    conversationId: conversation.id,
    agentName: "workspace_agent",
    input
  };
}

export function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export class TestArtifactPreviewGenerator implements WorkspaceArtifactPreviewGenerator {
  readonly calls: Parameters<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>[0][] = [];

  constructor(
    private readonly images: Awaited<
      ReturnType<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>
    >
  ) {}

  async generatePreviewImages(
    input: Parameters<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>[0]
  ) {
    this.calls.push(input);
    return this.images;
  }
}

class TestWorkspaceObjectStore implements WorkspaceFileByteStore, WorkspaceObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  putObject(key: string, body: Uint8Array): void {
    this.objects.set(key, body);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object '${key}' not found`);
    }
    return object;
  }

  async putWorkspaceFile(input: Parameters<WorkspaceFileByteStore["putWorkspaceFile"]>[0]) {
    const objectKey = [
      "execution-workspaces",
      input.clientInstanceId,
      input.conversationId,
      input.workspaceId,
      input.commandId,
      input.path
    ].join("/");
    this.putObject(objectKey, input.bytes);
    return { objectKey };
  }
}
