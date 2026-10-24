import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  usageBreakdownSchema,
  usageSummarySchema,
  usageUsersSchema,
  workspaceMembersUsageSchema,
  workspaceUsageSchema
} from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asConversationId,
  asUserId,
  PERSONAL_WORKSPACES_KEY,
  type CollaborationWorkspaceId,
  type UsageRateCardConfig
} from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// The Usage page's reads (LU-3, limits spec 3.3 and 3.4, acceptance checks 14 to 16): the
// Breakdown for whoever may view usage, a shared workspace's Usage tab for its Owners and
// Admins, figures by named person only with `usage.view_users`, and an audit event for every
// read of them that names who looked and when, and nothing of what they saw.

const rateCard: UsageRateCardConfig = {
  id: "customer",
  version: "2026-10",
  currency: "EUR",
  models: [
    {
      providerId: "local",
      model: "local",
      uncachedInputPricePerMillionTokens: 2,
      cachedInputPricePerMillionTokens: 0.5,
      outputPricePerMillionTokens: 8
    }
  ]
};

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/**
 * Kai owns a shared workspace Lena is a member of; both used a model there, and each in their
 * Personal Workspace. The administrator holds `usage.view_users` by role; Kai and Lena hold
 * nothing.
 */
async function setup() {
  const governanceOf = (store: AccessInstance["stores"]["usage"]) =>
    new ModelUsageGovernance({
      store,
      costs: { customer: rateCard },
      budget: {},
      safeguards: {}
    });
  const t = await setupAccessInstance({
    server: (stores) => ({ usageGovernance: governanceOf(stores.usage) })
  });
  instances.push(t);
  const usage = governanceOf(t.stores.usage);
  const shared = await t.sharedWorkspace(`team-${randomUUID().slice(0, 6)}`);
  const other = await t.sharedWorkspace(`other-${randomUUID().slice(0, 6)}`);
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: shared,
    userId: asUserId(t.kai.id),
    role: "owner"
  });
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: shared,
    userId: asUserId(t.lena.id),
    role: "member"
  });
  const personal = async (userId: string) =>
    (
      await t.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(userId)
      })
    ).id;
  const call = (userId: string, workspaceId: string, agentName: string, tokens = 1_000) =>
    usage.recordModelUsage({
      clientInstanceId,
      attribution: {
        kind: "agent_run",
        conversationId: asConversationId(`conv_${randomUUID()}`),
        runId: asAgentRunId(`run_${randomUUID()}`),
        agentName,
        userId,
        workspaceId
      },
      providerId: "local",
      model: "local",
      correlationId: `corr_${randomUUID()}`,
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: tokens,
      totalTokens: tokens * 2,
      source: "provider_reported"
    });
  await call(t.kai.id, shared, "writer");
  await call(t.lena.id, shared, "writer", 2_000);
  await call(t.lena.id, shared, "reader");
  await call(t.kai.id, await personal(t.kai.id), "writer");
  await call(t.lena.id, await personal(t.lena.id), "writer");
  await call(t.admin.id, other, "reader", 4_000);
  return { t, shared, other };
}

const period = () => ({ from: today(), to: tomorrow() });

async function audited(t: AccessInstance, type: string) {
  const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
  return events.filter((event) => event.type === type);
}

function workspaceUsage(t: AccessInstance, userId: string, workspaceId: CollaborationWorkspaceId) {
  return t.call(userId, "workspaces.usage.get", {
    params: { collaborationWorkspaceId: workspaceId },
    query: { ...period(), groupBy: "agent" }
  });
}

