import { describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asToolCallId,
  asCollaborationWorkspaceId,
  asClientInstanceId,
  asConversationId,
  createModuleRegistry,
  createOperationRegistry,
  resolvePolicy,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { createPlatformTools, platformModules } from "@work-shape/catalyst-client-assembly";
import {
  createKnowledgeAddFilesTool,
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  registerToolOperations
} from "@work-shape/catalyst-tool-execution";

describe("the chat attachment Knowledge Base tool", () => {
  it("is offered to platform agents only when Knowledge Bases are on", async () => {
    const getConversation = vi.fn<PlatformStores["conversations"]["getConversation"]>();
    getConversation.mockResolvedValue({
      id: asConversationId("conversation"),
      clientInstanceId: asClientInstanceId("demo"),
      collaborationWorkspaceId: asCollaborationWorkspaceId("workspace"),
      createdByUserId: "user",
      createdByExternalUserId: "user",
      kind: "chat",
      visibility: "private",
      status: "active",
      title: "Files",
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      retainedUntil: "2026-11-18T00:00:00.000Z"
    });
    for (const enabled of [true, false]) {
      const modules = createModuleRegistry(platformModules).snapshot({
        dataStores: { enabled: true },
        knowledge: { enabled }
      });
      const platform = createPlatformTools({
        stores: { conversations: { getConversation } },
        modules
      });
      const registry = platform.registry(platform.tools, new Set());
      expect(registry.has(KNOWLEDGE_ADD_FILES_TOOL_NAME)).toBe(enabled);
      for (const agentToolNames of [["platform.assets.get"], []]) {
        const offer = await platform.conversationOffer.offerOf({
          clientInstanceId: asClientInstanceId("demo"),
          conversationId: asConversationId("conversation"),
          agentToolNames
        });
        expect(offer?.toolNames.includes(KNOWLEDGE_ADD_FILES_TOOL_NAME)).toBe(
          enabled && agentToolNames.length > 0
        );
      }
    }
  });

  it("projects the native write, without an allow override or a second operation", async () => {
    const tool = createKnowledgeAddFilesTool();
    expect(tool.effect).toBe("changing");
    expect(tool.permission).toBeUndefined();
    const registry = createOperationRegistry();
    registerToolOperations(registry, [tool], { clientInstanceId: asClientInstanceId("demo") });
    expect((await registry.list()).operations).toEqual([]);
    expect(
      tool.inputSchema.safeParse({
        knowledgeBase: "notes",
        files: [{ conversationId: "conversation", fileId: "file" }]
      }).success
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({ knowledgeBase: "notes.add_files", files: [] }).success
    ).toBe(false);
    expect(
      resolvePolicy({
        definition: { name: "knowledge.notes.add_files", effect: "changing" },
        origin: {
          kind: "agent",
          agentName: "builder",
          toolName: "knowledge.notes.add_files",
          agentRunId: asAgentRunId("run"),
          conversationId: asConversationId("conversation"),
          toolCallId: asToolCallId("call")
        },
        instanceDefaults: { reading: "allow", changing: "confirm" },
        centralSettings: [],
        callerCanConfirm: false,
        canPause: true
      })
    ).toMatchObject({ value: "confirm", next: "await_confirmation" });
  });
});
