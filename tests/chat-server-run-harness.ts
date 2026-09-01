import { expect } from "vitest";
import { createChatServer, type ChatServerOptions } from "@vivd-catalyst/chat-server";
import {
  AppError,
  NoopAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  type AgentRun,
  type AgentRuntime,
  type AuthenticatedUser,
  type ChatMessage,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createTestUser, type TestServer } from "./chat-server-harness";

export async function createStaleRunRecoveryFixture(
  input: {
    staleActiveRunMs?: number;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("demo-local");
  const owner = createTestUser("user-1", clientInstanceId);
  const store = new InMemoryPlatformStore();
  const config = createTestConfig();
  const usageGovernance = new ModelUsageGovernance({
    store,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    costs: config.usage.costs
  });
  const options: ChatServerOptions = {
    config,
    clientInstanceId,
    authAdapter: {
      id: "test-auth",
      async authenticate(request) {
        const rawUserId = request.headers["x-test-user"];
        const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
        return createTestUser(userId ?? owner.id, clientInstanceId);
      }
    },
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    usageGovernance,
    auditRecorder: new NoopAuditRecorder(),
    agentRuntime: createMissingRuntime(),
    modelProvider: createUnusedModelProvider(),
    runRecovery: {
      staleActiveRunMs: input.staleActiveRunMs ?? 1,
      runOnStartup: false,
      watchdogIntervalMs: 60_000
    }
  };
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: owner.id,
    createdByExternalUserId: owner.externalUserId,
    title: "Recovered run",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const message = await store.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "recover this stale run"
  });
  const run = await createPersistedRecoveryRun(
    { store, clientInstanceId, owner, conversation, message },
    {
      status: "running"
    }
  );
  const server = await createChatServer(options);
  return {
    clientInstanceId,
    conversation,
    message,
    options,
    owner,
    run,
    server,
    store
  };
}

export async function createPersistedRecoveryRun(
  fixture: {
    store: InMemoryPlatformStore;
    clientInstanceId: ReturnType<typeof asClientInstanceId>;
    owner: AuthenticatedUser;
    conversation?: { id: AgentRun["conversationId"] };
    message?: ChatMessage;
  },
  input: { status: AgentRun["status"] }
): Promise<AgentRun> {
  const conversation =
    fixture.conversation ??
    (await fixture.store.createConversationForTesting({
      clientInstanceId: fixture.clientInstanceId,
      createdByUserId: fixture.owner.id,
      createdByExternalUserId: fixture.owner.externalUserId,
      title: `Recovered ${input.status}`,
      retainedUntil: "2030-01-01T00:00:00.000Z"
    }));
  const message =
    fixture.message ??
    (await fixture.store.appendMessage({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: `recover ${input.status}`
    }));
  const run = await fixture.store.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId: fixture.clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: fixture.owner.id,
    inputMessageId: message.id,
    agentName: "test_agent",
    correlationId: `corr-${input.status}`,
    startedAt: "2020-01-01T00:00:00.000Z"
  });
  await fixture.store.appendRunObservation({
    clientInstanceId: fixture.clientInstanceId,
    runId: run.id,
    conversationId: conversation.id,
    ownerUserId: fixture.owner.id,
    event: {
      type: "message_delta",
      runId: run.id,
      sequence: 1,
      createdAt: "2020-01-01T00:00:01.000Z",
      delta: "before restart"
    }
  });
  if (input.status === "running") {
    return (await fixture.store.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    })) as AgentRun;
  }

  const terminalAt = "2020-01-01T00:00:02.000Z";
  return fixture.store.updateAgentRunStatus({
    clientInstanceId: fixture.clientInstanceId,
    runId: run.id,
    status: input.status,
    updatedAt: terminalAt,
    lastSequence: 1,
    ...(input.status === "completed" ? { completedAt: terminalAt } : {}),
    ...(input.status === "cancelled" ? { cancelledAt: terminalAt } : {}),
    ...(input.status === "failed"
      ? {
          failedAt: terminalAt,
          error: {
            code: "TEST_FAILURE",
            message: "Test failure",
            category: "app_error"
          }
        }
      : {})
  });
}

export async function expectRunStatus(
  store: InMemoryPlatformStore,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  runId: AgentRun["id"],
  status: AgentRun["status"]
): Promise<void> {
  await expect(store.getAgentRun({ clientInstanceId, runId })).resolves.toMatchObject({ status });
}

export function createMissingRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async *observe() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async getStatus() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async resume() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async cancel() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    }
  };
}

export function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by recovery tests");
    }
  };
}

interface StartedRunBody {
  conversation: { id: string };
  userMessage: { id: string; text: string };
  run: { id: string; status: string; lastSequence: number };
  eventsUrl: string;
}

export async function injectStartConversationRun(
  server: TestServer,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await server.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/runs`,
    headers: options.headers,
    payload: {
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as StartedRunBody;
}

export async function drainRunEvents(
  server: TestServer,
  conversationId: string,
  runId: string,
  options: {
    headers?: Record<string, string>;
    afterSequence?: number;
  } = {}
): Promise<string> {
  const response = await server.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/runs/${runId}/events${
      options.afterSequence === undefined ? "" : `?after=${options.afterSequence}`
    }`,
    headers: options.headers
  });
  expect(response.statusCode).toBe(200);
  return response.payload;
}

export async function fetchStartConversationRun(
  baseUrl: string,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers
    },
    body: JSON.stringify({
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as StartedRunBody;
}

export async function fetchRunEvents(
  baseUrl: string,
  conversationId: string,
  runId: string
): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/conversations/${conversationId}/runs/${runId}/events`
  );
  expect(response.status).toBe(200);
  return response.text();
}

export function parseSseChunks(text: string): Array<{
  type?: string;
  sequence?: number;
  runId?: string;
  conversationId?: string;
  payload?: {
    type?: string;
    delta?: string;
    error?: {
      code?: string;
      category?: string;
      message?: string;
    };
  };
}> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          payload?: { type?: string; delta?: string };
        }
    );
}