describe("the Breakdown", () => {
  it("shows a shared workspace by name and every Personal Workspace as one row", async () => {
    const { t, shared } = await setup();
    const response = await t.expectOk(t.admin.id, "usage.breakdown.get", {
      query: { ...period(), groupBy: "workspace" }
    });
    const breakdown = usageBreakdownSchema.parse(response.json());
    expect(breakdown.total.modelCallCount).toBe(6);
    const team = breakdown.rows.find((row) => row.key === shared);
    expect(team).toMatchObject({ modelCallCount: 3, name: expect.stringMatching(/^team-/u) });
    const personal = breakdown.rows.filter((row) => row.key === PERSONAL_WORKSPACES_KEY);
    expect(personal).toHaveLength(1);
    expect(personal[0]?.modelCallCount).toBe(2);
    // No row names a person or a Personal Workspace's id.
    expect(JSON.stringify(breakdown)).not.toMatch(new RegExp(`${t.kai.id}|${t.lena.id}`, "u"));
  });

  it("narrows to one row and groups it by the next dimension", async () => {
    const { t, shared } = await setup();
    const response = await t.expectOk(t.admin.id, "usage.breakdown.get", {
      query: { ...period(), groupBy: "agent", workspace: shared }
    });
    const breakdown = usageBreakdownSchema.parse(response.json());
    expect(breakdown.rows.map((row) => [row.key, row.modelCallCount])).toEqual([
      ["reader", 1],
      ["writer", 2]
    ]);
  });

  it("is refused to a person without the right to view usage", async () => {
    const { t } = await setup();
    await t.expectRefused(
      t.kai.id,
      "usage.breakdown.get",
      { query: { ...period(), groupBy: "agent" } },
      { status: 403, code: "FORBIDDEN" }
    );
  });
});

describe("the recent calls", () => {
  // The architect's ruling: no user column for anyone; a call in a Personal Workspace names
  // no one.
  it("name the workspace and never the person", async () => {
    const { t, shared } = await setup();
    const response = await t.expectOk(t.admin.id, "usage.get_summary");
    const summary = usageSummarySchema.parse(response.json());
    const workspaces = summary.recentEvents.map((event) => event.workspace?.key);
    expect(workspaces.filter((key) => key === shared)).toHaveLength(3);
    expect(workspaces.filter((key) => key === PERSONAL_WORKSPACES_KEY)).toHaveLength(2);
    expect(JSON.stringify(summary.recentEvents)).not.toMatch(
      new RegExp(`${t.kai.id}|${t.lena.id}|userId`, "u")
    );
    expect(summary.activity).toMatchObject({ agentRuns: expect.any(Number) });
  });
});

