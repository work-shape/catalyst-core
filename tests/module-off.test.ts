import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "@vivd-catalyst/capability-sdk";
import { createJobWorker, resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  asClientInstanceId,
  createModuleRegistry,
  defineJobHandler,
  defineJobKind,
  defineModule,
  type JsonObject,
  type Logger
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, setTestAgent } from "./support/fixtures";
import { registeredTestOperations } from "./support/operations";
import { createTestInstance, createTestInstanceWith } from "./support/test-instance";

// A module that is off is off everywhere: its operations, its agent tools and its job kinds.
// `resources` ships with the platform and owns an operation. No platform module owns a tool or
// a job kind yet, so a stand-in capability ships the `documents` module with one of each. It
// hands its tool over whatever the switch says: what keeps the tool away is the platform.

const TOOL = "fixture.read_document";
const JOB_KIND = "fixture.index_document";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

interface ErrorBody {
  error: { code: string; message: string; details?: { reason?: string; module?: string } };
}

function fixture() {
  const executed: string[] = [];
  const capability = defineCapability({
    name: "documents-stand-in",
    modules: [defineModule({ name: "documents", tools: [TOOL], jobKinds: [JOB_KIND] })],
    create: () => ({
      tools: [
        defineTool({
          name: TOOL,
          description: "Reads a document for tests.",
          inputSchema: z.object({}),
          async execute() {
            executed.push(TOOL);
            return toolSuccess({ read: true });
          }
        })
      ]
    })
  });
  return { capability, executed };
}

const agent = (toolNames: string[]): JsonObject => ({
  name: "test_agent",
  displayName: "Test Agent",
  instructions: "Use configured tools only.",
  modelProviderId: "local",
  toolNames,
  initialPrompts: []
});

/** An instance whose stored agent names the stand-in tool, with the two modules as given. */
function configWith(modules: { resources: boolean; documents: boolean }) {
  const config = parseClientInstanceConfig({
    ...createTestConfig({
      tools: [{ name: TOOL, enabled: true }],
      // Replacing the asset bundle, as a config push does, takes the release right.
      developmentAuth: {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"],
          permissions: ["config_assets.release"]
        }
      }
    }),
    modules: {
      resources: { enabled: modules.resources },
      documents: { enabled: modules.documents }
    }
  });
  setTestAgent(config, agent([TOOL]));
  return config;
}

async function startInstance(modules: { resources: boolean; documents: boolean }) {
  const { capability, executed } = fixture();
  const config = configWith(modules);
  const instance = await createTestInstance({
    config,
    env: {},
    tools: [],
    capabilities: [capability]
  });
  return { instance, executed, config, capability };
}

async function runToolCommand(instance: Awaited<ReturnType<typeof startInstance>>["instance"]) {
  const created = await instance.call("conversations.create", { payload: { title: "Module" } });
  const conversation = created.json<{ id: string }>();
  const started = await injectStartConversationRun(instance, conversation.id, `/tool ${TOOL} {}`);
  const events = await drainRunEvents(instance, conversation.id, started.run.id);
  return { conversation, events };
}

