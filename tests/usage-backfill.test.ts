import { describe, expect, it, vi } from "vitest";
import { createChatServerJobs } from "@vivd-catalyst/chat-server";
import { createJobWorker } from "@vivd-catalyst/client-assembly";
import type { ClientInstanceId, ModelUsageBackfillPosition } from "@vivd-catalyst/core";
import { createFailingTestLogger } from "./support/fixtures";
import { usePostgresSuite } from "./support/postgres-suite";
import { createRetentionOptions } from "./support/retention-harness";
import { createTestInstance } from "./support/test-instance";
import { addTestStoreHelpers } from "./support/test-store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows of the fixture a batch is read on, and the size of a batch in it. */
const LARGE_FIXTURE_ROWS = 200_000;
const BATCH_IN_LARGE_FIXTURE = 1_000;

describe("the usage attribution backfill", () => {
  const db = usePostgresSuite("usagebackfill");

  /** The due jobs as a freshly started process runs them: the backfill among them. */
  async function runBackfill(clientInstanceId: ClientInstanceId, now?: () => Date) {
    const worker = createJobWorker({
      stores: db.store,
      clientInstanceId,
      logger: createFailingTestLogger("The backfill failed"),
      ...createChatServerJobs(
        createRetentionOptions({
          clientInstanceId,
          store: db.store,
          models: {
            "azure-eu": { provider: "openai-compatible", model: "gpt-main", region: "eu" },
            local: { provider: "deterministic", model: "local" }
          },
          modelBindings: [{ id: "main", providerId: "azure-eu" }]
        }),
        now ? { now } : {}
      )
    });
    await worker.runDue();
    await worker.stop();
  }

  /** A usage event as the previous release wrote it: no purpose, region, binding, user or workspace. */
  async function oldEvent(
    clientInstanceId: ClientInstanceId,
    id: string,
    row: {
      agentName: string;
      agentRunId: string | null;
      conversationId: string | null;
      providerId?: string;
      model?: string;
      totalTokens: number;
      createdAt?: string;
    }
  ) {
    await db.sql`
      insert into model_usage_events
        (id, client_instance_id, conversation_id, agent_run_id, agent_name, provider_id, model,
         input_tokens, output_tokens, total_tokens, source, correlation_id, created_at)
      values (${id}, ${clientInstanceId}, ${row.conversationId}, ${row.agentRunId},
        ${row.agentName}, ${row.providerId ?? "azure-eu"}, ${row.model ?? "gpt-main"},
        ${row.totalTokens}, 0, ${row.totalTokens}, 'provider_reported', 'corr_old',
        ${row.createdAt ?? new Date().toISOString()}::timestamptz)`;
  }

  async function rows(clientInstanceId: ClientInstanceId) {
    const found = await db.sql<
      Array<{
        id: string;
        purpose: string | null;
        region: string | null;
        binding_id: string | null;
        user_id: string | null;
        collaboration_workspace_id: string | null;
        version: string;
      }>
    >`
      select id, purpose, region, binding_id, user_id, collaboration_workspace_id,
        xmin::text as version
      from model_usage_events where client_instance_id = ${clientInstanceId} order by id`;
    return found.map((row) => ({ ...row }));
  }

  // Fails without the change: the rows of the previous release kept no purpose, region,
  // binding, user or workspace.
  it("fills purpose, user and workspace, leaves an unmatched region empty and changes nothing on a second run", async () => {
    const clientInstanceId = db.clientInstance("fill");
    const store = addTestStoreHelpers(db.store);
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: `${clientInstanceId}_user`,
      createdByExternalUserId: "external-user",
      title: "old usage",
      retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
    const run = await store.createAgentRunForTesting(conversation);
    const inRun = { agentRunId: run.id, conversationId: conversation.id };
    await oldEvent(clientInstanceId, "usage_1_agent", {
      ...inRun,
      agentName: "test_agent",
      totalTokens: 1_000
    });
    await oldEvent(clientInstanceId, "usage_2_title", {
      ...inRun,
      agentName: "conversation_title",
      totalTokens: 200
    });
    await oldEvent(clientInstanceId, "usage_3_check", {
      ...inRun,
      agentName: "approval_check",
      totalTokens: 30
    });
    await oldEvent(clientInstanceId, "usage_4_retired", {
      ...inRun,
      agentName: "test_agent",
      providerId: "retired-provider",
      model: "retired-model",
      totalTokens: 4
    });
    await oldEvent(clientInstanceId, "usage_5_no_region", {
      agentRunId: null,
      conversationId: null,
      agentName: "document_extraction",
      providerId: "local",
      model: "local",
      totalTokens: 5
    });
    // The sums of events the previous release wrote come from the comparison with the events.
    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "all" });
    const totalsBefore = await db.store.usage.summarizeModelUsageHistory({ clientInstanceId });

    await runBackfill(clientInstanceId);

    const user = conversation.createdByUserId;
    const workspace = conversation.collaborationWorkspaceId;
    const filled = await rows(clientInstanceId);
    expect(filled.map(({ version: _version, ...row }) => row)).toEqual([
      {
        id: "usage_1_agent",
        purpose: null,
        region: "eu",
        binding_id: "main",
        user_id: user,
        collaboration_workspace_id: workspace
      },
      {
        id: "usage_2_title",
        purpose: "conversation_title",
        region: "eu",
        binding_id: "main",
        user_id: user,
        collaboration_workspace_id: workspace
      },
      {
        id: "usage_3_check",
        purpose: "guardrail_judge",
        region: "eu",
        binding_id: "main",
        user_id: user,
        collaboration_workspace_id: workspace
      },
      {
        id: "usage_4_retired",
        purpose: null,
        region: null,
        binding_id: null,
        user_id: user,
        collaboration_workspace_id: workspace
      },
      {
        id: "usage_5_no_region",
        purpose: "document_extraction",
        region: null,
        binding_id: null,
        user_id: null,
        collaboration_workspace_id: null
      }
    ]);
    const totalsAfter = await db.store.usage.summarizeModelUsageHistory({ clientInstanceId });
    expect(totalsAfter).toEqual(totalsBefore);
    expect(totalsAfter.allTime).toMatchObject({ modelCallCount: 5, totalTokens: 1_239 });

    await runBackfill(clientInstanceId);

    // The row versions are the ones the first run left: the second run wrote no row.
    await expect(rows(clientInstanceId)).resolves.toEqual(filled);
  });

  // Fails without the change: there was no backfill to resume.
  it("goes through the events a batch at a time in the order they were written and resumes after the last one it read", async () => {
    const clientInstanceId = db.clientInstance("batches");
    for (const n of [1, 2, 3, 4, 5]) {
      await oldEvent(clientInstanceId, `usage_batch_${n}`, {
        agentRunId: null,
        conversationId: null,
        agentName: "document_extraction",
        totalTokens: n,
        // The first three were written in the same microsecond: a batch ends between them.
        createdAt: `2026-01-01T00:00:00.12345${n <= 3 ? 0 : n}Z`
      });
    }
    const targets = [{ providerId: "azure-eu", model: "gpt-main", region: "eu" as const }];
    const pass = async () => {
      const batches: Array<{ lastId?: string; changedCount: number }> = [];
      let after: ModelUsageBackfillPosition | undefined;
      do {
        const batch = await db.store.usage.backfillModelUsageAttribution({
          clientInstanceId,
          targets,
          ...(after === undefined ? {} : { after }),
          limit: 2
        });
        batches.push({
          ...(batch.next ? { lastId: batch.next.id } : {}),
          changedCount: batch.changedCount
        });
        after = batch.next;
      } while (after !== undefined);
      return batches;
    };

    await expect(pass()).resolves.toEqual([
      { lastId: "usage_batch_2", changedCount: 2 },
      { lastId: "usage_batch_4", changedCount: 2 },
      { lastId: "usage_batch_5", changedCount: 1 },
      { changedCount: 0 }
    ]);
    // A process that starts over after any batch reads what is filled and leaves it.
    await expect(pass()).resolves.toEqual([
      { lastId: "usage_batch_2", changedCount: 0 },
      { lastId: "usage_batch_4", changedCount: 0 },
      { lastId: "usage_batch_5", changedCount: 0 },
      { changedCount: 0 }
    ]);
    const filled = await rows(clientInstanceId);
    expect(filled.map((row) => [row.purpose, row.region])).toEqual(
      Array.from({ length: 5 }, () => ["document_extraction", "eu"])
    );
  });

  // Fails without the change: where a pass stood was in the memory of its process, and a
  // process that was killed started over an hour later.
  it("goes on after the last batch a killed process recorded", async () => {
    const clientInstanceId = db.clientInstance("resume");
    for (const n of [1, 2, 3, 4]) {
      await oldEvent(clientInstanceId, `usage_resume_${n}`, {
        agentRunId: null,
        conversationId: null,
        agentName: "document_extraction",
        totalTokens: n,
        createdAt: `2026-01-01T00:00:0${n}.000000Z`
      });
    }
    // What the batch of a killed process left: the pass stands after the second event.
    await db.store.usage.writeModelUsageMaintenance({
      clientInstanceId,
      task: "attribution_backfill",
      state: {
        after: { createdAt: "2026-01-01T00:00:02.000000Z", id: "usage_resume_2" },
        changedInPass: 0
      }
    });

    await runBackfill(clientInstanceId);

    const resumed = await rows(clientInstanceId);
    expect(resumed.map((row) => row.purpose)).toEqual([
      null,
      null,
      "document_extraction",
      "document_extraction"
    ]);
    // The pass changed something, so the next tick reads the events from the start.
    await runBackfill(clientInstanceId);
    const complete = await rows(clientInstanceId);
    expect(complete.map((row) => row.purpose)).toEqual(
      Array.from({ length: 4 }, () => "document_extraction")
    );
  });

  // Fails without the change: after a pass without a change the backfill never read again,
  // and what a process of the previous release wrote after it stayed without attribution.
  it("records a pass without a change and reads the events again a day later", async () => {
    const clientInstanceId = db.clientInstance("verify");
    const start = new Date("2026-03-01T08:00:00.000Z");
    await runBackfill(clientInstanceId, () => start);
    await oldEvent(clientInstanceId, "usage_late", {
      agentRunId: null,
      conversationId: null,
      agentName: "document_extraction",
      totalTokens: 3
    });

    // An hour later, in a new process: the recorded pass stands and nothing is read.
    await runBackfill(clientInstanceId, () => new Date(start.getTime() + DAY_MS / 24));
    await expect(rows(clientInstanceId)).resolves.toMatchObject([{ purpose: null }]);

    await runBackfill(clientInstanceId, () => new Date(start.getTime() + DAY_MS + 1));
    await expect(rows(clientInstanceId)).resolves.toMatchObject([
      { purpose: "document_extraction" }
    ]);
    // The event moved to the sum of its purpose.
    const recent = await db.store.usage.summarizeRecentModelUsage({
      clientInstanceId,
      from: new Date(Date.now() - DAY_MS).toISOString()
    });
    expect(recent.byAttribution).toMatchObject([
      { purpose: "document_extraction", totalTokens: 3 }
    ]);
    expect(recent.byAttribution).toHaveLength(1);
  });

  // Fails without the change: there was no backfill. It also fails when the batch is taken in
  // an order the index does not give: the statement then reads the whole table to sort it.
  it("takes a batch through the index on instance and creation time, without reading the table", async () => {
    const clientInstanceId = db.clientInstance("large");
    await db.sql`
      insert into model_usage_events
        (id, client_instance_id, agent_name, provider_id, model,
         input_tokens, output_tokens, total_tokens, source, correlation_id, created_at)
      select 'usage_' || md5(n::text), ${clientInstanceId}, 'conversation_title', 'azure-eu',
        'gpt-main', 100, 20, 120, 'provider_reported', 'corr_large',
        now() - make_interval(secs => n)
      from generate_series(1, ${LARGE_FIXTURE_ROWS}::int) as n`;
    await db.sql`analyze model_usage_events`;
    const targets = [{ providerId: "azure-eu", model: "gpt-main", region: "eu" as const }];
    const counters = async () => {
      const [row] = await db.sql<Array<{ scans: number; updated: number }>>`
        select seq_scan::int as scans, n_tup_upd::int as updated
        from pg_stat_user_tables where relname = 'model_usage_events'`;
      if (!row) throw new Error("The database reported no counters");
      return row;
    };
    // The counters of a backend reach the others when it ends, so each batch runs on a pool
    // of its own, and the counters are read once the updates of the batch show in them.
    const batchOnOwnPool = async (after?: ModelUsageBackfillPosition) => {
      const before = await counters();
      const process = await createTestInstance({
        postgres: { applicationName: `${db.first}_backfill` }
      });
      const batch = await process.stores.usage.backfillModelUsageAttribution({
        clientInstanceId,
        targets,
        ...(after ? { after } : {}),
        limit: BATCH_IN_LARGE_FIXTURE
      });
      await process.close();
      const reported = await vi.waitFor(
        async () => {
          const now = await counters();
          expect(now.updated - before.updated).toBe(BATCH_IN_LARGE_FIXTURE);
          return now;
        },
        { timeout: 30_000, interval: 50 }
      );
      return { batch, sequentialScans: reported.scans - before.scans };
    };

    const first = await batchOnOwnPool();
    const second = await batchOnOwnPool(first.batch.next);

    expect(first.batch.changedCount).toBe(BATCH_IN_LARGE_FIXTURE);
    expect(second.batch.changedCount).toBe(BATCH_IN_LARGE_FIXTURE);
    expect(first.sequentialScans).toBe(0);
    expect(second.sequentialScans).toBe(0);
  });

  // Fails without the change: there was no backfill, and nothing kept it from naming a user
  // whose account is being deleted.
  it("names no user or workspace that is being deleted", async () => {
    const clientInstanceId = db.clientInstance("closing");
    const store = addTestStoreHelpers(db.store);
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: `${clientInstanceId}_user`,
      createdByExternalUserId: "external-user",
      title: "closing",
      retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
    await oldEvent(clientInstanceId, "usage_closing", {
      agentRunId: null,
      conversationId: conversation.id,
      agentName: "conversation_title",
      totalTokens: 7
    });
    await db.sql`update product_users set deletion_requested_at = now() where id = ${conversation.createdByUserId}`;
    await db.sql`update collaboration_workspaces set deletion_requested_at = now() where id = ${conversation.collaborationWorkspaceId}`;

    await runBackfill(clientInstanceId);

    await expect(rows(clientInstanceId)).resolves.toMatchObject([
      { purpose: "conversation_title", user_id: null, collaboration_workspace_id: null }
    ]);
  });
});
