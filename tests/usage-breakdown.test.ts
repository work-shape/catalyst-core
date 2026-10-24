import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  PERSONAL_WORKSPACES_KEY,
  USAGE_BREAKDOWN_DIMENSIONS,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelSystemPurpose,
  type ModelUsageTotals,
  type UsageRateCardConfig
} from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { required } from "./support/assertions";
import { usePostgresSuite } from "./support/postgres-suite";
import { ensureTestUser } from "./support/test-store";

// LU-3: the daily sums carry the workspace, the App and the Workflow, every Personal Workspace
// as one key, and the Breakdown of each dimension sums to the same total (limits spec, check 13).
const rateCard: UsageRateCardConfig = {
  id: "customer",
  version: "2026-10",
  currency: "EUR",
  models: [
    {
      providerId: "azure-eu",
      model: "gpt-main",
      uncachedInputPricePerMillionTokens: 2,
      cachedInputPricePerMillionTokens: 0.5,
      outputPricePerMillionTokens: 8
    }
  ]
};

const cost = (totals: Pick<ModelUsageTotals, "settledCost">) =>
  totals.settledCost.uncachedInputCostMicros +
  totals.settledCost.cachedInputCostMicros +
  totals.settledCost.outputCostMicros +
  totals.settledCost.webSearchCostMicros;

