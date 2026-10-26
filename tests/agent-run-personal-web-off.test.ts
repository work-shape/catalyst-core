import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  personalDataConversation,
  createOperationRegistry,
  createAuthorizer,
  createPlatformId,
  type AgentRuntimeEvent,
  type AgentRunId,
  type AgentRunResume,
  type MessageId,
  type ConversationId,
  type OperationDefinition,
  type RuntimeCallContext,
  type ToolExecutionResult,
  type ToolDecisionRunner,
  type ToolOperationRunner,
  type WebAccessConfig
} from "@work-shape/catalyst-core";
import {
  type ModelCompletionRequest,
  type ModelToolCall
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry, createDecidedToolCallRunner } from "@work-shape/catalyst-tool-execution";
import { createAuditingEventEmitter } from "@work-shape/catalyst-server";
import { createWebFetchTool, DirectWebFetcher } from "@work-shape/catalyst-web-access";
import {
  createRecordingGovernance,
  silentTestLogger,
  withTestModelGateway
} from "./support/model-gateway";
import { usePostgresSuite } from "./support/postgres-suite";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createSubagentFixture } from "./support/subagent-runs";
import { createTestToolRunner, recordedAuditEvent } from "./support/tool-runner";

const PERSONAL = "connection.personal.read";
const SHARED = "connection.shared.read";
const REFUSAL =
  "Web access is off in this conversation because it holds data from a personal connection";
const webAccess: WebAccessConfig = {
  enabled: true,
  search: { enabled: true },
  fetch: {
    enabled: true,
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    maxTextCharacters: 1024,
    maxRedirects: 0
  }
};
const call = (toolName: string, toolCallId = toolName): ModelToolCall => ({
  toolName,
  toolCallId,
  input: toolName === "web_fetch" ? { url: "https://example.test/?private=mail" } : {}
});
const allTools = ["web_fetch", PERSONAL, SHARED, "web_search"];
const privateTools = [PERSONAL, SHARED];