describe("a module that is off", () => {
  it("answers its operations with module_off, before the caller is looked at", async () => {
    const { instance } = await startInstance({ resources: false, documents: false });
    const created = await instance.call("conversations.create", { payload: { title: "Module" } });
    const conversationId = created.json<{ id: string }>().id;

    const refused = await instance.call("conversations.resources.list", {
      params: { conversationId }
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json<ErrorBody>().error).toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "module_off", module: "resources" }
    });

    // The same answer for a conversation that does not exist: nothing about the caller or
    // the record is read first.
    const unknown = await instance.call("conversations.resources.list", {
      params: { conversationId: "conv_not_there" }
    });
    expect(unknown.json<ErrorBody>().error.details).toEqual({
      reason: "module_off",
      module: "resources"
    });

    // Its neighbour of the same conversation is core and answers.
    const messages = await instance.call("conversations.messages.list", {
      params: { conversationId }
    });
    expect(messages.statusCode).toBe(200);
  });

  it("serves the same operation while the module is on", async () => {
    const { instance } = await startInstance({ resources: true, documents: true });
    const created = await instance.call("conversations.create", { payload: { title: "Module" } });
    const listed = await instance.call("conversations.resources.list", {
      params: { conversationId: created.json<{ id: string }>().id }
    });
    expect(listed.statusCode).toBe(200);
  });

  it("answers an operation of the registry with module_off and runs nothing", async () => {
    const operation = registeredTestOperations.testRunRead;
    const config = createTestConfig();
    const registry = createModuleRegistry([
      defineModule({ name: "documents", operations: [operation.id] })
    ]);
    const executed: string[] = [];
    const serverWith = (enabled: boolean) =>
      createTestInstanceWith(
        () => ({ config, modules: registry.snapshot({ documents: { enabled } }) }),
        (route) =>
          route.operation(operation, {
            execute: (item) => {
              executed.push(item.itemId);
              return Promise.resolve({ itemId: item.itemId, view: item.view });
            }
          })
      );

    const off = await (await serverWith(false)).call("testRunRead", { params: { itemId: "1" } });
    expect(off.statusCode).toBe(404);
    expect(off.json<ErrorBody>().error.details).toEqual({
      reason: "module_off",
      module: "documents"
    });
    expect(executed).toEqual([]);

    const on = await (await serverWith(true)).call("testRunRead", { params: { itemId: "1" } });
    expect(on.statusCode).toBe(200);
    expect(executed).toEqual(["1"]);
  });

  it("keeps its tool out of the model input of a run, also for an agent that still names it", async () => {
    // The stored agent names the tool, as after the module was turned off: the instance starts.
    const { instance, executed } = await startInstance({ resources: true, documents: false });
    const { conversation, events } = await runToolCommand(instance);

    // The scripted model calls a tool only when its input offers it, and says so otherwise.
    expect(events).toContain(`Tool '${TOOL}' is not available to this agent`);
    expect(executed).toEqual([]);
    const messages = await instance.call("conversations.messages.list", {
      params: { conversationId: conversation.id }
    });
    expect(
      messages.json<{ items: { role: string }[] }>().items.some((item) => item.role === "tool")
    ).toBe(false);
  });

  it("offers and runs the same tool while the module is on", async () => {
    const { instance, executed } = await startInstance({ resources: true, documents: true });
    const { events } = await runToolCommand(instance);
    expect(events).not.toContain("is not available to this agent");
    expect(executed).toEqual([TOOL]);
  });

  it("refuses an agent that names its tool, naming the module, and does not offer the tool", async () => {
    const { instance } = await startInstance({ resources: true, documents: false });
    const overview = await instance.call("config_assets.get_overview", {});
    expect(overview.statusCode).toBe(200);
    const { version, references } = overview.json<{
      version: number;
      references: { enabledToolNames: string[] };
    }>();
    expect(references.enabledToolNames).not.toContain(TOOL);

    const refused = await instance.call("config_assets.replace", {
      payload: {
        baseVersion: version,
        defaultAgentName: "test_agent",
        agents: [agent([TOOL])],
        skills: []
      }
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.json<ErrorBody>().error.details)).toContain(
      `Agent 'test_agent' references tool '${TOOL}' of module 'documents', which is off`
    );

    // Without the tool the same agent is written.
    const written = await instance.call("config_assets.replace", {
      payload: {
        baseVersion: version,
        defaultAgentName: "test_agent",
        agents: [agent([])],
        skills: []
      }
    });
    expect(written.statusCode).toBe(200);
  });

  it("accepts the same agent while the module is on", async () => {
    const { instance } = await startInstance({ resources: true, documents: true });
    const overview = await instance.call("config_assets.get_overview", {});
    const { version, references } = overview.json<{
      version: number;
      references: { enabledToolNames: string[] };
    }>();
    expect(references.enabledToolNames).toContain(TOOL);
    const written = await instance.call("config_assets.replace", {
      payload: {
        baseVersion: version,
        defaultAgentName: "test_agent",
        agents: [agent([TOOL])],
        skills: []
      }
    });
    expect(written.statusCode).toBe(200);
  });

  it("does not claim a queued job of its kind, which stays queued for Instance > Jobs", async () => {
    const { instance, config, capability } = await startInstance({
      resources: true,
      documents: false
    });
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const kind = defineJobKind({
      kind: JOB_KIND,
      payloadSchema: z.object({ documentId: z.string() }),
      maxAttempts: 1,
      backoff: { baseMs: 0, maxMs: 0 },
      leaseMs: 60_000,
      concurrency: {}
    });
    const ran: string[] = [];
    const workerWith = (documents: boolean) =>
      createJobWorker({
        stores: instance.stores,
        clientInstanceId,
        logger: silent,
        modules: resolveInstanceModules(configWith({ resources: true, documents }), [capability])
          .snapshot,
        handlers: [
          defineJobHandler({
            kind,
            slots: 1,
            async run(job) {
              ran.push(job.payload.documentId);
            }
          })
        ]
      });
    await instance.stores.jobs.enqueue(kind, { documentId: "doc_1" }, { clientInstanceId });

    const off = workerWith(false);
    await off.runDue();
    await off.stop();
    expect(ran).toEqual([]);
    const summary = await instance.call("instance.jobs.summary", {});
    expect(
      summary
        .json<{ items: { kind: string; queued: number; running: number }[] }>()
        .items.find((row) => row.kind === JOB_KIND)
    ).toMatchObject({ queued: 1, running: 0 });

    // Turned on again, the job that waited is done.
    const on = workerWith(true);
    await on.runDue();
    await on.stop();
    expect(ran).toEqual(["doc_1"]);
  });

  it("lists every module with its state, what it contributes and its config key", async () => {
    const { instance } = await startInstance({ resources: false, documents: true });
    const listed = await instance.call("instance.modules.list", {});
    expect(listed.statusCode).toBe(200);
    const items = listed.json<{ items: Record<string, unknown>[] }>().items;
    expect(items.map((item) => [item.name, item.enabled, item.configKey])).toEqual([
      ["documents", true, "modules.documents.enabled"],
      ["resources", false, "modules.resources.enabled"],
      ["assetManagement", false, "modules.assetManagement.enabled"],
      ["userInvitations", false, "modules.userInvitations.enabled"]
    ]);
    expect(items[0]).toMatchObject({
      shipped: true,
      kinds: [],
      operationCount: 0,
      jobKinds: [JOB_KIND],
      toolCount: 1
    });
    expect(items[1]).toMatchObject({ shipped: true, operationCount: 1, toolCount: 0 });
  });

  it("marks a module this build ships no code for", async () => {
    const instance = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });
    const listed = await instance.call("instance.modules.list", {});
    const items = listed.json<{ items: { name: string; shipped: boolean }[] }>().items;
    expect(items.find((item) => item.name === "documents")?.shipped).toBe(false);
  });
});