describe("usage breakdown", () => {
  const db = usePostgresSuite("usagebreakdown");

  const governance = () =>
    new ModelUsageGovernance({
      store: db.store.usage,
      costs: { customer: rateCard },
      budget: {},
      safeguards: {}
    });

  const record = (
    clientInstanceId: ClientInstanceId,
    attribution: ModelAttribution,
    tokens = 1_000
  ) =>
    governance().recordModelUsage({
      clientInstanceId,
      attribution,
      providerId: "azure-eu",
      model: "gpt-main",
      correlationId: `corr_${randomUUID()}`,
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: tokens,
      totalTokens: tokens * 2,
      source: "provider_reported"
    });

  const agentCall = (
    agentName: string,
    userId: string | undefined,
    workspaceId: string | undefined,
    extra: { operationRunId?: string } = {}
  ): ModelAttribution => ({
    kind: "agent_run",
    conversationId: asConversationId(`conv_${randomUUID()}`),
    runId: asAgentRunId(`run_${randomUUID()}`),
    agentName,
    ...(userId === undefined ? {} : { userId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...extra
  });

  const systemCall = (
    purpose: ModelSystemPurpose,
    userId?: string,
    workspaceId?: string
  ): ModelAttribution => ({
    kind: "system",
    purpose,
    ...(userId === undefined ? {} : { userId }),
    ...(workspaceId === undefined ? {} : { workspaceId })
  });

  /**
   * Two people, one shared workspace and their two Personal Workspaces, a Workflow Run and an
   * App action: one call of each origin.
   */
  async function arrange(label: string) {
    const clientInstanceId = db.clientInstance(label);
    const anna = `${clientInstanceId}_anna`;
    const ben = `${clientInstanceId}_ben`;
    for (const id of [anna, ben]) await ensureTestUser(clientInstanceId, id);
    const shared = await db.store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: `team-${randomUUID().slice(0, 6)}`,
      creatorUserId: asUserId(anna)
    });
    const annaPersonal = await db.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(anna)
    });
    const benPersonal = await db.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(ben)
    });
    const workflowRunId = `wfrun_${randomUUID()}`;
    const appOperationRunId = `oprun_${randomUUID()}`;
    await db.sql`
      insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode,
        trigger, status, definition, input, principal_id, principal_name, principal_label,
        started_by, deadline_at, correlation_id, created_at, depth, root_run_id)
      values (${workflowRunId}, ${clientInstanceId}, 'weekly-digest', 'rev', 'live', 'schedule',
        'done', '{}', '{}', 'sp', 'sp', 'sp', '{}', now(), 'c', now(), 0, ${workflowRunId})`;
    await db.sql`
      insert into operation_runs (id, client_instance_id, operation, effect, actor_kind, actor_id,
        actor, origin_kind, origin, input_hash, status, correlation_id, created_at, updated_at,
        collaboration_workspace_id)
      values (${appOperationRunId}, ${clientInstanceId}, 'apps.action.run', 'changing', 'user',
        ${anna}, '{"kind": "user", "id": "usr", "label": "User"}', 'app',
        ${db.sql.json({ kind: "app", appName: "quote-desk", appRevisionId: "rev", actionName: "draft", pageSessionId: "ps" })},
        'hash', 'done', 'corr', now(), now(), ${shared.id})`;

    await record(clientInstanceId, agentCall("writer", anna, shared.id));
    await record(clientInstanceId, agentCall("writer", ben, shared.id), 2_000);
    await record(clientInstanceId, agentCall("writer", anna, annaPersonal.id));
    await record(clientInstanceId, agentCall("reader", ben, benPersonal.id), 3_000);
    await record(clientInstanceId, systemCall("conversation_title", anna, shared.id));
    await record(clientInstanceId, {
      kind: "workflow_step",
      workflowRunId,
      conversationId: asConversationId(`conv_${randomUUID()}`),
      runId: asAgentRunId(`run_${randomUUID()}`),
      agentName: "digest_writer"
    });
    await record(
      clientInstanceId,
      agentCall("quoter", anna, shared.id, { operationRunId: appOperationRunId })
    );
    await record(clientInstanceId, systemCall("knowledge_embedding", anna, shared.id));
    return { clientInstanceId, anna, ben, shared: shared.id as string };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const breakdown = (
    clientInstanceId: ClientInstanceId,
    groupBy: Parameters<typeof db.store.usage.summarizeModelUsageBreakdown>[0]["groupBy"],
    filter?: Parameters<typeof db.store.usage.summarizeModelUsageBreakdown>[0]["filter"]
  ) =>
    db.store.usage.summarizeModelUsageBreakdown({
      clientInstanceId,
      from: today(),
      to: tomorrow(),
      groupBy,
      ...(filter === undefined ? {} : { filter })
    });

  // Fails without the change: the sums had no workspace, App or Workflow to group by.
  it("keys a shared workspace, every Personal Workspace as one, the App and the Workflow", async () => {
    const { clientInstanceId, shared } = await arrange("keys");

    const byWorkspace = await breakdown(clientInstanceId, "workspace");
    expect(byWorkspace.map((row) => [row.key, row.modelCallCount])).toEqual(
      [
        ["", 1],
        [PERSONAL_WORKSPACES_KEY, 2],
        [shared, 5]
      ].sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
    expect((await breakdown(clientInstanceId, "workflow")).map((row) => row.key)).toEqual([
      "",
      "weekly-digest"
    ]);
    expect((await breakdown(clientInstanceId, "app")).map((row) => row.key)).toEqual([
      "",
      "quote-desk"
    ]);
    expect(
      (await breakdown(clientInstanceId, "origin")).map((row) => [row.key, row.modelCallCount])
    ).toEqual([
      ["app", 1],
      ["conversation", 4],
      ["knowledge_base", 1],
      ["system", 1],
      ["workflow", 1]
    ]);
    // A Workflow's agent step names its agent.
    expect((await breakdown(clientInstanceId, "agent")).map((row) => row.key)).toEqual([
      "",
      "digest_writer",
      "quoter",
      "reader",
      "writer"
    ]);
    // A row opens the same table narrowed to it.
    expect(
      (await breakdown(clientInstanceId, "agent", { workspace: shared })).map((row) => [
        row.key,
        row.modelCallCount
      ])
    ).toEqual([
      ["", 2],
      ["quoter", 1],
      ["writer", 2]
    ]);
  });

  it("sums to the same total by every dimension (check 13)", async () => {
    const { clientInstanceId } = await arrange("totals");
    const days = await breakdown(clientInstanceId, "day");
    const total = days.reduce((sum, day) => sum + cost(day), 0);
    expect(total).toBeGreaterThan(0);
    const [whole] = await breakdown(clientInstanceId, "all");
    expect(whole && [cost(whole), whole.modelCallCount]).toEqual([total, 8]);
    for (const dimension of USAGE_BREAKDOWN_DIMENSIONS) {
      const rows = await breakdown(clientInstanceId, dimension);
      expect(rows.reduce((sum, row) => sum + cost(row), 0)).toBe(total);
      expect(rows.reduce((sum, row) => sum + row.modelCallCount, 0)).toBe(8);
    }
  });

  // The deploy step: rows a process of the previous release wrote under the empty keys, or no
  // sums at all, are put back under their keys by the reconciliation with scope `all`.
  it("re-keys the sums from the events with the reconciliation of everything", async () => {
    const { clientInstanceId, shared } = await arrange("rekey");
    const before = await breakdown(clientInstanceId, "workspace");
    await db.sql`delete from model_usage_daily_rollups where client_instance_id = ${clientInstanceId}`;
    expect(await breakdown(clientInstanceId, "workspace")).toEqual([]);

    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "all" });

    expect(await breakdown(clientInstanceId, "workspace")).toEqual(before);
    expect(before.map((row) => row.key)).toContain(shared);
  });

  // An owner's figures per member come from the workspace's events: what a member did in
  // another workspace is not among them.
  it("sums a shared workspace's members from its events alone", async () => {
    const { clientInstanceId, shared, anna, ben } = await arrange("members");
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const members = await db.store.usage.summarizeWorkspaceMemberUsage({
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(shared),
      from: start.toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(members.map((member) => [member.userId, member.modelCallCount])).toEqual(
      [
        [anna, 4],
        [ben, 1]
      ].sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
    const [sharedRow] = await breakdown(clientInstanceId, "day", { workspace: shared });
    expect(members.reduce((sum, member) => sum + cost(member), 0)).toBe(cost(required(sharedRow)));
  });

  it("lists each person's own month from their spend counter, without the product's calls", async () => {
    const { clientInstanceId, anna, ben } = await arrange("people");
    const spend = await db.store.usage.listUserMonthSpend({
      clientInstanceId,
      month: today().slice(0, 7)
    });
    // Anna's title and ingestion are not hers; her three agent calls are.
    expect(spend.map((person) => [person.userId, person.modelCallCount])).toEqual(
      [
        [anna, 3],
        [ben, 2]
      ].sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
  });

  it("counts the activity of a period, of the instance and of one workspace", async () => {
    const { clientInstanceId, shared } = await arrange("activity");
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const instance = await db.store.usage.countUsageActivity({ clientInstanceId, from, to });
    expect(instance).toEqual({
      activeUsers: 0,
      conversations: 0,
      agentRuns: 0,
      appActionRuns: 1,
      workflowRuns: 1
    });
    const workspace = await db.store.usage.countUsageActivity({
      clientInstanceId,
      from,
      to,
      collaborationWorkspaceId: asCollaborationWorkspaceId(shared)
    });
    expect(workspace).toEqual({
      activeUsers: 2,
      conversations: 3,
      agentRuns: 3,
      appActionRuns: 1,
      workflowRuns: 0
    });
  });
});
