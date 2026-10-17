import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  defineProvider,
  type ConversationFollowUp,
  type AgentRunStatus
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { createTestInstance, getTestConfig, getTestJobs } from "./test-instance";
import { createTestConfig } from "./fixtures";
import { deferred, required, waitUntil } from "./assertions";
import { injectStartConversationRun } from "./chat-server-run-harness";

const objectRoots: string[] = [];
afterAll(async () => {
  await Promise.all(objectRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const releaseOnCleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of releaseOnCleanup.splice(0)) release();
});

/** One gate per actual model turn, so dispatch cannot finish a second turn in the assertions. */
export async function followUpFixture(
  separate = false,
  selection: { defaultEffortOnly?: boolean; attachments?: boolean; streaming?: boolean } = {}
) {
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  let cleaningUp = false;
  const deltaGates: Array<ReturnType<typeof deferred<void>>> = [];
  const completion: ModelCompletion = {
    text: "Done",
    toolCalls: [],
    sources: [],
    citations: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: "not_reported",
      webSearchCallCount: 0
    }
  };
  const provider = defineProvider({
    port: "models",
    type: "follow-up-test",
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => ({
          ...DETERMINISTIC_CAPABILITIES,
          reasoningEfforts: [...DETERMINISTIC_CAPABILITIES.reasoningEfforts, "high" as const]
        }),
        complete: async () => completion,
        async *stream() {
          const gate = deferred<void>();
          gates.push(gate);
          yield { type: "text_delta", delta: "Working" };
          if (selection.streaming) {
            for (let batch = 0; batch < 4; batch++) {
              const next = deferred<void>();
              deltaGates.push(next);
              if (!cleaningUp) await next.promise;
              for (let delta = 0; delta < 16; delta++) yield { type: "text_delta", delta: " more" };
            }
          }
          await gate.promise;
          yield { type: "completed", completion };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe: () => ({})
  });
  releaseOnCleanup.push(() => {
    cleaningUp = true;
    gates.forEach((gate) => gate.resolve());
    deltaGates.forEach((gate) => gate.resolve());
  });
  const objectRoot = selection.attachments
    ? await mkdtemp(join(tmpdir(), "fu-1a-attachments-"))
    : undefined;
  if (objectRoot) objectRoots.push(objectRoot);
  const config = createTestConfig({
    ...(objectRoot
      ? { executionWorkspaces: { enabled: true }, workspaceObjectRoot: objectRoot }
      : {}),
    developmentAuth: {
      enabled: true,
      defaultUserId: "author",
      users: ["author", "other"].map((id) => ({
        id,
        externalUserId: id,
        displayLabel: id,
        email: `${id}@example.test`,
        roles: id === "author" ? ["user", "admin", "superadmin"] : ["user"]
      }))
    },
    modelBindings: [
      { id: "first", providerId: "local", userSelectable: true },
      {
        id: "picked",
        providerId: "local",
        userSelectable: true,
        reasoningEffort: "high",
        userSelectableReasoningEfforts: selection.defaultEffortOnly ? [] : ["high"]
      }
    ],
    agentModelBindingId: "first",
    agentUserSelectableModelBindingIds: ["first", "picked"]
  });
  config.conversationTitles.enabled = false;
  config.infrastructure.models = { local: { provider: "follow-up-test", model: "local" } };
  const app = await createTestInstance({
    config,
    env: {},
    capabilities: [{ name: "follow-up-test", providers: [provider], create: () => ({}) }],
    tools: [],
    ...(separate ? { agentRunWorker: "separate" as const } : {})
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const author = (await app.call("me.get", {}, "author")).json<{ id: string }>();
  const other = (await app.call("me.get", {}, "other")).json<{ id: string }>();
  const workspace = (
    await app.call("workspaces.create", { payload: { name: "Follow-ups" } }, "author")
  ).json<{ id: string }>();
  const add = await app.call(
    "workspaces.members.add",
    {
      params: { collaborationWorkspaceId: workspace.id },
      payload: { email: "other@example.test" }
    },
    "author"
  );
  expect(add.statusCode, add.body).toBe(200);
  const created = await app.call(
    "conversations.create",
    { payload: { title: "Follow-ups", collaborationWorkspaceId: workspace.id } },
    "author"
  );
  expect(created.statusCode, created.body).toBe(200);
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const scope = { clientInstanceId, conversationId };
  const run = async (id: string) =>
    required(await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId: asAgentRunId(id) }));
  const until = (id: string, status: AgentRunStatus) =>
    waitUntil(async () => (await run(id)).status === status, `run ${id} is ${status}`);
  const first = await injectStartConversationRun(app, conversationId, "First");
  if (!separate) await waitUntil(async () => gates.length === 1, "first model turn is held");
  return {
    app,
    scope,
    author,
    other,
    workspace,
    first: { run: first.run },
    run,
    until,
    release: () => required(gates[0]).resolve(),
    advance: () => required(deltaGates.at(-1)).resolve(),
    pending: () => app.stores.followUps.listPending(scope),
    messages: () => app.stores.conversations.listMessages(scope),
    async queue(text: string, as = "author", key: string = createPlatformId("send")) {
      const response = await app.call(
        "conversations.runs.start",
        {
          params: { conversationId },
          payload: {
            followUp: "queue",
            idempotencyKey: key,
            modelBindingId: "picked",
            ...(selection.defaultEffortOnly ? {} : { reasoningEffort: "high" }),
            message: { text }
          }
        },
        as
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ followUp: ConversationFollowUp }>().followUp;
    },
    async fail() {
      required(gates[0]).reject(new Error("Provider fixture failed"));
      await until(first.run.id, "failed");
    },
    async complete(id = first.run.id, turn = 0) {
      await waitUntil(async () => gates[turn] !== undefined, "model turn is held");
      required(gates[turn]).resolve();
      await until(id, "completed");
    },
    async dispatch() {
      await getTestJobs(app).runDue();
    },
    async attachment(recognized = false) {
      const file = await app.stores.files.createManagedFile({
        clientInstanceId,
        ownerUserId: author.id,
        filename: "queued.txt",
        mimeType: "text/plain",
        byteSize: 1,
        checksum: createPlatformId("checksum"),
        objectKey: createPlatformId("follow-up-test")
      });
      return app.stores.files.createConversationAttachment({
        ...scope,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        ...(recognized ? { processingMetadata: { source: "execution_workspace_source" } } : {})
      });
    }
  };
}
