import { messageSchema, userMessageMetadataSchema } from "@work-shape/catalyst-api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asUserId,
  asClientInstanceId,
  asConversationId,
  readUserMessageMetadata
} from "@work-shape/catalyst-core";
import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import {
  DeterministicModelProvider,
  modelContentText,
  type ModelCompletionRequest
} from "@work-shape/catalyst-model-provider";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createTestInstance, getTestAgentRunJobs } from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { injectStartConversationRun, drainRunEvents } from "./support/chat-server-run-harness";
import { withTestSql } from "./support/test-sql";

const requests: ModelCompletionRequest[] = [];
const reads: string[] = [];
const writes: string[] = [];
const read = defineTool({
  name: "preview.read",
  description: "Read a value with the caller's rights.",
  effect: "reading",
  inputSchema: z.object({ text: z.string() }),
  execute(input, context) {
    reads.push(context.user.externalUserId);
    return toolSuccess({ read: input.text });
  }
});
const write = defineTool({
  name: "preview.write",
  description: "Change a value.",
  effect: "changing",
  permission: { mode: "allow" },
  inputSchema: z.object({ text: z.string() }),
  execute(input) {
    writes.push(input.text);
    return toolSuccess({ changed: input.text });
  }
});
const locked = defineTool({
  name: "preview.locked",
  description: "Read a protected value.",
  effect: "reading",
  permission: { mode: "allow", requiredPermissionRefs: ["preview-secret"] },
  inputSchema: z.object({ text: z.string() }),
  execute(input) {
    reads.push("protected");
    return toolSuccess(input);
  }
});
const AGENT = { kind: "agent", name: "test_agent" };

beforeEach(() => {
  requests.length = reads.length = writes.length = 0;
  vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
    this: DeterministicModelProvider,
    request
  ) {
    requests.push(request);
    const completion = await this.complete(request);
    const prompt = request.messages.findLast((message) => message.role === "user");
    if (modelContentText(prompt?.content ?? "") === "What is your marker?") {
      completion.text = modelContentText(request.messages[0]?.content ?? "").includes(
        "DRAFT-MARKER"
      )
        ? "DRAFT-MARKER"
        : "LIVE-MARKER";
    }
    // Deliberately return a forbidden call even though it is absent from tools.
    if (
      modelContentText(prompt?.content ?? "") === "Invent an asset call" &&
      !request.messages.some((message) => message.role === "tool")
    )
      completion.toolCalls = [
        { toolCallId: "invented", toolName: "platform.assets.put", input: {} }
      ];
    yield { type: "completed", completion };
  });
});
afterEach(() => vi.restoreAllMocks());

async function fixture(startAgentRunJobs = true) {
  const config = createTestConfig({
    toolNames: [
      ...PLATFORM_TOOL_NAMES,
      "propose_skill_change",
      "read_skill",
      read.name,
      locked.name
    ],
    tools: [read.name, write.name, locked.name, "read_skill"].map((name) => ({
      name,
      enabled: true
    }))
  });
  config.modules = { assetManagement: { enabled: true } };
  config.conversationTitles.enabled = false;
  config.administration.agentConfiguration.enabled = true;
  config.administration.agentConfiguration.agentSkillChanges.enabled = true;
  config.tools.push({ name: "propose_skill_change", enabled: true, config: {} });
  config.administration.agentConfiguration.allowSkillEditing = true;
  config.administration.agentConfiguration.editableAgentFields = [
    "instructions",
    "toolNames",
    "skillNames"
  ];
  const app = await createTestInstance({
    config,
    env: {},
    startAgentRunJobs,
    tools: [read, write, locked]
  });
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);
  const ok = async (response: ReturnType<typeof app.call>) => {
    const value = await response;
    expect(value.statusCode, value.body).toBe(200);
    return value;
  };
  const live = async () => {
    const asset = await app.stores.configAssets.getConfigAsset({ clientInstanceId, ...AGENT });
    if (!asset) throw new Error("Agent missing");
    return asset;
  };
  const draft = async (
    instructions = "DRAFT-MARKER",
    expectedDraftRevision: number | null = null
  ) => {
    const asset = await live();
    return ok(
      app.call("assets.put", {
        params: AGENT,
        payload: {
          config: {
            ...asset.config,
            instructions,
            toolNames: [
              ...z.object({ toolNames: z.array(z.string()) }).parse(asset.config).toolNames,
              write.name
            ]
          },
          expectedRevision: asset.revision,
          expectedDraftRevision
        }
      })
    );
  };
  const open = async () =>
    (await ok(app.call("agents.try.open", { params: { name: AGENT.name } }))).json<{
      conversation: { id: string };
    }>().conversation.id;
  const say = async (id: string, text: string) => {
    const started = await injectStartConversationRun(app, id, text);
    await drainRunEvents(app, id, started.run.id);
    const run = await app.stores.agentRuns.getAgentRun({
      clientInstanceId,
      runId: asAgentRunId(started.run.id)
    });
    expect(run?.status, JSON.stringify(run?.error)).toBe("completed");
    return app.stores.conversations.listMessages({
      clientInstanceId,
      conversationId: asConversationId(id)
    });
  };
  return { app, config, clientInstanceId, ok, live, draft, open, say };
}

