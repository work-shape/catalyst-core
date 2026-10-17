import { describe, expect, it, vi } from "vitest";
import type { ConversationThreadSnapshot } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { followUpFixture as fixture } from "./support/follow-up-fixture";

// A step that runs once, after a read has taken the transcript and before it reads on. It
// stands for a commit that lands in the middle of a thread read.
const afterTranscriptRead = vi.hoisted(() => {
  const hook: { step?: () => Promise<void> } = {};
  return hook;
});
vi.mock(
  "../packages/postgres-store/src/postgres-conversation-operations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../packages/postgres-store/src/postgres-conversation-operations")
      >();
    return {
      ...actual,
      createPostgresConversationsStore(
        ...args: Parameters<typeof actual.createPostgresConversationsStore>
      ) {
        const store = actual.createPostgresConversationsStore(...args);
        return {
          ...store,
          async listMessages(input: Parameters<typeof store.listMessages>[0]) {
            const messages = await store.listMessages(input);
            const step = afterTranscriptRead.step;
            afterTranscriptRead.step = undefined;
            await step?.();
            return messages;
          }
        };
      }
    };
  }
);

describe("a thread read while the queue moves on Postgres", () => {
  // Release blocker of rc.3 (follow-up-queue.spec.ts:235): a member's message that started
  // while the owner's page read the thread was in neither the queue nor the transcript of
  // that read. With no run and nothing queued, the page never read again and never showed it.
  it("shows a member's follow-up that starts during the read either queued or sent", async () => {
    const f = await fixture();
    const own = await f.queue("Owner next");
    const member = await f.queue("Member next", "other");
    await f.complete();
    await f.dispatch();
    const ownRun = required(
      required(await f.app.stores.followUps.get({ ...f.scope, followUpId: own.id })).dispatchedRunId
    );
    await f.complete(ownRun, 1);

    // The owner's turn completed. The member's message starts while the owner reads.
    afterTranscriptRead.step = () => f.dispatch();
    const response = await f.app.call("conversations.thread.get", {
      params: { conversationId: f.scope.conversationId }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(afterTranscriptRead.step).toBeUndefined();
    expect(await f.app.stores.followUps.get({ ...f.scope, followUpId: member.id })).toMatchObject({
      status: "dispatched"
    });

    const thread = response.json<ConversationThreadSnapshot>();
    const queued = (thread.followUps ?? []).some((item) => item.id === member.id);
    const sent = thread.messages.some(
      (message) => message.role === "user" && message.text === "Member next"
    );
    expect(queued || sent, "the member's message is queued or in the transcript").toBe(true);
    expect(queued && sent, "the member's message is not both queued and sent").toBe(false);
    // A sent message comes with its run, which the page then follows.
    if (sent) expect(thread.activeRun).toBeDefined();
  });
});
