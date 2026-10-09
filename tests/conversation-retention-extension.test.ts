import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createApiClient, type SafeConfig } from "@vivd-catalyst/api-client";
import { ConversationRetentionWorkflow } from "@vivd-catalyst/chat-server";
import {
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  type ClientInstanceId,
  type Conversation,
  type PlatformStores
} from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import {
  RecordingByteStore,
  createAttachedObjects,
  createManagedObjectAttachmentService,
  createRetentionOptions,
  createTestManagedObjectAccess
} from "./support/retention-harness";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";

/** The retention period of every instance in this file. */
const CONVERSATION_DAYS = 30;

describe("retention counts from the last message", () => {
  it("moves the date with an accepted message and with nothing else", async () => {
    const app = await createApp({ extendOnActivity: true });
    const conversation = await createConversation(app, "Quarterly offer");
    await setDaysLeft(conversation.id, 10);

    const renamed = await app.call("conversations.rename", {
      params: { conversationId: conversation.id },
      payload: { title: "Renamed" }
    });
    expect(renamed.statusCode).toBe(200);
    const read = await app.call("conversations.thread.get", {
      params: { conversationId: conversation.id }
    });
    expect(read.statusCode).toBe(200);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);

    // Day 20 of 30: the date moves to day 50.
    const sent = await injectStartConversationRun(app, conversation.id, "Still needed");
    await drainRunEvents(app, conversation.id, sent.run.id);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(CONVERSATION_DAYS, 1);

    // The title job belongs to that first message and runs later. It is not activity.
    await setDaysLeft(conversation.id, 10);
    await getTestJobs(app).runDue();
    await expect(titleJobStatus(conversation.id)).resolves.toBe("succeeded");
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);
  });

  it("keeps the date set at creation when the instance does not extend on activity", async () => {
    const app = await createApp({ extendOnActivity: false });
    const conversation = await createConversation(app, "Fixed maximum age");
    await setDaysLeft(conversation.id, 10);

    const sent = await injectStartConversationRun(app, conversation.id, "A later message");
    await drainRunEvents(app, conversation.id, sent.run.id);
    await getTestJobs(app).runDue();

    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(10, 1);
  });

  it("extends by default and says so in the config the interface loads", async () => {
    expect(createTestConfig().retention.extendOnActivity).toBe(true);
    const app = await createApp({ extendOnActivity: true });
    const answer = await app.call("config.get", {});
    expect(answer.json<SafeConfig>().retention.extendOnActivity).toBe(true);
  });

  it("loads the config answer of an API from before the setting", async () => {
    const app = await createApp({ extendOnActivity: true });
    const current = (await app.call("config.get", {})).json<SafeConfig>();
    // The previous release answers these four retention keys and no other.
    const { conversationDays, expireConversations, auditDays, allowUserDelete } = current.retention;
    const previous = {
      ...current,
      retention: { conversationDays, expireConversations, auditDays, allowUserDelete }
    };
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetchImpl: async () => Response.json(previous)
    });

    const loaded = await client.config.get();
    expect(loaded.retention).toEqual(previous.retention);
    // The interface reads the missing key as false and promises nothing.
    expect(loaded.retention.extendOnActivity).toBeUndefined();
  });

  it("keeps a due conversation with all its files when a message arrives before the claim", async () => {
    const clientInstanceId = asClientInstanceId("retention-extension-claim");
    const store = (await createTestInstance()).stores;
    const byteStore = new RecordingByteStore();
    const managedObjects = createTestManagedObjectAccess({
      clientInstanceId,
      files: store.files,
      byteStore
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects }),
      workspaceObjects: byteStore
    });
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "Due",
      retainedUntil: "2024-01-01T00:00:00.000Z"
    });
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "The first message"
    });
    const objects = await createAttachedObjects({
      store: store.files,
      managedObjects,
      clientInstanceId,
      conversation
    });

    // The job has read its list of due conversations; the message lands before the claim.
    let listedAsDue: string[] = [];
    const workflow = new ConversationRetentionWorkflow({
      ...options,
      stores: {
        ...options.stores,
        conversations: {
          ...options.stores.conversations,
          async listExpiredConversations(input) {
            const due = await options.stores.conversations.listExpiredConversations(input);
            listedAsDue = due.map((listed) => listed.id);
            await acceptMessage(store, clientInstanceId, conversation, CONVERSATION_DAYS);
            return due;
          }
        }
      }
    });

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 0,
      cleanupPendingCount: 0
    });
    expect(listedAsDue).toEqual([conversation.id]);
    await expect(
      store.conversations.getConversation(clientInstanceId, conversation.id)
    ).resolves.toMatchObject({ status: "active" });
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(CONVERSATION_DAYS, 1);
    await expect(
      store.conversations.listMessages({ clientInstanceId, conversationId: conversation.id })
    ).resolves.toHaveLength(2);
    await expect(
      store.files.getConversationAttachment({
        clientInstanceId,
        attachmentId: objects.attachment.id
      })
    ).resolves.toMatchObject({ id: objects.attachment.id });
    await expect(
      store.files.getManagedFile({ clientInstanceId, fileId: objects.file.id })
    ).resolves.toMatchObject({ id: objects.file.id });
    await expect(
      store.files.getManagedArtifact({ clientInstanceId, artifactId: objects.artifact.id })
    ).resolves.toMatchObject({ status: "available" });
    expect(byteStore.has(objects.file.objectKey)).toBe(true);
    expect(byteStore.has(objects.artifact.objectKey)).toBe(true);
    expect(byteStore.deleteAttempts).toEqual([]);
  });

  it("leaves the later date when two messages are accepted at once", async () => {
    const clientInstanceId = asClientInstanceId("retention-extension-race");
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: "Two at once",
      retainedUntil: new Date().toISOString()
    });

    // Both wait for the Conversation row lock. A Conversation runs one message at a time, so
    // the second is accepted only if the first one's run has ended by then.
    const periods = [60, CONVERSATION_DAYS];
    const outcomes = await Promise.allSettled(
      periods.map((days) => acceptMessage(store, clientInstanceId, conversation, days))
    );
    const accepted = periods.filter((_, index) => outcomes[index]?.status === "fulfilled");
    expect(accepted.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "CONFLICT" });
      }
    }
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(Math.max(...accepted), 1);

    // Whatever the order, the date only moves later: a shorter period never takes it back.
    await acceptMessage(store, clientInstanceId, conversation, 60);
    await acceptMessage(store, clientInstanceId, conversation, CONVERSATION_DAYS);
    await expect(daysLeft(conversation.id)).resolves.toBeCloseTo(60, 1);
  });
});

