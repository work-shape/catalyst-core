import { describe, expect, it } from "vitest";
import { ConversationRetentionWorkflow, storePageFileSet } from "@vivd-catalyst/chat-server";
import { asClientInstanceId, asConversationId } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { createRetentionOptions } from "./support/retention-harness";
import { createTestInstanceWith } from "./support/test-instance";

// The retention job finishes what a deletion could not: here the files store fails while a
// Conversation is deleted, on an instance that keeps no attachments.

/** A files store whose next removal of a folder fails, as a store that is not reachable does. */
class FailingOnceObjectStorage extends MemoryObjectStorage {
  failNext = false;

  override async deletePrefix(prefix: string): Promise<{ deleted: number }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("The files store did not answer");
    }
    return super.deletePrefix(prefix);
  }
}

const text = (value: string) => new TextEncoder().encode(value);

describe("the cleanup retry of the retention job", () => {
  it("removes the rows and files of the Pages a failed deletion left, without an attachment service", async () => {
    const objects = new FailingOnceObjectStorage();
    const pages = { objects };
    const instance = await createTestInstanceWith(() => ({ pages }));
    const clientInstanceId = asClientInstanceId(createTestConfig().clientInstance.id);
    const stores = instance.stores;
    const created = await instance.call("conversations.create", { payload: { title: "Pages" } });
    const conversationId = asConversationId(created.json<{ id: string }>().id);
    const stored = await storePageFileSet(
      { clientInstanceId, stores, pages },
      {
        conversationId,
        pageName: "Offer",
        kitVersion: "1.0.0",
        manifest: { entry: "index.html" },
        sourceFiles: [{ path: "index.html", bytes: text("<!doctype html><title>Offer</title>") }],
        builtFiles: [{ path: "index.html", bytes: text("<!doctype html><title>Offer</title>") }]
      }
    );
    const pageIds = () =>
      stores.pages.listConversationPageIds({ clientInstanceId, conversationId });
    const storedObjects = async () =>
      (await objects.list(`pages/${stored.page.id}/`)).objects.length;

    objects.failNext = true;
    const deleted = await instance.call("conversations.delete", { params: { conversationId } });
    expect(deleted.statusCode).toBeLessThan(300);
    // The Conversation is gone for its members. Its Page is what the deletion left behind.
    expect(await pageIds()).toEqual([stored.page.id]);
    expect(await storedObjects()).toBe(2);

    const retention = new ConversationRetentionWorkflow({
      ...createRetentionOptions({ clientInstanceId, store: stores }),
      pages
    });
    await expect(retention.cleanUpPendingConversations()).resolves.toEqual({
      completedCount: 1,
      cleanupPendingCount: 0
    });
    expect(await pageIds()).toEqual([]);
    expect(await storedObjects()).toBe(0);
  });
});
