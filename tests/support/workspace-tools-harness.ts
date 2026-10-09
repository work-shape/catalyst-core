import type { PlatformStores } from "@vivd-catalyst/core";
import { createTestInstance } from "./test-instance";
import {
  asClientInstanceId,
  asManagedFileId,
  asToolCallId,
  asUserId,
  StoreBackedAuditRecorder,
  type AgentRunId,
  type ClientInstanceId,
  type Conversation,
  type JsonObject,
  type ToolExecutionContext
} from "@vivd-catalyst/core";

import {
  createWorkspaceToolDefinitions,
  InProcessToolExecution,
  ToolRegistry,
  WorkspaceCommandService,
  type WorkspaceCommandTelemetry,
  type WorkspaceFileByteStore,
  type WorkspaceObjectStore
} from "@vivd-catalyst/tool-execution";

interface WorkspaceHarnessInput {
  agentToolNames?: string[];
  commandResults?: ConstructorParameters<typeof WorkspaceCommandService>[0]["commandResults"];
  execResultWaitMs?:
    ConstructorParameters<typeof WorkspaceCommandService>[0]["execResultWaitMs"] | null;
  execResultPollIntervalMs?: ConstructorParameters<
    typeof WorkspaceCommandService
  >[0]["execResultPollIntervalMs"];
  limits?: ConstructorParameters<typeof WorkspaceCommandService>[0]["limits"];
  serviceStore?: (
    store: PlatformStores
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
}

export async function createWorkspaceHarness(input: WorkspaceHarnessInput = {}) {
  const clientInstanceId = asClientInstanceId(`workspace_tools_${globalThis.crypto.randomUUID()}`);
  const store = (await createTestInstance()).stores;
  const owner = await store.users.resolveUserIdentity({
    clientInstanceId,
    authSource: "test",
    externalUserId: "user-1",
    displayLabel: "Workspace Tools User",
    roles: ["user"],
    permissionRefs: [],
    permissions: []
  });
  const ownerUserId = owner.id;
  const personalWorkspace = await store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: asUserId(owner.id)
  });
  const conversation = await store.conversations.createConversation({
    visibility: "workspace",
    clientInstanceId,
    collaborationWorkspaceId: personalWorkspace.id,
    createdByUserId: ownerUserId,
    createdByExternalUserId: ownerUserId,
    title: "Workspace tools test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const agentRun = await store.createAgentRunForTesting(conversation);
  const objectStore = new TestWorkspaceObjectStore();
  const auditRecorder = input.withAuditRecorder
    ? new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit })
    : undefined;
  const service = new WorkspaceCommandService({
    store: input.serviceStore?.(store) ?? store,
    objectStore,
    fileStore: objectStore,
    ...(input.sourceFiles
      ? {
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
        }
      : {}),
    ...(input.commandResults ? { commandResults: input.commandResults } : {}),
    ...(auditRecorder ? { auditRecorder } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    limits: input.limits,
    ...(input.execResultWaitMs === null ? {} : { execResultWaitMs: input.execResultWaitMs ?? 0 }),
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
  const context = createToolContext(clientInstanceId, ownerUserId);
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
      return createToolRequest(conversation, agentRun.id, toolName, requestInput);
    },
    async runTool(
      toolName: string,
      requestInput: unknown,
      toolContext: ToolExecutionContext = context
    ) {
      const request = createToolRequest(conversation, agentRun.id, toolName, requestInput);
      const decision = await execution.authorize(request, toolContext);
      if (decision.status !== "allowed") {
        return {
          status: "failed" as const,
          error: {
            code: "not_allowed" as const,
            message: decision.reason
          }
        };
      }
      return execution.execute({ ...request, authorization: decision }, toolContext);
    },
    async putWorkspaceFile(file: {
      path: string;
      objectKey: string;
      bytes: string | Uint8Array;
      mimeType?: string;
      metadata?: JsonObject;
    }) {
      const workspace = await store.executionWorkspaces.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId,
        now: "2026-06-29T12:00:00.000Z"
      });
      const bytes =
        typeof file.bytes === "string" ? new TextEncoder().encode(file.bytes) : file.bytes;
      objectStore.putObject(file.objectKey, bytes);
      return store.executionWorkspaces.upsertWorkspaceFile({
        clientInstanceId,
        workspaceId: workspace.id,
        path: file.path,
        objectKey: file.objectKey,
        byteSize: bytes.byteLength,
        checksum: `sha256:${file.path}`,
        mimeType: file.mimeType,
        metadata: file.metadata,
        updatedAt: "2026-06-29T12:01:00.000Z"
      });
    }
  };
}

function createToolContext(
  clientInstanceId: ClientInstanceId,
  ownerUserId: string
): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_workspace_tools",
    user: {
      id: ownerUserId,
      externalUserId: "user-1",
      displayLabel: "Workspace Tools User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

function createToolRequest(
  conversation: Conversation,
  agentRunId: AgentRunId,
  toolName: string,
  input: unknown
) {
  return {
    toolName,
    toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
    agentRunId,
    conversationId: conversation.id,
    agentName: "workspace_agent",
    input
  };
}

export function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class TestWorkspaceObjectStore implements WorkspaceFileByteStore, WorkspaceObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  readonly deletedKeys: string[] = [];
  /** Runs after the bytes of a workspace file are stored and before its row is written. */
  afterPutWorkspaceFile: (objectKey: string) => Promise<void> = async () => undefined;

  keys(): string[] {
    return [...this.objects.keys()];
  }

  async deleteObject(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }

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
    await this.afterPutWorkspaceFile(objectKey);
    return { objectKey };
  }
}
