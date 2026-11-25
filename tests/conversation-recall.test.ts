import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  HISTORY_CUT_POINTER,
  asClientInstanceId,
  asConversationId,
  recallTsQuery,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { modelContentText } from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createConversationWithMessages, noReportedUsage } from "./helpers/agent-runtime";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// RECALL-1: an agent reaches its own conversation's messages that its run did not send the
// model, behind a compaction checkpoint or the window of the last 20 messages, and nothing of
// any other conversation. Without the change no tool reached them and the model was not told
// they exist.

const OWNER = "owner";

describe("the agent's search and read of its own chat", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it("builds every word as a prefix and a quoted phrase as a phrase, from letters and digits only", () => {
    expect(recallTsQuery("Checkliste")).toBe("checkliste:*");
    expect(recallTsQuery('Flurstück "Kaufvertrag vom" 12')).toBe(
      "(kaufvertrag <-> vom) & flurstück:* & 12:*"
    );
    expect(recallTsQuery("'); drop table messages; --")).toBe("drop:* & table:* & messages:*");
    expect(recallTsQuery(" ?! ")).toBeUndefined();
  });

  it("after a compaction checkpoint tells the model the earlier messages exist and hands its calls the cut", async () => {
    const clientInstanceId = asClientInstanceId("recall-compaction-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-recall",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const instance = await createTestInstance();
    open = instance;
    const store = instance.stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: [
        { role: "user", text: "Old question" },
        { role: "assistant", text: "Old answer" }
      ]
    });
    const provider: ModelProviderConfig = {
      id: "test-provider",
      type: "openai-compatible",
      api: "responses",
      model: "test-model",
      contextManagement: { compaction: { compactThresholdTokens: 270000 } }
    };
    const requests: Parameters<FakeModelProvider["complete"]>[0][] = [];
    const cuts: unknown[] = [];
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            text: "After compaction.",
            toolCalls: [],
            continuation: {
              providerId: "test-provider",
              state: { compaction: { type: "compaction", encrypted_content: "opaque" } }
            },
            contextManagement: { compacted: true },
            usage: { ...noReportedUsage(), inputTokens: 269000, totalTokens: 269100 }
          };
        }
        return requests.length === 2
          ? {
              text: "",
              toolCalls: [
                { toolCallId: "read", toolName: "platform.history.read", input: { before: "cut" } }
              ],
              usage: noReportedUsage()
            }
          : { text: "Done.", toolCalls: [], usage: noReportedUsage() };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "recall_agent",
              displayName: "Recall Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: ["platform.history.read"],
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
        toolRegistry: new ToolRegistry({
          tools: [
            defineTool({
              name: "platform.history.read",
              effect: "reading",
              description: "Read earlier in this chat.",
              inputSchema: z.object({ before: z.string().optional() }),
              async execute() {
                throw new Error("The test runs the tool itself");
              }
            })
          ]
        }),
        runTool: async (_request, callContext) => {
          cuts.push(callContext.historyCut);
          return {
            status: "success",
            output: { messages: [], moreBefore: true, moreAfter: false }
          };
        },
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const turn = async (text: string) => {
      const message = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId,
        role: "user",
        text
      });
      const run = await runtime.start(
        {
          agentName: "recall_agent",
          conversationId,
          inputMessageId: message.id,
          message: { text }
        },
        context
      );
      for await (const _event of runtime.observe(run.runId, context)) {
        /* drain */
      }
    };
    const systemOf = (index: number) =>
      modelContentText(requests[index]?.messages.find((m) => m.role === "system")?.content ?? "");

    await turn("Compact this conversation");
    // The first run sends the whole history: no cut, no pointer.
    expect(systemOf(0)).not.toContain(HISTORY_CUT_POINTER);

    await turn("What did I ask first?");
    const checkpoint = (
      await store.conversations.listMessages({ clientInstanceId, conversationId })
    )
      .filter((message) => message.text === "After compaction.")
      .at(-1);
    expect(systemOf(1)).toContain(HISTORY_CUT_POINTER);
    expect(cuts).toEqual([{ messageId: checkpoint?.id }]);
  });

  it("past the window of 20 messages finds, reads around and reads before the cut, and nothing of another chat", async () => {
    const config = createTestConfig({
      toolNames: [],
      developmentAuth: {
        enabled: true,
        defaultUserId: OWNER,
        users: [{ id: OWNER, externalUserId: OWNER, displayLabel: "Owner", roles: ["user"] }]
      }
    });
    const app = await createTestInstance({ config, tools: [] });
    open = app;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const create = async (title: string) => {
      const created = await app.call("conversations.create", { payload: { title } }, OWNER);
      expect(created.statusCode, created.body).toBe(200);
      return asConversationId(z.object({ id: z.string() }).parse(created.json()).id);
    };
    const chat = await create("Lindenweg");
    const other = await create("Other");
    await app.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: other,
      role: "user",
      text: "Die Checklisten vom anderen Chat"
    });
    const texts = [
      "Bitte die Checklisten für das Flurstück 12 prüfen.",
      "Die Checkliste für den Kaufvertrag vom Notar fehlt noch.",
      ...Array.from({ length: 22 }, (_, index) => `Nachricht ${index + 3}`)
    ];
    for (const [index, text] of texts.entries()) {
      await app.stores.conversations.appendMessage({
        clientInstanceId,
        conversationId: chat,
        role: index % 2 === 0 ? "user" : "assistant",
        text
      });
    }
    const ask = async (tool: string, input: unknown) => {
      const started = await injectStartConversationRun(
        app,
        chat,
        `/tool ${tool} ${JSON.stringify(input)}`
      );
      await drainRunEvents(app, chat, started.run.id);
      const listed = z
        .object({ items: z.array(z.object({ role: z.string(), text: z.string() })) })
        .parse(
          (
            await app.call(
              "conversations.messages.list",
              { params: { conversationId: chat } },
              OWNER
            )
          ).json()
        );
      const text = listed.items.filter((message) => message.role === "tool").at(-1)?.text;
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    };
    const hitsSchema = z.object({
      hits: z.array(z.object({ messageId: z.string(), snippet: z.string() })),
      more: z.boolean()
    });
    const readSchema = z.object({
      messages: z.array(z.object({ messageId: z.string(), text: z.string() })),
      moreBefore: z.boolean(),
      moreAfter: z.boolean()
    });

    // "checkliste" finds "Checklisten" before the cut, and a conversation id named in the
    // input changes nothing: the other chat's message is never a hit.
    const found = hitsSchema.parse(
      await ask("platform.history.search", { query: "checkliste", conversationId: other })
    );
    expect(found.hits.map((hit) => hit.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("«Checklisten»"),
        expect.stringContaining("«Checkliste»")
      ])
    );
    expect(found.hits).toHaveLength(2);
    const first = found.hits.find((hit) => hit.snippet.includes("«Checklisten»"));
    expect(found.hits.every((hit) => hit.snippet.length <= 300)).toBe(true);
    // A quoted phrase matches only as a phrase.
    const phrase = hitsSchema.parse(
      await ask("platform.history.search", { query: '"Kaufvertrag vom Notar"' })
    );
    expect(phrase.hits).toHaveLength(1);
    expect(
      hitsSchema.parse(await ask("platform.history.search", { query: '"Notar vom Kaufvertrag"' }))
        .hits
    ).toEqual([]);

    const around = readSchema.parse(
      await ask("platform.history.read", { around: first?.messageId })
    );
    expect(around.messages[0]?.text).toBe(texts[0]);
    expect(around.moreBefore).toBe(false);

    // The run sends the last 20 messages of its history: what is before them is read from the
    // cut backwards, and ends with the message just before the first one sent.
    const beforeCut = readSchema.parse(
      await ask("platform.history.read", { before: "cut", limit: 30 })
    );
    expect(beforeCut.messages[0]?.text).toBe(texts[0]);
    expect(beforeCut.moreBefore).toBe(false);
    expect(beforeCut.messages.length).toBeGreaterThan(2);
    expect(beforeCut.messages.map((message) => message.text)).not.toContain(
      "Die Checklisten vom anderen Chat"
    );

    // A chat in no project is not offered the project's chats (RECALL-2).
    const toolRows = async () =>
      z
        .object({ items: z.array(z.object({ role: z.string(), text: z.string() })) })
        .parse(
          (
            await app.call(
              "conversations.messages.list",
              { params: { conversationId: chat } },
              OWNER
            )
          ).json()
        )
        .items.filter((message) => message.role === "tool").length;
    const before = await toolRows();
    const offeredHistory = await ask("platform.history.search", { query: "checkliste" });
    expect(offeredHistory).toMatchObject({ more: false });
    expect(await toolRows()).toBe(before + 1);
    await ask("platform.conversations.search", {});
    expect(await toolRows()).toBe(before + 1);

    // The Operation Runs and audit rows of these calls hold counts, never the words.
    const runs = await app.stores.operationRuns.list({ clientInstanceId });
    const audit = await app.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    const kept = JSON.stringify([runs, audit]);
    expect(runs.some((run) => run.operation === "platform.history.search")).toBe(true);
    for (const words of ["checkliste", "Kaufvertrag", "Flurstück", "Notar"]) {
      expect(kept).not.toContain(words);
    }
  });
});