describe("a shared workspace's Usage tab (check 14)", () => {
  it("shows its Owner its consumption and Breakdown, and no figures per member by default", async () => {
    const { t, shared } = await setup();
    const response = await workspaceUsage(t, t.kai.id, shared);
    expect(response.statusCode).toBe(200);
    const usage = workspaceUsageSchema.parse(response.json());
    expect(usage.month.modelCallCount).toBe(3);
    // Every day of the month up to today, a day without usage too.
    expect(usage.days.map((day) => day.date)).toEqual(
      Array.from(
        { length: new Date().getUTCDate() },
        (_, index) => `${today().slice(0, 8)}${String(index + 1).padStart(2, "0")}`
      )
    );
    expect(usage.days.at(-1)?.modelCallCount).toBe(3);
    expect(usage.breakdown.rows.map((row) => [row.key, row.modelCallCount])).toEqual([
      ["reader", 1],
      ["writer", 2]
    ]);
    expect(usage.activity.activeUsers).toBe(2);
    expect(usage.membersVisible).toBe(false);
    await t.expectRefused(
      t.kai.id,
      "workspaces.member_usage.list",
      { params: { collaborationWorkspaceId: shared } },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(await audited(t, "governance.usage_users_viewed")).toEqual([]);
  });

  it("shows no other workspace, and nothing to a member who is no Owner or Admin", async () => {
    const { t, shared, other } = await setup();
    expect((await workspaceUsage(t, t.kai.id, other)).statusCode).toBe(404);
    expect((await workspaceUsage(t, t.lena.id, shared)).statusCode).toBe(403);
  });

  it("shows the figures per member once the Owner is granted usage by person there", async () => {
    const { t, shared } = await setup();
    await t.grant(t.kai.id, "usage.view_users", { workspaceId: shared });

    const usage = workspaceUsageSchema.parse((await workspaceUsage(t, t.kai.id, shared)).json());
    expect(usage.membersVisible).toBe(true);
    const response = await t.expectOk(t.kai.id, "workspaces.member_usage.list", {
      params: { collaborationWorkspaceId: shared }
    });
    const members = workspaceMembersUsageSchema.parse(response.json());
    // Only what each used in this workspace: their Personal Workspaces are not in it.
    expect(members.items.map((item) => [item.userId, item.modelCallCount])).toEqual(
      expect.arrayContaining([
        [t.kai.id, 1],
        [t.lena.id, 2]
      ])
    );
    expect(members.items).toHaveLength(2);
  });

  it("keeps a workspace's grant of usage by person to that workspace", async () => {
    const { t, shared, other } = await setup();
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: other,
      userId: asUserId(t.kai.id),
      role: "owner"
    });
    await t.grant(t.kai.id, "usage.view_users", { workspaceId: shared });

    // Owner of the other workspace as well, but the right is only for the first.
    const otherUsage = workspaceUsageSchema.parse(
      (await workspaceUsage(t, t.kai.id, other)).json()
    );
    expect(otherUsage.membersVisible).toBe(false);
    await t.expectRefused(
      t.kai.id,
      "workspaces.member_usage.list",
      { params: { collaborationWorkspaceId: other } },
      { status: 403, code: "FORBIDDEN" }
    );
    // Nor does it reach the instance's Users view or its Breakdown.
    await t.expectRefused(t.kai.id, "usage.users.list", {}, { status: 403, code: "FORBIDDEN" });
    await t.expectRefused(
      t.kai.id,
      "usage.breakdown.get",
      { query: { ...period(), groupBy: "agent" } },
      { status: 403, code: "FORBIDDEN" }
    );
    expect(await audited(t, "governance.usage_users_viewed")).toHaveLength(0);
  });

  it("refuses a month that does not exist before anything is read or audited", async () => {
    const { t, shared } = await setup();
    await t.grant(t.kai.id, "usage.view_users", { workspaceId: shared });
    await t.expectRefused(
      t.admin.id,
      "usage.users.list",
      { query: { month: "2026-13" } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    await t.expectRefused(
      t.kai.id,
      "workspaces.member_usage.list",
      { params: { collaborationWorkspaceId: shared }, query: { month: "2026-00" } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    await t.expectRefused(
      t.admin.id,
      "usage.breakdown.get",
      { query: { from: "2026-02-30", to: "2026-03-02", groupBy: "agent" } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(await audited(t, "governance.usage_users_viewed")).toHaveLength(0);
  });

  it("has no Usage tab for a Personal Workspace", async () => {
    const { t } = await setup();
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.kai.id)
    });
    expect((await workspaceUsage(t, t.kai.id, personal.id)).statusCode).toBe(404);
  });
});

describe("usage by named person (checks 15 and 16)", () => {
  it("shows an administrator the Users view by name, and refuses a person without the right", async () => {
    const { t } = await setup();
    const response = await t.expectOk(t.admin.id, "usage.users.list");
    const users = usageUsersSchema.parse(response.json());
    expect(users.currency).toBe("EUR");
    const names = users.items.map((item) => item.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(users.items.find((item) => item.userId === t.lena.id)).toMatchObject({
      modelCallCount: 3
    });

    await t.expectRefused(
      t.kai.id,
      "usage.users.list",
      {},
      {
        status: 403,
        code: "FORBIDDEN"
      }
    );
  });

  it("writes an audit event for each opening with the actor and the month, and no figure", async () => {
    const { t, shared } = await setup();
    await t.expectOk(t.admin.id, "usage.users.list", { query: { month: today().slice(0, 7) } });
    await t.grant(t.kai.id, "usage.view_users", { workspaceId: shared });
    await t.expectOk(t.kai.id, "workspaces.member_usage.list", {
      params: { collaborationWorkspaceId: shared }
    });

    const views = await audited(t, "governance.usage_users_viewed");
    expect(views.map((event) => [event.actor?.userId, event.metadata])).toEqual(
      expect.arrayContaining([
        [t.admin.id, { view: "instance", month: today().slice(0, 7) }],
        [t.kai.id, { view: "workspace", month: today().slice(0, 7), workspaceId: shared }]
      ])
    );
    expect(views).toHaveLength(2);
    // The grant is audited as every grant is.
    const grants = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
      (event) =>
        JSON.stringify(event).includes("usage.view_users") &&
        event.type !== "governance.usage_users_viewed"
    );
    expect(grants.length).toBeGreaterThan(0);
  });
});
