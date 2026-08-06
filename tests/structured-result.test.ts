import { describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  asConversationId,
  asMessageId,
  createToolResultMetadata,
  currentStructuredResults,
  type ChatMessage,
  type StructuredResultPublication
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";

describe("structured result projection", () => {
  it("keeps the first kind for a key and ignores later conflicting publications", () => {
    const messages = [
      publicationMessage("msg_a", "2026-08-06T10:00:00.000Z", {
        key: "review",
        kind: "example.review",
        schemaVersion: 1,
        title: "Initial review",
        data: { value: "initial" }
      }),
      publicationMessage("msg_b", "2026-08-06T10:00:01.000Z", {
        key: "review",
        kind: "example.other",
        schemaVersion: 1,
        title: "Conflicting review",
        data: { value: "conflicting" }
      }),
      publicationMessage("msg_c", "2026-08-06T10:00:02.000Z", {
        key: "review",
        kind: "example.review",
        schemaVersion: 2,
        title: "Current review",
        data: { value: "current" }
      })
    ];

    expect(currentStructuredResults(messages)).toEqual([
      {
        key: "review",
        kind: "example.review",
        schemaVersion: 2,
        title: "Current review",
        data: { value: "current" },
        revision: 2,
        createdAt: "2026-08-06T10:00:00.000Z",
        updatedAt: "2026-08-06T10:00:02.000Z"
      }
    ]);
  });

  it("preserves durable message order when publication timestamps are equal", () => {
    const timestamp = "2026-08-06T10:00:00.000Z";
    const first = publicationMessage("msg_a", timestamp, {
      key: "review",
      kind: "example.review",
      schemaVersion: 1,
      title: "First by id",
      data: { value: "first" }
    });
    const second = publicationMessage("msg_b", timestamp, {
      key: "review",
      kind: "example.review",
      schemaVersion: 1,
      title: "Second by id",
      data: { value: "second" }
    });

    expect(currentStructuredResults([first, second])).toEqual([
      {
        key: "review",
        kind: "example.review",
        schemaVersion: 1,
        title: "Second by id",
        data: { value: "second" },
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);
  });

  it("preserves append order for equal-timestamp in-memory conversation reads", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-06T10:00:00.000Z"));
      const clientInstanceId = asClientInstanceId("client_test");
      const store = new InMemoryPlatformStore();
      const conversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: "user_test",
        ownerExternalUserId: "user_test",
        title: "Test",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      for (const id of ["msg_b", "msg_a"]) {
        await store.appendMessage({
          id: asMessageId(id),
          clientInstanceId,
          conversationId: conversation.id,
          role: "user",
          text: id
        });
      }

      await expect(
        store.listMessages({ clientInstanceId, conversationId: conversation.id })
      ).resolves.toMatchObject([{ id: "msg_b" }, { id: "msg_a" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function publicationMessage(
  id: string,
  createdAt: string,
  structuredResult: StructuredResultPublication
): ChatMessage {
  return {
    id: asMessageId(id),
    clientInstanceId: asClientInstanceId("client_test"),
    conversationId: asConversationId("conversation_test"),
    role: "tool",
    text: '{"saved":true}',
    createdAt,
    metadata: createToolResultMetadata({
      runId: "run_test",
      toolCall: {
        toolCallId: `call_${id}`,
        toolName: "example.publish",
        input: {}
      },
      result: {
        status: "success",
        structuredResult
      },
      modelOutput: { text: '{"saved":true}' }
    })
  };
}
