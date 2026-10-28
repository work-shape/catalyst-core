import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  asUserId,
  createPlatformId,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  type AgentRunId,
  type AuditEventInput,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type ConversationId,
  type ModelProviderConfig,
  type ProjectInstructions,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  createLogger,
  createPlatformTools,
  resolveInstanceModules
} from "@work-shape/catalyst-client-assembly";
import { modelContentText, type ModelCompletionRequest } from "@work-shape/catalyst-model-provider";
import { ProjectFileService } from "@work-shape/catalyst-server";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  createWorkspaceToolDefinitions,
  ToolRegistry,
  WorkspaceCommandService
} from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import { createTestToolRunner, recordedAuditEvent } from "./support/tool-runner";

// PRJ-3: a project's instructions, the file AGENTS.md at the root of its folder. A run in the
// project takes them as layer 4 of its system message, records the version it took, and keeps
// that version when it resumes. Only a run whose person reads the project gets them; a subagent
// gets its root chat's, a Workflow step none. A write of the agent waits for the person's card.
// Kai owns the workspace Team, Lena is a member; Mia holds Builder there and is no member.

const ON = { projects: { enabled: true } };

const projectSchema = z.looseObject({ id: z.string(), title: z.string() });
const changeSchema = z.looseObject({ path: z.string(), version: z.number() });
const instructionsViewSchema = z.object({
  projectId: z.string().optional(),
  projectTitle: z.string().optional(),
  currentVersion: z.number().optional(),
  usedVersion: z.number().optional(),
  changed: z.boolean()
});

