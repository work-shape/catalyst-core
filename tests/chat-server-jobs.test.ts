import { describe, expect, it } from "vitest";
import { createChatServerJobs, generateConversationTitleJob } from "@work-shape/catalyst-server";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  ATTACHED_FILE_TITLES,
  asClientInstanceId,
  asConversationId,
  asUserId,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import {
  createFailingTestLogger,
  createTestConfig,
  personalConversationListInput
} from "./support/fixtures";
import { silentTestLogger } from "./support/model-gateway";
import { createRetentionOptions } from "./support/retention-harness";
import { withTestSql as withSql } from "./support/test-sql";
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

  it("ends the run recovery tick the previous release left behind and schedules no next one", async () => {
    const recoveries = () =>
      withSql(async (sql) => {
        const rows = await sql<{ status: string }[]>`
          select status from platform_jobs where kind = 'agent_run.recover' order by created_at, id`;
        return rows.map((row) => ({ ...row }));
      });
    const app = await createApp();
    // The tick as the previous release's schedule enqueued it.
    await withSql(async (sql) => {
      await sql`
        insert into platform_jobs
          (id, client_instance_id, kind, payload, status, run_after, max_attempts, dedupe_key,
           correlation_id, created_at)
        values
          ('job_leftover_recovery', ${clientInstanceId}, 'agent_run.recover', '{}', 'queued',
           now(), 1, 'schedule:agent_run.recover', 'corr_leftover_recovery', now())`;
    });

    await getTestJobs(app).runDue();
    await getTestJobs(app).runDue();

    await expect(recoveries()).resolves.toEqual([{ status: "succeeded" }]);
  });

  it("gives a preview row without a job its job at the first pass, and no second one", async () => {
    const app = await createApp();
    const created = await app.call("conversations.create", { payload: { title: "Adoption" } });
    const conversation = { id: asConversationId(created.json<{ id: string }>().id) };
    const source = await app.stores.files.createManagedArtifact({
      clientInstanceId,
      conversationId: conversation.id,
      kind: "document.docx",
      objectKey: `adoption/${conversation.id}/report.docx`,
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 4,
      checksum: "sha256:adoption"
    });
    const row = await app.stores.files.enqueueArtifactPreviewJob({
      clientInstanceId,
      conversationId: conversation.id,
      sourceArtifactId: source.id,
      sourceChecksum: source.checksum,
      sourceMimeType: source.mimeType
    });
    const previewJobs = () =>
      withSql(async (sql) => {
        const rows = await sql<{ status: string; dedupe_key: string }[]>`
          select status, dedupe_key from platform_jobs
          where kind = 'artifact_preview.render' and subject = ${row.id}`;
        return rows.map((found) => ({ ...found }));
      });
    const queued = [{ status: "queued", dedupe_key: `artifact_preview.render:${row.id}` }];
    // The row and its job commit together.
    await expect(previewJobs()).resolves.toEqual(queued);
    // As the previous release's API leaves it: the row, and no job.
    await withSql((sql) => sql`delete from platform_jobs where kind = 'artifact_preview.render'`);

    await getTestJobs(app).runDue();
    await expect(previewJobs()).resolves.toEqual(queued);

    await withSql(
      (sql) => sql`
        update platform_jobs set run_after = now()
        where kind = 'platform_jobs.adopt_legacy' and status = 'queued'`
    );
    await getTestJobs(app).runDue();
    await expect(previewJobs()).resolves.toEqual(queued);
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

    // The worker's clock is two years ahead. The cutoff is the database's, so it changes nothing.
    const jobs = getTestJobs(app, { now: () => new Date(Date.now() + 730 * DAY_MS) });
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

describe("the title job and a rename by the user", () => {
  const titleInstance = asClientInstanceId("title-rename-test");

  async function titledConversation(
    renameDuringGeneration: string | undefined,
    titleBinding?: { id: string; providerId: string; model: string },
    /** Set to fail the model call of the title with this error. */
    generationFailure?: Error,
    /** The language the account chose. Left out, the account has none. */
    locale?: LocaleCode,
    /** The title the conversation starts with and the files its first message attached. */
    start: { title: string; files: string[] } = {
      title: "please summarize the release notes",
      files: []
    }
  ) {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId: titleInstance,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title: start.title,
      retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
    await store.conversations.appendMessage({
      clientInstanceId: titleInstance,
      conversationId: conversation.id,
      role: "user",
      text: "please summarize the release notes",
      ...(start.files.length === 0 ? {} : { metadata: attachedFiles(start.files) })
    });
    if (locale)
      await store.users.updateUser({
        clientInstanceId: titleInstance,
        userId: asUserId("user-1"),
        locale
      });
    const prompts: string[] = [];
    const options = createRetentionOptions({
      clientInstanceId: titleInstance,
      store,
      ...(titleBinding
        ? { modelBindings: [titleBinding], conversationTitleBindingId: titleBinding.id }
        : {}),
      modelProvider: {
        // The job has read the conversation and has not written the title yet.
        async complete(request) {
          prompts.push(request.messages.map((message) => String(message.content)).join("\n"));
          if (generationFailure) throw generationFailure;
          if (renameDuringGeneration)
            await store.conversations.updateConversationTitle({
              clientInstanceId: titleInstance,
              conversationId: conversation.id,
              title: renameDuringGeneration,
              updatedAt: new Date().toISOString()
            });
          return {
            text: "Release Notes Summary",
            toolCalls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              source: "not_reported",
              webSearchCallCount: 0
            }
          };
        }
      }
    });
    const worker = createJobWorker({
      stores: store,
      clientInstanceId: titleInstance,
      // A model call that is made to fail fails its job, and the worker logs that.
      logger: generationFailure
        ? silentTestLogger
        : createFailingTestLogger("The title job failed"),
      ...createChatServerJobs(options)
    });
    await store.jobs.enqueue(
      generateConversationTitleJob,
      { conversationId: conversation.id, userId: "user-1" },
      { clientInstanceId: titleInstance, dedupeKey: conversation.id }
    );
    await worker.runDue();
    await worker.stop();
    const stored = await store.conversations.getConversation(titleInstance, conversation.id);
    const audit = await store.audit.listAuditEvents({ clientInstanceId: titleInstance, limit: 20 });
    return {
      store,
      conversation,
      title: stored?.title,
      prompts,
      generatedEvents: audit.filter((event) => event.type === "conversation.title_generated"),
      failedEvents: audit.filter((event) => event.type === "conversation.title_generation_failed")
    };
  }

  it("writes the generated title while the conversation still carries the temporary one", async () => {
    const result = await titledConversation(undefined);
    expect(result.title).toBe("Release Notes Summary");
    expect(result.generatedEvents).toHaveLength(1);
  });

  it("names the model of a title in the audit by its binding, and by its id without one", async () => {
    // A provider's model id can hold a cloud account id: the audit shows the binding instead.
    const model = "arn:aws:bedrock:eu-central-1:000000000000:application-inference-profile/p";
    const bound = await titledConversation(undefined, { id: "titles", providerId: "local", model });
    expect(bound.generatedEvents.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ providerId: "local", modelBindingId: "titles" })
    ]);
    expect(JSON.stringify(bound.generatedEvents)).not.toContain("arn:aws");

    const unbound = await titledConversation(undefined);
    expect(unbound.generatedEvents.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ providerId: "local", model: "local" })
    );
  });

  it("names the model of a title that failed in the audit by its binding, and by its id without one", async () => {
    const model = "arn:aws:bedrock:eu-central-1:000000000000:application-inference-profile/p";
    const bound = await titledConversation(
      undefined,
      { id: "titles", providerId: "local", model },
      new Error("The model failed")
    );
    expect(bound.title).toBe("please summarize the release notes");
    expect(bound.generatedEvents).toHaveLength(0);
    expect(bound.failedEvents.length).toBeGreaterThan(0);
    for (const event of bound.failedEvents) {
      expect(event).toMatchObject({
        status: "failed",
        metadata: { providerId: "local", modelBindingId: "titles" }
      });
      expect(event.metadata).not.toHaveProperty("model");
    }
    expect(JSON.stringify(bound.failedEvents)).not.toMatch(/arn:aws|000000000000/u);

    const unbound = await titledConversation(undefined, undefined, new Error("The model failed"));
    expect(unbound.failedEvents.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ providerId: "local", model: "local" })
    );
  });

  it("asks for the title in the language of the account the conversation belongs to", async () => {
    // ACCEPT-1c C8: a German account's list showed English titles.
    // The account keeps its language, so the one without a choice goes first.
    expect((await titledConversation(undefined)).prompts).toEqual([
      expect.stringContaining("Write the headline in English.")
    ]);
    expect((await titledConversation(undefined, undefined, undefined, "de")).prompts).toEqual([
      expect.stringContaining("Write the headline in German.")
    ]);
  });

  it("replaces the chat's German title for attached files, and keeps one a person wrote", async () => {
    // ACCEPT-1c C8: a German conversation started with files was called "2 attached files".
    const titleOf = async (title: string, files: string[]) =>
      (await titledConversation(undefined, undefined, undefined, "de", { title, files })).title;
    // The titles come from the chat's dictionary, so a server that drifts from it fails here.
    for (const locale of ["en", "de"] as const) {
      const { t } = createTranslationContext(locale);
      expect(await titleOf(t("conversationAttachedFile"), ["a.pdf"])).toBe("Release Notes Summary");
      const many = t("conversationAttachedFiles", { count: "3" });
      expect(await titleOf(many, ["a.pdf", "b.pdf", "c.pdf"])).toBe("Release Notes Summary");
    }
    // A server that keeps titles of its own fails once the shared titles change.
    const shared = { ...ATTACHED_FILE_TITLES.de };
    try {
      ATTACHED_FILE_TITLES.de = { one: "Fixture eine Datei", many: "{count} Fixture Dateien" };
      expect(await titleOf("Fixture eine Datei", ["a.pdf"])).toBe("Release Notes Summary");
      expect(await titleOf("2 Fixture Dateien", ["a.pdf", "b.pdf"])).toBe("Release Notes Summary");
    } finally {
      ATTACHED_FILE_TITLES.de = shared;
    }
    expect(await titleOf("Meine Belege", ["a.pdf", "b.pdf"])).toBe("Meine Belege");
  });

  it("keeps a title the user wrote between the job's read and its write", async () => {
    const result = await titledConversation("Mine");
    expect(result.title).toBe("Mine");
    expect(result.generatedEvents).toHaveLength(0);
  });

  it("replaces a title in one statement, and only the expected one", async () => {
    const { store, conversation } = await titledConversation("Mine");
    const replace = (expectedTitle: string) =>
      store.conversations.replaceConversationTitle({
        clientInstanceId: titleInstance,
        conversationId: conversation.id,
        expectedTitle,
        title: "Generated",
        updatedAt: new Date().toISOString()
      });

    await expect(replace("please summarize the release notes")).resolves.toBe(false);
    await expect(
      store.conversations.getConversation(titleInstance, conversation.id)
    ).resolves.toMatchObject({ title: "Mine" });
    await expect(replace("Mine")).resolves.toBe(true);
    await expect(
      store.conversations.getConversation(titleInstance, conversation.id)
    ).resolves.toMatchObject({ title: "Generated" });
  });
});

function createApp(): Promise<TestInstance> {
  return createTestInstance({ config: createTestConfig(), env: {}, tools: [] });
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

/** The metadata of a first message that attached `files`, as the chat stores it. */
function attachedFiles(files: string[]) {
  return {
    agentRuntime: {
      version: 1,
      kind: "user_message",
      attachmentManifest: {
        version: 1,
        attachments: files.map((filename, index) => ({
          fileId: `file_${index}`,
          attachmentId: `att_${index}`,
          filename,
          mimeType: "application/pdf",
          byteSize: 1,
          status: "ready",
          readable: true
        }))
      }
    }
  };
}