function createApp(retention: { extendOnActivity: boolean }): Promise<TestInstance> {
  const config = createTestConfig();
  config.retention.conversationDays = CONVERSATION_DAYS;
  config.retention.extendOnActivity = retention.extendOnActivity;
  return createTestInstance({ config, env: {}, tools: [] });
}

async function createConversation(app: TestInstance, title: string): Promise<{ id: string }> {
  const created = await app.call("conversations.create", { payload: { title } });
  expect(created.statusCode).toBe(200);
  return created.json<{ id: string }>();
}

/** Accepts a user message and ends its run, so the Conversation is idle afterwards. */
async function acceptMessage(
  store: PlatformStores,
  clientInstanceId: ClientInstanceId,
  conversation: Conversation,
  extendRetentionDays: number
): Promise<void> {
  const id = globalThis.crypto.randomUUID();
  const inputMessageId = asMessageId(`msg_${id}`);
  const { run } = await store.agentRuns.prepareConversationRunStart({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: conversation.createdByUserId,
    userMessage: { id: inputMessageId, text: "Still needed" },
    run: {
      id: asAgentRunId(`run_${id}`),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: conversation.createdByUserId,
      inputMessageId,
      agentName: "test_agent",
      correlationId: `corr_${id}`
    },
    extendRetentionDays
  });
  const endedAt = new Date().toISOString();
  await store.agentRuns.updateAgentRunStatus({
    clientInstanceId,
    runId: run.id,
    status: "completed",
    updatedAt: endedAt,
    completedAt: endedAt
  });
}

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** Puts the Conversation that many days before its date, as on a later day of its period. */
function setDaysLeft(conversationId: string, days: number): Promise<void> {
  return withSql(async (sql) => {
    await sql`
      update conversations set retained_until = now() + make_interval(days => ${days})
      where id = ${conversationId}`;
  });
}

/** Days from the database's present to the retention date, on the clock the store uses. */
function daysLeft(conversationId: string): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ days: number }[]>`
      select (extract(epoch from retained_until - now()) / 86400)::float8 as days
      from conversations where id = ${conversationId}`;
    if (!row) throw new Error("Conversation row is missing");
    return row.days;
  });
}

function titleJobStatus(conversationId: string): Promise<string | undefined> {
  return withSql(async (sql) => {
    const [row] = await sql<{ status: string }[]>`
      select status from platform_jobs
      where kind = 'conversation.generate_title' and subject = ${conversationId}`;
    return row?.status;
  });
}