describe("a project's instructions", () => {
  let t: AccessInstance;
  const objects = new MemoryObjectStorage();
  let config: Parameters<typeof resolveInstanceModules>[0] | undefined;
  let service: ProjectFileService;
  let mia: UserRecord;
  let team: CollaborationWorkspaceId;
  const audited: Array<Omit<AuditEventInput, "clientInstanceId">> = [];
  let instructionsOf: (
    user: UserRecord | undefined,
    conversationId: string,
    runId: AgentRunId
  ) => Promise<ProjectInstructions | undefined>;

  const person = (user: UserRecord): AuthenticatedUser => ({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  });
  const createProject = async (title: string, audience?: "private") =>
    projectSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.create", {
          payload: { collaborationWorkspaceId: team, title, ...(audience ? { audience } : {}) }
        })
      ).json()
    );
  const startChat = async (userId: string, projectId: string) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: { title: "Chat", collaborationWorkspaceId: team, projectId }
    });
    const id = z.object({ id: z.string() }).parse(created.json()).id;
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(id),
      role: "user",
      text: "Hallo"
    });
    return id;
  };
  const active = new Map<string, AgentRunId>();
  /** A new run of the chat; the one before it completed, as a chat runs one at a time. */
  const newRun = async (conversationId: string) => {
    const before = active.get(conversationId);
    if (before) {
      const now = new Date().toISOString();
      await t.stores.agentRuns.updateAgentRunStatus({
        clientInstanceId,
        runId: before,
        status: "completed",
        updatedAt: now,
        completedAt: now
      });
    }
    const conversation = await t.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(conversationId)
    );
    if (!conversation) throw new Error("The chat is not there");
    const runId = (await t.stores.createAgentRunForTesting(conversation)).id;
    active.set(conversationId, runId);
    return runId;
  };
  /** Kai writes AGENTS.md on the project's page. */
  const writeOnPage = async (projectId: string, text: string, replaces?: number) => {
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename: "AGENTS.md",
      contentType: "text/markdown",
      content: text
    });
    const response = await t.call(t.kai.id, "projects.files.upload", {
      params: { projectId },
      query: { path: "AGENTS.md", ...(replaces === undefined ? {} : { replaces }) },
      headers: body.headers,
      payload: body.payload
    });
    expect(response.json()).not.toHaveProperty("error");
    return changeSchema.parse(response.json()).version;
  };
  const notice = async (userId: string, conversationId: string) =>
    instructionsViewSchema.parse(
      (
        await t.expectOk(userId, "conversations.project_instructions.get", {
          params: { conversationId }
        })
      ).json()
    );

  beforeAll(async () => {
    t = await setupAccessInstance({
      modules: ON,
      server: (_stores, instanceConfig) => {
        config = instanceConfig;
        return { config: instanceConfig, pages: { objects } };
      }
    });
    mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      roles: ["user"],
      permissions: []
    });
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    await t.grant(mia.id, "builder", { workspaceId: team });
    // The app is built on its first request, and with it the config this file reads.
    await createProject("Start");
    if (!config) throw new Error("The instance has no config");
    const modules = resolveInstanceModules(config, []).snapshot;
    service = new ProjectFileService({
      stores: t.stores,
      clientInstanceId,
      config,
      modules,
      logger: createLogger(),
      pages: { objects }
    });
    const platform = createPlatformTools({
      stores: t.stores,
      modules,
      projectFolder: () => service,
      audit: {
        record: (input) => {
          audited.push(input);
          return Promise.resolve(recordedAuditEvent(clientInstanceId, input));
        }
      }
    });
    instructionsOf = (user, conversationId, runId) => {
      const read = platform.conversationOffer.projectInstructionsOf;
      if (!read) throw new Error("The offer reads no project instructions");
      return read({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        ...(user ? { user: person(user) } : {}),
        runId
      });
    };
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("are taken by a run once, recorded with their version, audited without path or text, and kept on resume", async () => {
    const project = await createProject("Projekt Nord");
    const v1 = await writeOnPage(project.id, "Antworte auf Deutsch.\n\nNenne immer die Quelle.");
    const chat = await startChat(t.lena.id, project.id);
    const runId = await newRun(chat);
    audited.length = 0;

    await expect(instructionsOf(t.lena, chat, runId)).resolves.toEqual({
      projectId: project.id,
      title: "Projekt Nord",
      version: v1,
      text: "Antworte auf Deutsch.\n\nNenne immer die Quelle.",
      truncated: false
    });
    const run = await t.stores.agentRuns.getAgentRun({ clientInstanceId, runId });
    expect(run?.project).toEqual({ projectId: project.id, instructionsVersion: v1 });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      type: "project.instructions_read",
      subject: project.id,
      metadata: { version: v1, runId }
    });
    const record = JSON.stringify(audited[0]);
    expect(record).not.toContain("AGENTS.md");
    expect(record).not.toContain("Deutsch");

    // The file changes while the run waits; when it resumes, it keeps the version it took.
    const v2 = await writeOnPage(project.id, "Antworte auf Englisch.", v1);
    await expect(instructionsOf(t.lena, chat, runId)).resolves.toMatchObject({
      version: v1,
      text: "Antworte auf Deutsch.\n\nNenne immer die Quelle."
    });
    expect(audited).toHaveLength(1);
    // The chat's next run takes the new one.
    await expect(instructionsOf(t.lena, chat, await newRun(chat))).resolves.toMatchObject({
      version: v2,
      text: "Antworte auf Englisch."
    });
  });

  it("enter cut at 16,000 characters, and not at all where the file is empty", async () => {
    const project = await createProject("Lange Anweisungen");
    const chat = await startChat(t.kai.id, project.id);
    await writeOnPage(project.id, "x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 50));
    const long = await instructionsOf(t.kai, chat, await newRun(chat));
    expect(long?.truncated).toBe(true);
    expect(long?.text).toHaveLength(PROJECT_INSTRUCTIONS_MAX_CHARS);

    const empty = await createProject("Leere Anweisungen");
    const emptyChat = await startChat(t.kai.id, empty.id);
    await writeOnPage(empty.id, "  \n");
    await expect(instructionsOf(t.kai, emptyChat, await newRun(emptyChat))).resolves.toBe(
      undefined
    );
  });

  it("reach only a run whose person reads the project; a subagent takes its root chat's", async () => {
    const project = await createProject("Privat Kai", "private");
    await writeOnPage(project.id, "Nur für Kai.");
    const chat = await startChat(t.kai.id, project.id);
    const runId = await newRun(chat);
    audited.length = 0;

    // Lena is in the workspace but outside the private project's audience; Mia is no member.
    await expect(instructionsOf(t.lena, chat, runId)).resolves.toBe(undefined);
    await expect(instructionsOf(mia, chat, runId)).resolves.toBe(undefined);
    // A run without a person, as a scheduled or service run, reaches no project.
    await expect(instructionsOf(undefined, chat, runId)).resolves.toBe(undefined);
    expect(audited).toHaveLength(0);
    expect((await t.stores.agentRuns.getAgentRun({ clientInstanceId, runId }))?.project).toBe(
      undefined
    );

    // A subagent's thread works in its root chat's project.
    const parent = await t.stores.agentRuns.getAgentRun({ clientInstanceId, runId });
    if (!parent) throw new Error("The run is not there");
    const started = await t.stores.childAgentRuns.startSubagentRun({
      clientInstanceId,
      parentRunId: parent.id,
      parentOperationRunId: createPlatformId<"OperationRunId">("oprun"),
      agentName: "assistant",
      description: "Teil",
      task: "Lies die Anweisungen",
      correlationId: "corr_prj3_subagent"
    });
    if (started.status !== "started")
      throw new Error(`The subagent was not started: ${started.status}`);
    await expect(instructionsOf(t.kai, started.threadId, started.run.id)).resolves.toMatchObject({
      projectId: project.id,
      text: "Nur für Kai."
    });
    await expect(instructionsOf(t.lena, started.threadId, started.run.id)).resolves.toBe(undefined);
  });

  it("hold the agent's write or edit of AGENTS.md for the person's confirmation, and no other file", async () => {
    const project = await createProject("Werkstatt");
    const chat = await startChat(t.kai.id, project.id);
    const runId = await newRun(chat);
    const workspaceObjects = new MemoryObjectStorage();
    const tools = createWorkspaceToolDefinitions({
      service: new WorkspaceCommandService({
        store: t.stores,
        objectStore: workspaceObjects,
        fileStore: workspaceObjects,
        projectFolder: service
      })
    });
    const toolNames = tools.map((tool) => tool.name);
    // Even where the person allowed changing calls, the instructions wait for a card.
    const run = createTestToolRunner({
      registry: new ToolRegistry({ tools }),
      getAgentToolNames: () => toolNames,
      changingDefault: "allow"
    });
    const context: ToolExecutionContext = {
      clientInstanceId,
      correlationId: "corr_prj3_tools",
      user: person(t.kai),
      // The run's worker makes the call, which can hold it for the person's card.
      runFence: { runId, lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" } }
    };
    const call = (toolName: string, input: unknown) =>
      run(
        {
          toolName,
          toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
          agentRunId: runId,
          conversationId: asConversationId(chat),
          agentName: "assistant",
          input
        },
        context
      );

    const notes = await call("workspace.write_file", {
      path: "project/notizen.md",
      content: "- Termin\n"
    });
    expect(notes).toMatchObject({ status: "success" });
    for (const [toolName, input] of [
      ["workspace.write_file", { path: "project/AGENTS.md", content: "Sei knapp." }],
      ["workspace.write_file", { path: "project/./AGENTS.md", content: "Sei knapp." }],
      [
        "workspace.edit_file",
        { path: "project/AGENTS.md", edits: [{ oldText: "a", newText: "b" }] }
      ]
    ] as const) {
      await expect(call(toolName, input), `${toolName} ${input.path}`).resolves.toMatchObject({
        status: "waiting_for_decision",
        operationId: toolName,
        mode: "confirm"
      });
    }
    const folder = await service.folderOf({
      clientInstanceId,
      conversationId: chat,
      user: person(t.kai)
    });
    if (!folder) throw new Error("Kai's chat has no folder");
    expect((await service.list(folder)).map((file) => file.path)).not.toContain("AGENTS.md");
    // An AGENTS.md below the root is a note like any other.
    await expect(
      call("workspace.write_file", { path: "project/team/AGENTS.md", content: "Notiz" })
    ).resolves.toMatchObject({ status: "success" });
  });

  it("say in a chat that they changed since its last run, where the change came from elsewhere", async () => {
    const project = await createProject("Projekt Süd");
    const lenasChat = await startChat(t.lena.id, project.id);
    // Before any run, and before there are instructions, nothing changed.
    await expect(notice(t.lena.id, lenasChat)).resolves.toEqual({
      projectId: project.id,
      projectTitle: "Projekt Süd",
      changed: false
    });
    const v1 = await writeOnPage(project.id, "Erste Fassung.");
    await instructionsOf(t.lena, lenasChat, await newRun(lenasChat));
    await expect(notice(t.lena.id, lenasChat)).resolves.toMatchObject({
      currentVersion: v1,
      usedVersion: v1,
      changed: false
    });

    // Kai changes them on the page: Lena's chat says so.
    const v2 = await writeOnPage(project.id, "Zweite Fassung.", v1);
    await expect(notice(t.lena.id, lenasChat)).resolves.toMatchObject({
      currentVersion: v2,
      usedVersion: v1,
      changed: true
    });

    // Lena's chat changes them itself: its own change is no news to it.
    const runId = await newRun(lenasChat);
    await instructionsOf(t.lena, lenasChat, runId);
    const folder = await service.folderOf({
      clientInstanceId,
      conversationId: lenasChat,
      user: person(t.lena)
    });
    if (!folder) throw new Error("Lena's chat has no folder");
    const own = await service.write(folder, {
      path: "AGENTS.md",
      bytes: new TextEncoder().encode("Dritte Fassung."),
      replaces: v2,
      userId: t.lena.id,
      runId
    });
    await expect(notice(t.lena.id, lenasChat)).resolves.toMatchObject({
      currentVersion: own.version,
      usedVersion: v2,
      changed: false
    });

    // Nobody outside the project reads whether they changed.
    const response = await t.call(mia.id, "conversations.project_instructions.get", {
      params: { conversationId: lenasChat }
    });
    expect(response.statusCode).toBe(404);
  });
});

