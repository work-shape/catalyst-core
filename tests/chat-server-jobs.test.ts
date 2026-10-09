import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, personalConversationListInput } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";

const clientInstanceId = asClientInstanceId("demo-local");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("the jobs of the API process", () => {
  it("writes the title after the API process restarted before the title job ran", async () => {
    const first = await createApp();
    const message = "Please summarize the release notes";
    const created = await first.call("conversations.create", { payload: { title: message } });
    const conversation = created.json<{ id: string }>();
    const sent = await injectStartConversationRun(first, conversation.id, message, {
      idempotencyKey: "title-before-restart"
    });
    await drainRunEvents(first, conversation.id, sent.run.id);
    // The job committed with the message and no worker has run it.
    await expect(titleJobs(conversation.id)).resolves.toEqual([
      { status: "queued", attempts: 0, dedupe_key: conversation.id }
    ]);
    await first.close();

    const second = await createApp();
    await getTestJobs(second).runDue();

    await expect(titleJobs(conversation.id)).resolves.toEqual([
      { status: "succeeded", attempts: 1, dedupe_key: conversation.id }
    ]);
    // A browser bundle from before the upgrade still calls the removed route. It gets a 404
    // and reads the title from the list like every other client.
    const removed = await second.call("conversations.rename", {
      method: "POST",
      params: { conversationId: conversation.id }
    });
    expect(removed.statusCode).toBe(404);
    const listed = await second.call(
      "conversations.list",
      await personalConversationListInput(second)
    );
    expect(listed.json<{ items: unknown[] }>().items).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize The Release Notes"
      })
    );
  });

  it("enqueues the title job for the first user message only", async () => {
    const app = await createApp();
    const created = await app.call("conversations.create", { payload: { title: "First" } });
    const conversation = created.json<{ id: string }>();
    const first = await injectStartConversationRun(app, conversation.id, "First question", {
      idempotencyKey: "first-message"
    });
    await drainRunEvents(app, conversation.id, first.run.id);
    await getTestJobs(app).runDue();
    const second = await injectStartConversationRun(app, conversation.id, "Second question", {
      idempotencyKey: "second-message"
    });
    await drainRunEvents(app, conversation.id, second.run.id);

    await expect(titleJobs(conversation.id)).resolves.toEqual([
      { status: "succeeded", attempts: 1, dedupe_key: conversation.id }
    ]);
  });

  it("removes audit events older than the audit retention and records the count", async () => {
    const app = await createApp();
    const auditDays = createTestConfig().retention.auditDays;
    const otherInstance = asClientInstanceId("another-instance");
    const append = (instance: typeof clientInstanceId, correlationId: string) =>
      app.stores.audit.appendAuditEvent({
        clientInstanceId: instance,
        type: "auth.login_succeeded",
        status: "success",
        correlationId
      });
    await append(clientInstanceId, "expired-1");
    await append(clientInstanceId, "expired-2");
    await append(clientInstanceId, "inside-retention");
    await append(clientInstanceId, "recent");
    await append(otherInstance, "other-instance-expired");
    await age("expired-1", auditDays + 1);
    await age("expired-2", auditDays + 400);
    await age("inside-retention", auditDays - 1);
    await age("other-instance-expired", auditDays + 400);

    const jobs = getTestJobs(app);
    await jobs.runDue();
    // The next tick is a day away: a second pass prunes nothing and records nothing.
    await jobs.runDue();

    const kept = await app.stores.audit.listAuditEvents({ clientInstanceId, limit: 100 });
    const seeded = kept.filter((event) => event.type === "auth.login_succeeded");
    expect(seeded.map((event) => event.correlationId).sort()).toEqual([
      "inside-retention",
      "recent"
    ]);
    const pruned = kept.filter((event) => event.type === "audit.pruned");
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({
      status: "success",
      metadata: { deletedCount: 2, auditDays, createdBefore: expect.any(String) }
    });
    expect(pruned[0]).not.toHaveProperty("actor");
    const cutoff = Date.parse(String(pruned[0]?.metadata?.createdBefore));
    expect(Math.abs(Date.now() - auditDays * DAY_MS - cutoff)).toBeLessThan(60_000);
    // Another instance's rows are not this instance's to prune.
    await expect(
      app.stores.audit.listAuditEvents({ clientInstanceId: otherInstance, limit: 100 })
    ).resolves.toHaveLength(1);
  });
});

function createApp(): Promise<TestInstance> {
  return createTestInstance({ config: createTestConfig(), env: {}, tools: [] });
}

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

function titleJobs(conversationId: string) {
  return withSql(async (sql) => {
    const rows = await sql<{ status: string; attempts: number; dedupe_key: string }[]>`
      select status, attempts, dedupe_key from platform_jobs
      where kind = 'conversation.generate_title' and subject = ${conversationId}`;
    return rows.map((row) => ({ ...row }));
  });
}

/** Moves a seeded audit event into the past: the store stamps every event with the present. */
function age(correlationId: string, days: number): Promise<void> {
  return withSql(async (sql) => {
    await sql`
      update audit_events set created_at = now() - make_interval(days => ${days})
      where correlation_id = ${correlationId}`;
  });
}
