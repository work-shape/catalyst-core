import { describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  scheduleDedupeKey
} from "@work-shape/catalyst-core";
import { expireConversationsJob } from "@work-shape/catalyst-server";
import { createTestConfig } from "./support/fixtures";
import { createTestInstanceWith, getTestJobs } from "./support/test-instance";

describe("conversation cleanup without object storage", () => {
  it.each([true, false])(
    "retries Operation Run cleanup after a transient deletion failure with expiry %s",
    async (expireConversations) => {
      const config = createTestConfig();
      config.retention.expireConversations = expireConversations;
      // The default instance has neither attachments nor Pages storage.
      const instance = await createTestInstanceWith(() => ({ config }));
      const clientInstanceId = asClientInstanceId(config.clientInstance.id);
      const created = await instance.call("conversations.create", {
        payload: { title: "Database-only cleanup" }
      });
      expect(created.statusCode).toBeLessThan(300);
      const conversationId = asConversationId(created.json<{ id: string }>().id);
      const runs = instance.stores.operationRuns;
      const output = { value: { sensitive: "conversation output" } };
      const run = await runs.create({
        id: createPlatformId<"OperationRunId">("oprun"),
        clientInstanceId,
        conversationId,
        operation: "items.create",
        effect: "changing",
        target: "live",
        actor: { kind: "user", id: "user-1", label: "One" },
        origin: { kind: "user" },
        inputHash: "a".repeat(64),
        correlationId: "corr_cleanup_without_storage",
        startedAt: new Date().toISOString()
      });
      if (!run) throw new Error("The operation must start a run");
      await runs.finish({
        clientInstanceId,
        id: run.id,
        end: { status: "done", finishedAt: new Date().toISOString(), output }
      });
      const storedRun = () => runs.get({ clientInstanceId, id: run.id });
      const pending = () =>
        instance.stores.files.listConversationsPendingObjectCleanup({
          clientInstanceId,
          limit: 100
        });
      const removeRuns = vi
        .spyOn(runs, "deleteOfConversations")
        .mockRejectedValueOnce(new Error("Transient Operation Run cleanup failure"));
      try {
        const deleted = await instance.call("conversations.delete", {
          params: { conversationId }
        });
        expect(deleted.statusCode).toBeLessThan(300);
        expect(removeRuns).toHaveBeenCalledTimes(1);
        expect(
          await instance.stores.conversations.getConversation(clientInstanceId, conversationId)
        ).toMatchObject({ status: "deleted" });
        await expect(storedRun()).resolves.toMatchObject({ output });
        await expect(pending()).resolves.toContain(conversationId);

        // Age pruning deliberately leaves conversation-linked runs for conversation cleanup.
        await runs.deleteWithoutConversationOlderThan({ clientInstanceId, days: 0, limit: 100 });
        await expect(storedRun()).resolves.toMatchObject({ output });

        await instance.stores.jobs.enqueue(
          expireConversationsJob,
          {},
          {
            clientInstanceId,
            dedupeKey: scheduleDedupeKey(expireConversationsJob.kind)
          }
        );
        await getTestJobs(instance).runDue();

        await expect(storedRun()).resolves.toBeUndefined();
        expect(removeRuns).toHaveBeenCalledTimes(2);
        await expect(pending()).resolves.not.toContain(conversationId);
      } finally {
        removeRuns.mockRestore();
      }
    }
  );
});