describe("CS-9c personal data switches web tools off", () => {
  const db = usePostgresSuite("personal_web_off");

  async function fixture() {
    const f = await createSubagentFixture(db, "web_off");
    const conversation = await f.createConversation("Personal data");
    const context: RuntimeCallContext = {
      clientInstanceId: f.clientInstanceId,
      correlationId: "personal-web-off",
      user: {
        id: f.user.id,
        externalUserId: "user_test",
        displayLabel: "Author",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId: f.clientInstanceId,
        authSource: "test"
      }
    };
    const operations = createOperationRegistry();
    const definitions = [PERSONAL, SHARED].map((name): OperationDefinition => ({
      name,
      effect: "reading",
      ...(name === PERSONAL ? { personalConnection: true as const } : {}),
      action: "connection.use",
      resource: () => ({ kind: "connection", id: name }),
      timeoutMs: 1000,
      scope: null,
      auth: "principal",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async () => ({})
    }));
    operations.addSource({
      resolve: async (name) => definitions.find((definition) => definition.name === name),
      list: async () => ({ operations: definitions, truncated: [] })
    });
    const fetcher = new DirectWebFetcher({ config: webAccess.fetch });
    const fetch = vi.spyOn(fetcher, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
    const registry = new ToolRegistry({
      tools: [createWebFetchTool({ config: webAccess.fetch, fetcher })]
    });
    const webRunner = createTestToolRunner({ registry, getAgentToolNames: () => allTools });
    let personalResult: ToolExecutionResult = { status: "success", output: { mail: "private" } };
    let markPersonal = true;
    let pauseShared = false;
    let pauseFetch = false;
    const audit = {
      record: async (input: Parameters<typeof recordedAuditEvent>[1]) =>
        recordedAuditEvent(f.clientInstanceId, input)
    };
    const decided = createDecidedToolCallRunner({
      clientInstanceId: f.clientInstanceId,
      registry: operations,
      logger: silentTestLogger,
      resolveResource: async (resource) => ({ resource }),
      runs: db.store.operationRuns,
      authorizer: createAuthorizer(db.store.access),
      events: createAuditingEventEmitter(audit),
      audit,
      policy: {
        instanceDefaults: { reading: "allow", changing: "confirm" },
        centralSettings: () => []
      }
    });
    const runDecidedTool = vi.fn<ToolDecisionRunner>(async (request, context) =>
      request.refusal ? decided(request, context) : { status: "success", output: {} }
    );
    const runTool = vi.fn<ToolOperationRunner>(async (...args): ReturnType<ToolOperationRunner> => {
      const [request] = args;
      if (pauseFetch && request.toolName === "web_fetch") {
        const operationRunId = createPlatformId<"OperationRunId">("oprun");
        await db.store.operationRuns.create({
          ...f.scope,
          id: operationRunId,
          operation: "web_fetch",
          effect: "reading",
          actor: { kind: "user", id: f.user.id, label: "Author" },
          origin: {
            kind: "agent",
            agentRunId: request.agentRunId,
            conversationId: request.conversationId,
            agentName: request.agentName,
            toolCallId: request.toolCallId,
            toolName: request.toolName
          },
          conversationId: request.conversationId,
          target: "live",
          inputHash: "test-input",
          correlationId: context.correlationId,
          startedAt: new Date().toISOString()
        });
        await db.store.operationRuns.finish({
          ...f.scope,
          id: operationRunId,
          end: {
            status: "pending_confirmation",
            inputRef: `agent_run:${request.agentRunId}`,
            expiresAt: "2099-01-01T00:00:00.000Z",
            finishedAt: new Date().toISOString()
          }
        });
        return {
          status: "waiting_for_decision" as const,
          operationRunId,
          operationId: "web_fetch",
          mode: "confirm" as const,
          frozenInput: { url: "https://example.test/?private=mail" },
          expiresAt: "2099-01-01T00:00:00.000Z"
        };
      }
      if (request.toolName === PERSONAL) {
        if (markPersonal) await mark();
        return personalResult;
      }
      if (request.toolName === SHARED) {
        if (pauseShared)
          return {
            status: "waiting_for_decision" as const,
            operationRunId: createPlatformId<"OperationRunId">("oprun"),
            operationId: SHARED,
            mode: "confirm" as const,
            frozenInput: {},
            expiresAt: "2099-01-01T00:00:00.000Z"
          };
        return { status: "success" as const, output: {} };
      }
      return webRunner(...args);
    });
    const mark = () =>
      db.store.conversations.markPersonalData({
        ...f.scope,
        conversationId: conversation.id,
        userId: f.user.id,
        at: "2026-10-23T10:00:00.000Z"
      });

    async function run(
      script: ModelToolCall[][],
      input: {
        conversationId?: ConversationId;
        subagent?: boolean;
        modelBindingId?: string;
        withoutReaders?: boolean;
        resume?: { runId: AgentRunId; inputMessageId: MessageId; resume: AgentRunResume };
        beforeRequest?: (step: number) => Promise<void>;
      } = {}
    ) {
      const requests: ModelCompletionRequest[] = [];
      const provider = { id: "test", type: "deterministic", model: "test", region: "eu" };
      const runtime = new LocalAgentRuntime(
        withTestModelGateway({
          assetSource: createStaticConfigAssetSource({
            agents: [
              {
                name: "test_agent",
                displayName: "Test",
                instructions: "Read and research.",
                modelBindingId: "eu-default",
                userSelectableModelBindingIds: ["outside"],
                toolNames: allTools,
                skillNames: [],
                initialPrompts: []
              }
            ]
          }),
          defaultModelProvider: provider,
          modelProviders: [provider, { ...provider, id: "outside", region: "us" }],
          modelBindings: [
            { id: "eu-default", providerId: "test", agentSelectable: true },
            { id: "outside", providerId: "outside", agentSelectable: true }
          ],
          conversationHistory: db.store.conversations,
          ...(input.withoutReaders
            ? {}
            : {
                personalData: {
                  personalConversation: (id) =>
                    personalDataConversation(db.store, f.scope.clientInstanceId, id),
                  operations
                }
              }),
          toolRegistry: registry,
          dataTools: {
            describe: async () =>
              [PERSONAL, SHARED].map((name) => ({
                name,
                description: name,
                effect: "reading",
                inputJsonSchema: { type: "object" }
              }))
          },
          webAccess,
          modelCapabilities: { nativeTools: ["web_search"] },
          usageGovernance: createRecordingGovernance(),
          modelProvider: {
            id: provider.id,
            async complete(request) {
              requests.push(structuredClone(request));
              await input.beforeRequest?.(requests.length);
              return {
                text: "done",
                toolCalls: script[requests.length - 1] ?? [],
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  source: "not_reported",
                  webSearchCallCount: 0
                }
              };
            }
          },
          runTool,
          runDecidedTool
        })
      );
      const conversationId = input.conversationId ?? conversation.id;
      const inputMessageId =
        input.resume?.inputMessageId ??
        (
          await db.store.conversations.appendMessage({
            ...f.scope,
            conversationId,
            role: "user",
            text: "Read and research"
          })
        ).id;
      const handle = await runtime.start(
        {
          agentName: "test_agent",
          modelBindingId: input.modelBindingId,
          conversationId,
          inputMessageId,
          ...(input.resume
            ? {
                preparedRun: { id: input.resume.runId, startedAt: "2026-10-23T10:00:00.000Z" },
                resume: input.resume.resume
              }
            : {}),
          message: { text: "Read and research" }
        },
        { ...context, ...(input.subagent ? { subagent: true } : {}) }
      );
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.observe(handle.runId, context)) events.push(event);
      const resumeState = runtime.resumeStateOf(handle.runId);
      expect(events.at(-1)?.type).toBe(resumeState ? "tool_decision_requested" : "run_completed");
      return {
        requests,
        events,
        ...(resumeState
          ? {
              resume: {
                runId: handle.runId,
                inputMessageId,
                resume: { state: resumeState, lastSequence: events.at(-1)?.sequence ?? 0 }
              }
            }
          : {}),
        // `tool_result.read` is last in every request with tools; these cases are about the rest.
        tools: requests.map((request) =>
          request.tools.map((tool) => tool.name).filter((name) => name !== "tool_result.read")
        )
      };
    }
    return {
      ...f,
      conversation,
      context,
      run,
      mark,
      fetch,
      runTool,
      runDecidedTool,
      pauseFetch() {
        pauseFetch = true;
      },
      pauseShared() {
        pauseShared = true;
      },
      failPersonalWithoutMark() {
        personalResult = {
          status: "failed",
          error: { code: "handler_failed", message: "Failed before reading" }
        };
        markPersonal = false;
      }
    };
  }

  it("hands tools the actual resolved route, including a user-selected model", async () => {
    const f = await fixture();
    await f.run([[call(PERSONAL)], []]);
    expect(f.runTool.mock.calls[0]?.[1].modelRoutes).toEqual([{ id: "test", region: "eu" }]);
    f.runTool.mockClear();
    // Caller metadata must not override the runtime's selected route.
    f.context.modelRoutes = [{ id: "test", region: "eu" }];
    await f.run([[call(PERSONAL)], []], { modelBindingId: "outside" });
    expect(f.runTool.mock.calls[0]?.[1].modelRoutes).toEqual([{ id: "outside", region: "us" }]);
  });

  it("offers all three kinds initially, removes both web tools after a personal call, and inherits the mark in fresh runs and subagents", async () => {
    const f = await fixture();
    const first = await f.run([[call(PERSONAL)], []]);
    expect(first.tools).toEqual([allTools, privateTools]);
    expect(first.requests[0]?.tools).toContainEqual({ kind: "provider", name: "web_search" });
    expect(first.requests[1]?.tools.some((tool) => tool.kind === "provider")).toBe(false);
    expect((await f.run([[]])).tools).toEqual([privateTools]);
    const parent = await f.startParent(f.conversation);
    const child = await f.startChild(parent.run, "research");
    expect((await f.run([[]], { conversationId: child.threadId, subagent: true })).tools).toEqual([
      privateTools
    ]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["same step", "next step"])(
    "refuses a scripted web_fetch in the %s without calling the fetcher",
    async (when) => {
      const f = await fixture();
      const result = await f.run(
        when === "same step"
          ? [[call(PERSONAL), call("web_fetch")], []]
          : [[call(PERSONAL)], [call("web_fetch")], []]
      );
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.runTool.mock.calls.map(([request]) => request.toolName)).toEqual([PERSONAL]);
      const refusal = result.events.find((event) => event.type === "tool_call_failed");
      expect(refusal).toMatchObject({
        toolName: "web_fetch",
        result: { status: "failed", error: { code: "not_allowed", message: REFUSAL } }
      });
      expect(result.requests.at(-1)?.messages).toContainEqual(
        expect.objectContaining({ role: "tool", content: expect.stringContaining(REFUSAL) })
      );
    }
  );

  it("refuses web_fetch from the first step of a marked conversation", async () => {
    const f = await fixture();
    await f.mark();
    const result = await f.run([[call("web_fetch")], []]);
    expect(result.tools).toEqual([privateTools, privateTools]);
    expect(f.runTool).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps both web tools across steps and fresh runs with only shared connection calls", async () => {
    const f = await fixture();
    expect((await f.run([[call(SHARED)], []])).tools).toEqual([allTools, allTools]);
    expect((await f.run([[call(SHARED)], []])).tools).toEqual([allTools, allTools]);
  });

  it("switches off in memory even when the personal call fails before marking the conversation", async () => {
    const f = await fixture();
    f.failPersonalWithoutMark();
    const result = await f.run([[call(PERSONAL), call("web_fetch")], []]);
    expect(result.tools).toEqual([allTools, privateTools]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      (await db.store.conversations.getConversation(f.clientInstanceId, f.conversation.id))
        ?.personalDataAt
    ).toBeUndefined();
  });

  it("rechecks the root mark when another subagent marks it while this run is working", async () => {
    const f = await fixture();
    const parent = await f.startParent(f.conversation);
    const child = await f.startChild(parent.run, "research");
    const result = await f.run([[call(SHARED)], []], {
      conversationId: child.threadId,
      subagent: true,
      beforeRequest: async (step) => {
        if (step === 1) await f.mark();
      }
    });
    expect(result.tools).toEqual([allTools, privateTools]);
  });
  it.each(["missing", "unreadable"])(
    "closes web access when the root mark is %s",
    async (failure) => {
      const f = await fixture();
      const read = vi.spyOn(db.store.conversations, "getConversation");
      if (failure === "missing") read.mockResolvedValue(undefined);
      else read.mockRejectedValue(new Error("mark unreadable"));
      try {
        const result = await f.run([[call("web_fetch")], []]);
        expect(result.tools).toEqual([privateTools, privateTools]);
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    }
  );

  it("requires privacy readers before enabling web access on a custom host", async () => {
    const f = await fixture();
    await expect(f.run([[]], { withoutReaders: true })).rejects.toThrow(
      "Web access requires personal-data readers"
    );
  });

  it("restores the switch after a pause even when the failed personal call left no conversation mark", async () => {
    const f = await fixture();
    f.failPersonalWithoutMark();
    f.pauseShared();
    const paused = await f.run([[call(PERSONAL)], [call(SHARED)]]);
    expect(paused.tools).toEqual([allTools, privateTools]);
    expect(paused.resume).toBeDefined();
    const resumed = await f.run([[call("web_fetch")], []], { resume: paused.resume });
    expect(resumed.tools).toEqual([privateTools, privateTools]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("refuses and settles a web fetch that was waiting for confirmation when the conversation acquired personal data", async () => {
    const f = await fixture();
    f.pauseFetch();
    const paused = await f.run([[call("web_fetch")]]);
    await f.mark();
    const resumed = await f.run([[]], { resume: paused.resume });
    expect(resumed.tools).toEqual([privateTools]);
    const [decidedCall, decidedContext] = f.runDecidedTool.mock.calls[0] ?? [];
    expect(decidedContext?.modelRoutes).toEqual([{ id: "test", region: "eu" }]);
    expect(decidedCall?.refusal?.message).toBe(REFUSAL);
    expect(
      await db.store.operationRuns.get({
        ...f.scope,
        id: decidedCall?.operationRunId ?? createPlatformId<"OperationRunId">("oprun")
      })
    ).toMatchObject({ status: "denied", error: { message: REFUSAL } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