// The continuation test: a provider continuation (as OpenAI's encrypted reasoning) carries no
// system message of its own, so a run that goes on from one must still send the instructions
// of now. The second run here goes on from the first's continuation and sends the new version.
describe("a run that goes on from a provider continuation", () => {
  const runtimeInstance = asClientInstanceId("prj3-continuation");
  const context: RuntimeCallContext = {
    clientInstanceId: runtimeInstance,
    correlationId: "corr-prj3-continuation",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId: runtimeInstance,
      authSource: "test"
    }
  };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const,
    webSearchCallCount: 0
  };

  it("sends the project's instructions of now in its system message", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId: runtimeInstance,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Continuation",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const requests: ModelCompletionRequest[] = [];
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        requests.push(request);
        return {
          text: "Erledigt.",
          toolCalls: [],
          continuation: { providerId: "test-provider", state: { call: requests.length } },
          usage
        };
      }
    };
    let current = "Fassung eins: antworte knapp.";
    const asked: Array<{ runId: AgentRunId; conversationId: ConversationId }> = [];
    const provider: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "model-a"
    };
    const tools = new ToolRegistry({
      tools: [
        defineTool({
          name: "test.noop",
          description: "Nothing.",
          effect: "reading",
          inputSchema: z.object({}),
          execute: () => toolSuccess({})
        })
      ]
    });
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "assistant",
              displayName: "Assistant",
              instructions: "Help.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        conversationHistory: store.conversations,
        modelProviderContinuationStore: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider,
        toolRegistry: tools,
        runTool: createTestToolRunner({ registry: tools, getAgentToolNames: () => [] }),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        }),
        conversationOffer: {
          offerOf: () => Promise.resolve(undefined),
          projectInstructionsOf: (input) => {
            asked.push({ runId: input.runId, conversationId: input.conversationId });
            return Promise.resolve({
              projectId: "proj_one",
              title: "Projekt Nord",
              version: asked.length,
              text: current,
              truncated: false
            });
          }
        }
      })
    );
    const turn = async (text: string, extra: Partial<StartAgentRunInput> = {}) => {
      const message = await store.conversations.appendMessage({
        clientInstanceId: runtimeInstance,
        conversationId: conversation.id,
        role: "user",
        text
      });
      const run = await runtime.start(
        {
          agentName: "assistant",
          conversationId: conversation.id,
          inputMessageId: message.id,
          message: { text },
          ...extra
        },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "run_completed" || event.type === "run_failed") break;
      }
    };
    const systemOf = (request: ModelCompletionRequest | undefined) =>
      modelContentText(
        request?.messages.find((message) => message.role === "system")?.content ?? ""
      );

    await turn("Erste Frage");
    current = "Fassung zwei: antworte ausführlich.";
    await turn("Zweite Frage");

    expect(requests).toHaveLength(2);
    expect(systemOf(requests[0])).toContain("Fassung eins: antworte knapp.");
    // The second run goes on from the first's reasoning, and still sends the new instructions.
    expect(requests[1]?.continuation).toEqual({
      providerId: "test-provider",
      state: { call: 1 }
    });
    expect(requests[1]?.messages[0]?.role).toBe("system");
    expect(systemOf(requests[1])).toContain("Fassung zwei: antworte ausführlich.");
    expect(systemOf(requests[1])).not.toContain("Fassung eins");
    expect(asked).toHaveLength(2);

    // A Workflow step's run takes no project's instructions.
    await turn("Schritt", {
      workflowAgent: {
        workflowRunId: "wfr_prj3",
        instructions: "Do the step.",
        toolNames: [],
        outputSchema: { type: "object" }
      }
    });
    expect(asked).toHaveLength(2);
    expect(systemOf(requests.at(-1))).not.toContain("Project instructions:");
  });
});