describe("agent preview turns (TRY-1b2)", () => {
  it("runs the frozen draft instead of live, records each revision and flags the live fallback", async () => {
    const t = await fixture();
    const id = await t.open();
    let messages = await t.say(id, "What is your marker?");
    expect(messages.at(-1)?.text).toBe("LIVE-MARKER");
    expect(
      readUserMessageMetadata(messages.find((message) => message.role === "user")?.metadata)
        ?.preview
    ).toMatchObject({ source: "live", revision: (await t.live()).revision });
    await t.draft();
    messages = await t.say(id, "What is your marker?");
    expect(messages.at(-1)?.text).toBe("DRAFT-MARKER");
    await t.draft("DRAFT-MARKER second revision", 1);
    messages = await t.say(id, "What is your marker?");
    const turns = messages
      .filter((message) => message.role === "user")
      .map((message) => readUserMessageMetadata(message.metadata)?.preview);
    expect(turns.map((turn) => [turn?.source, turn?.revision])).toEqual([
      ["live", (await t.live()).revision],
      ["draft", 1],
      ["draft", 2]
    ]);
    expect(turns[1]?.config.instructions).toBe("DRAFT-MARKER");
    expect(turns[2]?.config.instructions).toBe("DRAFT-MARKER second revision");
    const publicReply = await t.ok(
      t.app.call("conversations.messages.list", { params: { conversationId: id } })
    );
    expect(publicReply.body).not.toContain('"config":');
    const publicMessages = z
      .object({ items: z.array(messageSchema) })
      .parse(publicReply.json()).items;
    const publicPreview = userMessageMetadataSchema.parse(
      publicMessages.filter((message) => message.role === "user").at(-1)?.metadata?.agentRuntime
    ).preview;
    expect(publicPreview).toMatchObject({ source: "draft", revision: 2 });
    expect(publicPreview).not.toHaveProperty("config");
  });

  it("keeps an admitted turn on its snapshot when the draft changes before its worker claims it", async () => {
    const t = await fixture(false);
    await t.draft();
    const id = await t.open();
    const started = await injectStartConversationRun(t.app, id, "What is your marker?");
    await t.draft("Live-like replacement with no marker", 1);
    await getTestAgentRunJobs(t.app).runDue();
    await drainRunEvents(t.app, id, started.run.id);
    const messages = await t.app.stores.conversations.listMessages({
      clientInstanceId: t.clientInstanceId,
      conversationId: asConversationId(id)
    });
    expect(messages.at(-1)?.text).toBe("DRAFT-MARKER");
    expect(readUserMessageMetadata(messages[0]?.metadata)?.preview?.revision).toBe(1);
  });

  it.each(["missing", "malformed"])(
    "refuses a queued Try turn with a %s snapshot before calling a model",
    async (mode) => {
      const t = await fixture(false);
      await t.draft();
      const id = await t.open();
      const started = await injectStartConversationRun(t.app, id, "What is your marker?");
      await withTestSql((sql) =>
        mode === "missing"
          ? sql`UPDATE messages SET metadata = '{}'::jsonb WHERE id = ${started.userMessage.id}`
          : sql`UPDATE messages SET metadata = jsonb_set(metadata, '{agentRuntime,preview,config,instructions}', 'null'::jsonb) WHERE id = ${started.userMessage.id}`
      );
      await getTestAgentRunJobs(t.app).runDue();
      await drainRunEvents(t.app, id, started.run.id);
      const run = await t.app.stores.agentRuns.getAgentRun({
        clientInstanceId: t.clientInstanceId,
        runId: asAgentRunId(started.run.id)
      });
      expect(run?.status).toBe("failed");
      expect(run?.error?.message).toContain("preview snapshot is not available");
      expect(requests).toEqual([]);
      expect(writes).toEqual([]);
    }
  );

  it("runs reads live with the person's rights, simulates changes, and charges preview usage to that person", async () => {
    const t = await fixture();
    await t.draft();
    const id = await t.open();
    await t.say(id, '/tool preview.read {"text":"read me"}');
    expect(reads).toEqual(["user-1"]);
    const messages = await t.say(id, '/tool preview.write {"text":"keep me"}');
    expect(writes).toEqual([]);
    expect(messages.filter((message) => message.role === "tool").at(-1)?.text).toContain(
      "Would have performed"
    );
    const runs = (
      await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId })
    ).filter((run) => run.origin.kind === "agent" && run.origin.conversationId === id);
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: read.name, target: "live", status: "done" }),
        expect.objectContaining({
          operation: write.name,
          target: "dry_run",
          status: "done",
          origin: expect.objectContaining({
            draft: expect.objectContaining({
              kind: "agent_preview",
              revisionId: "draft:1",
              asset: expect.objectContaining({ kind: "agent", name: AGENT.name })
            })
          })
        })
      ])
    );
    const usage = (
      await t.app.stores.usage.listModelUsageEvents({ clientInstanceId: t.clientInstanceId })
    ).filter((event) => event.conversationId === id);
    const conversation = await t.app.stores.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(id)
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every((event) => event.preview && event.userId === conversation?.createdByUserId)
    ).toBe(true);
    await t.say(id, '/tool preview.locked {"text":"protected"}');
    expect(reads).not.toContain("protected");
    expect(
      (await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId })).some(
        (run) => run.operation === locked.name && run.status === "denied"
      )
    ).toBe(true);
  });

  it("refuses another Try turn after the person loses the agent write right", async () => {
    const t = await fixture();
    await t.draft();
    const id = await t.open();
    const before = await t.say(id, "What is your marker?");
    const conversation = await t.app.stores.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(id)
    );
    const agent = await t.live();
    if (!conversation) throw new Error("Try conversation missing");
    await t.app.stores.access.createGrant({
      clientInstanceId: t.clientInstanceId,
      holderKind: "user",
      holderId: conversation.createdByUserId,
      action: "agent.write",
      effect: "deny",
      scopeKind: "asset",
      scopeId: agent.id,
      grantedBy: asUserId(conversation.createdByUserId)
    });
    requests.length = 0;
    const response = await t.app.call("conversations.runs.start", {
      params: { conversationId: id },
      payload: { idempotencyKey: crypto.randomUUID(), message: { text: "What is your marker?" } }
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(requests).toEqual([]);
    expect(
      await t.app.stores.conversations.listMessages({
        clientInstanceId: t.clientInstanceId,
        conversationId: asConversationId(id)
      })
    ).toEqual(before);
  });

  it("dry-runs changing calls when Try falls back to the live agent", async () => {
    const t = await fixture();
    await t.draft();
    await t.ok(t.app.call("assets.publish", { params: AGENT, payload: { revision: 1 } }));
    const liveRevision = (await t.live()).revision;
    const id = await t.open();
    const messages = await t.say(id, '/tool preview.write {"text":"live fallback"}');
    expect(writes).toEqual([]);
    expect(readUserMessageMetadata(messages[0]?.metadata)?.preview).toMatchObject({
      source: "live",
      revision: liveRevision
    });
    expect(
      (await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId })).find(
        (run) => run.operation === write.name
      )
    ).toMatchObject({
      target: "dry_run",
      origin: { draft: { revisionId: `live:${liveRevision}` } }
    });
  });

  it("keeps a Try conversation private and with its agent", async () => {
    const t = await fixture();
    const id = await t.open();
    const result = await t.app.call("conversations.move", {
      params: { conversationId: id },
      payload: { collaborationWorkspaceId: "missing", visibility: "workspace" }
    });
    expect(result.statusCode).toBe(422);
    expect(result.body).toContain("preview_conversation_private");
  });

  it("offers no platform asset or skill proposal tools and refuses an invented asset call", async () => {
    const t = await fixture();
    await t.draft();
    const id = await t.open();
    await t.say(id, "Invent an asset call");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(
        request.tools.some(
          (tool) =>
            tool.name.startsWith("platform.") ||
            tool.name === "propose_skill_change" ||
            tool.name === "skill.propose_change"
        )
      ).toBe(false);
      expect(modelContentText(request.messages[0]?.content ?? "")).not.toContain(
        "What the platform tells"
      );
    }
    const rows = await withTestSql(
      (sql) =>
        sql`SELECT operation FROM operation_runs WHERE conversation_id = ${id} AND operation = 'platform.assets.put'`
    );
    expect(rows).toEqual([]);
    expect((await t.live()).revision).toBe(1);
  });

  it("reads the skills the draft lists, not those of the live agent", async () => {
    const t = await fixture();
    for (const name of ["live_skill", "draft_skill"])
      await t.ok(
        t.app.call("assets.put", {
          params: { kind: "skill", name },
          payload: {
            config: { name, title: name, description: name, content: `${name} content` },
            expectedRevision: null
          }
        })
      );
    const withSkills = async (skillNames: string[]) => {
      const asset = await t.live();
      return t.ok(
        t.app.call("assets.put", {
          params: AGENT,
          payload: {
            config: { ...asset.config, skillNames },
            expectedRevision: asset.revision,
            expectedDraftRevision: null
          }
        })
      );
    };
    await withSkills(["live_skill"]);
    await t.ok(t.app.call("assets.publish", { params: AGENT, payload: { revision: 1 } }));
    await withSkills(["draft_skill"]);
    const id = await t.open();
    const lastTool = async (text: string) =>
      (await t.say(id, text)).filter((message) => message.role === "tool").at(-1)?.text;
    expect(await lastTool('/tool read_skill {"name":"draft_skill"}')).toContain(
      "draft_skill content"
    );
    expect(await lastTool('/tool read_skill {"name":"live_skill"}')).toContain(
      "This agent does not have this skill and cannot read it here."
    );
  });
});
