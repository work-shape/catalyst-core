import { describe, expect, it, vi } from "vitest";
import {
  asUserId,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelProviderConfig
} from "@vivd-catalyst/core";
import {
  createModelGateway,
  type ModelAdapter,
  type ModelBindingRef,
  type ModelGateway
} from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { arrangeDeletion } from "./support/deletion-fixture";
import { ALL_MODEL_CAPABILITIES, silentTestLogger } from "./support/model-gateway";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";
import { addTestStoreHelpers } from "./support/test-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_INDEX = "model_usage_events_client_created_idx";
/** Rows of the fixture a plan is read on, spread over two years. */
const LARGE_FIXTURE_ROWS = 200_000;
const LARGE_FIXTURE_DAYS = 730;

const provider: ModelProviderConfig = {
  id: "azure-eu",
  type: "fake",
  model: "gpt-main",
  region: "eu"
};
const adapter: ModelAdapter = {
  capabilities: () => ALL_MODEL_CAPABILITIES,
  complete: async () => ({
    text: "ok",
    toolCalls: [],
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  }),
  stream() {
    throw new Error("These calls do not stream");
  }
};

describe("usage attribution", () => {
  const db = usePostgresSuite("usageattribution");

  function gatewayOn(clientInstanceId: ClientInstanceId) {
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });
    const gateway = createModelGateway({
      providers: [provider],
      bindings: [
        { id: "main", providerId: "azure-eu" },
        { id: "small", providerId: "azure-eu", model: "gpt-small" }
      ],
      adapters: new Map([["azure-eu", adapter]]),
      governance,
      logger: silentTestLogger
    });
    return { governance, gateway, clientInstanceId };
  }

  function complete(
    gateway: ModelGateway,
    clientInstanceId: ClientInstanceId,
    binding: ModelBindingRef,
    attribution: ModelAttribution
  ) {
    return gateway.complete({
      binding,
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      attribution,
      clientInstanceId,
      correlationId: "corr_usage_attribution"
    });
  }

  // Fails without the change: an event held no region, no binding and no user, and the
  // summary had no groups.
  it("records provider, region, binding and user for an agent call, a title and a judge call, and the summary groups them", async () => {
    const clientInstanceId = db.clientInstance("calls");
    const store = addTestStoreHelpers(db.store);
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: `${clientInstanceId}_user`,
      createdByExternalUserId: "external-user",
      title: "attribution",
      retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
    });
    const run = await store.createAgentRunForTesting(conversation);
    const userId = conversation.createdByUserId;
    const { gateway, governance } = gatewayOn(clientInstanceId);

    await complete(
      gateway,
      clientInstanceId,
      { bindingId: "main" },
      {
        kind: "agent_run",
        conversationId: conversation.id,
        runId: run.id,
        agentName: "test_agent",
        userId
      }
    );
    for (const purpose of ["conversation_title", "guardrail_judge"] as const) {
      await complete(
        gateway,
        clientInstanceId,
        { bindingId: "small" },
        { kind: "system", purpose, conversationId: conversation.id, userId }
      );
    }

    const attributed = {
      providerId: "azure-eu",
      region: "eu",
      userId,
      collaborationWorkspaceId: conversation.collaborationWorkspaceId,
      conversationId: conversation.id,
      totalTokens: 120
    };
    const events = await db.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...attributed,
          model: "gpt-main",
          bindingId: "main",
          agentRunId: run.id,
          agentName: "test_agent"
        }),
        expect.objectContaining({
          ...attributed,
          model: "gpt-small",
          bindingId: "small",
          purpose: "conversation_title"
        }),
        expect.objectContaining({
          ...attributed,
          model: "gpt-small",
          bindingId: "small",
          purpose: "guardrail_judge"
        })
      ])
    );
    expect(events.find((event) => event.agentRunId)).not.toHaveProperty("purpose");

    const summary = await governance.createSafeSummary({ clientInstanceId });
    const group = { providerId: "azure-eu", region: "eu", modelCallCount: 1, totalTokens: 120 };
    expect(summary.attributedUsage).toHaveLength(3);
    expect(summary.attributedUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...group, model: "gpt-main", agentName: "test_agent" }),
        expect.objectContaining({ ...group, model: "gpt-small", purpose: "conversation_title" }),
        expect.objectContaining({ ...group, model: "gpt-small", purpose: "guardrail_judge" })
      ])
    );
    expect(summary.today).toMatchObject({ modelCallCount: 3, totalTokens: 360 });
    expect(summary.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: "conversation_title", region: "eu" })
      ])
    );
  });

  // Fails without the change: the summary read every event of the instance into the process.
  it("sums the recent days in the database through the index on instance and creation time", async () => {
    const clientInstanceId = db.clientInstance("large");
    await db.sql`
      insert into model_usage_events
        (id, client_instance_id, agent_run_id, agent_name, provider_id, model, region,
         input_tokens, output_tokens, total_tokens, source, correlation_id, created_at)
      select 'usage_large_' || n, ${clientInstanceId}, 'run_' || (n % 500), 'agent_' || (n % 3),
        'azure-eu', 'gpt-main', 'eu', 100, 20, 120, 'provider_reported', 'corr_large',
        now() - make_interval(days => (n % ${LARGE_FIXTURE_DAYS})::int)
      from generate_series(1, ${LARGE_FIXTURE_ROWS}::int) as n`;
    await db.sql`analyze model_usage_events`;
    const from = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const [expected] = await db.sql<Array<{ calls: number }>>`
      select count(*)::int as calls from model_usage_events
      where client_instance_id = ${clientInstanceId} and created_at >= ${from}`;
    const scans = async () => {
      const [row] = await db.sql<Array<{ sequential: number; indexed: number }>>`
        select
          (select seq_scan::int from pg_stat_user_tables where relname = 'model_usage_events')
            as sequential,
          (select idx_scan::int from pg_stat_user_indexes where indexrelname = ${RECENT_INDEX})
            as indexed`;
      if (!row) throw new Error("The database reported no scan counters");
      return row;
    };
    // The counters of a backend reach the others when it ends, so the statement runs on a
    // pool of its own. The reads of this test's own connection above are counted before.
    await db.sql`select pg_stat_force_next_flush()`;
    await db.sql`select 1`;
    const before = await scans();
    const reader = await createTestInstance({
      postgres: { applicationName: `${db.first}_reader` }
    });

    const recent = await reader.stores.usage.summarizeRecentModelUsage({ clientInstanceId, from });
    await reader.close();

    const after = await vi.waitFor(
      async () => {
        const now = await scans();
        expect(now.indexed + now.sequential).toBeGreaterThan(before.indexed + before.sequential);
        return now;
      },
      { timeout: 30_000, interval: 50 }
    );
    expect(after.sequential).toBe(before.sequential);
    expect(after.indexed).toBeGreaterThan(before.indexed);
    expect(recent.days.reduce((sum, day) => sum + day.modelCallCount, 0)).toBe(expected?.calls);
    expect(recent.byAttribution.map((entry) => entry.agentName)).toEqual(
      expect.arrayContaining(["agent_0", "agent_1", "agent_2"])
    );
  });

  // Fails without the change: the event kept the id of a user who no longer exists.
  it("keeps the usage of a deleted account and names no user on it", async () => {
    const t = await arrangeDeletion(db, "account");
    const leaving = await t.createUser("leaving");
    const conversation = await t.createConversation(leaving, "own");
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });
    await governance.recordModelUsage({
      clientInstanceId: t.clientInstanceId,
      attribution: {
        kind: "system",
        purpose: "conversation_title",
        conversationId: conversation.id,
        userId: leaving.id
      },
      providerId: "azure-eu",
      model: "gpt-main",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: "provider_reported",
      correlationId: "corr_usage_account"
    });
    const personal = await t.personalWorkspaceOf(leaving);
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: leaving.id, collaboration_workspace_id: personal.id, total_tokens: 120 }
    ]);

    const deleted = await t.api.call("me.delete", {}, leaving.id);

    expect(deleted.statusCode).toBe(200);
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: null, collaboration_workspace_id: null, total_tokens: 120 }
    ]);
  });

  // Fails without the change: the event kept the id of a workspace that no longer exists.
  it("keeps the usage of a deleted workspace and names no workspace on it", async () => {
    const t = await arrangeDeletion(db, "workspace");
    const owner = await t.createUser("owner");
    const workspace = await t.createSharedWorkspace(owner, "Shared");
    const conversation = await t.createConversation(owner, "shared", { workspace });
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });
    await governance.recordModelUsage({
      clientInstanceId: t.clientInstanceId,
      attribution: {
        kind: "system",
        purpose: "conversation_title",
        conversationId: conversation.id,
        userId: owner.id
      },
      providerId: "azure-eu",
      model: "gpt-main",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: "provider_reported",
      correlationId: "corr_usage_workspace"
    });
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: owner.id, collaboration_workspace_id: workspace.id, total_tokens: 120 }
    ]);

    const deleted = await t.api.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspace.id },
        payload: { confirmName: workspace.name }
      },
      owner.id
    );

    expect(deleted.statusCode).toBe(200);
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: owner.id, collaboration_workspace_id: null, total_tokens: 120 }
    ]);
  });

  // Fails without the change: nothing tied the event to the user row, so the user could go
  // while the event still named it.
  it("lets no user or workspace row go while a usage event still names it", async () => {
    const t = await arrangeDeletion(db, "guarantee");
    const user = await t.createUser("named");
    const workspace = await t.createSharedWorkspace(user, "Named");
    await db.store.usage.appendModelUsageEvent({
      clientInstanceId: t.clientInstanceId,
      purpose: "document_extraction",
      providerId: "azure-eu",
      model: "gpt-main",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: "provider_reported",
      webSearchCallCount: 0,
      fastMode: false,
      customerBillableCost: {
        status: "unpriced",
        source: "rate_card",
        calculationVersion: 1,
        missingMeters: ["model_rate"]
      },
      userId: asUserId(user.id),
      collaborationWorkspaceId: workspace.id,
      correlationId: "corr_usage_guarantee"
    });

    // What a writer of the previous release, or a pass that missed the event, leaves to the
    // database: the rows go, and the event stops naming them in the same statement.
    await db.sql`delete from collaboration_workspace_memberships where collaboration_workspace_id = ${workspace.id}`;
    await db.sql`delete from collaboration_workspaces where id = ${workspace.id}`;
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: user.id, collaboration_workspace_id: null, total_tokens: 120 }
    ]);
    await db.sql`delete from collaboration_workspace_memberships where user_id = ${user.id}`;
    await db.sql`delete from collaboration_workspaces where client_instance_id = ${t.clientInstanceId}`;
    await db.sql`delete from product_users where id = ${user.id}`;
    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: null, collaboration_workspace_id: null, total_tokens: 120 }
    ]);
  });

  // Fails without the change: the event was written with whatever user id the caller gave.
  it("names no user on an event for a user who is unknown or being deleted", async () => {
    const t = await arrangeDeletion(db, "closing");
    const closing = await t.createUser("closing");
    await db.sql`update product_users set deletion_requested_at = now() where id = ${closing.id}`;
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });

    for (const userId of [closing.id, "usr_never_existed"]) {
      await governance.recordModelUsage({
        clientInstanceId: t.clientInstanceId,
        attribution: { kind: "system", purpose: "document_extraction", userId },
        providerId: "azure-eu",
        model: "gpt-main",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        source: "provider_reported",
        correlationId: "corr_usage_closing"
      });
    }

    await expect(usageRows(t.clientInstanceId)).resolves.toEqual([
      { user_id: null, collaboration_workspace_id: null, total_tokens: 120 },
      { user_id: null, collaboration_workspace_id: null, total_tokens: 120 }
    ]);
  });

  async function usageRows(clientInstanceId: ClientInstanceId) {
    const rows = await db.sql<
      Array<{
        user_id: string | null;
        collaboration_workspace_id: string | null;
        total_tokens: number;
      }>
    >`
      select user_id, collaboration_workspace_id, total_tokens from model_usage_events
      where client_instance_id = ${clientInstanceId} order by created_at, id`;
    return rows.map((row) => ({ ...row }));
  }
});
