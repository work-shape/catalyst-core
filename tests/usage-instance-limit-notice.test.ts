import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NOTICE_KIND,
  StoreBackedAuditRecorder,
  asAgentRunId,
  asConversationId,
  asUserId,
  type UsageBudgetConfig,
  type UsageRateCardConfig
} from "@work-shape/catalyst-core";
import { noticeReachedInstanceLimit } from "@work-shape/catalyst-server";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { withTestSql } from "./support/test-sql";

// The instance's spend limit is reached (LU-2, limits spec 3.1): those who can raise it, the
// holders of `limits.manage`, get one Inbox item of kind `notice` per period, in their
// language, naming the limit, when it resets and who can raise it.

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
const CEILING: UsageBudgetConfig = { dailySpendLimit: 50, monthlySpendLimit: 500 };
/** One answer at 0.26 EUR: 50,000 tokens in, 20,000 out. */
const ANSWER = {
  inputTokens: 50_000,
  cachedInputTokens: 0,
  outputTokens: 20_000,
  totalTokens: 70_000,
  source: "provider_reported" as const,
  webSearchCallCount: 0
};

const noticeTextSchema = z.object({ text: z.string() });

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(budget: UsageBudgetConfig = CEILING) {
  let config: Parameters<typeof noticeReachedInstanceLimit>[0]["config"] | undefined;
  let governance: ModelUsageGovernance | undefined;
  const t = await setupAccessInstance({
    server: (stores, instanceConfig) => {
      config = instanceConfig;
      governance = new ModelUsageGovernance({
        store: stores.usage,
        costs: { customer: rateCard },
        budget,
        safeguards: {}
      });
      return { usageGovernance: governance };
    }
  });
  instances.push(t);
  // The server, and with it the governance and the config, is built on the first call.
  await t.expectOk(t.admin.id, "me.usage.get", {});
  if (!governance || !config) throw new Error("The instance was set up without its server");
  const usageGovernance = governance;
  const options = {
    clientInstanceId,
    stores: t.stores,
    usageGovernance,
    config,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: t.stores.audit })
  };
  return {
    t,
    /** One answer of Kai's, settled at 0.26 EUR. */
    async spend() {
      const admitted = await usageGovernance.admitModelCall({
        clientInstanceId,
        attribution: {
          kind: "agent_run",
          conversationId: asConversationId(`conv_${crypto.randomUUID()}`),
          runId: asAgentRunId(`run_${crypto.randomUUID()}`),
          agentName: "assistant",
          userId: t.kai.id
        },
        providerId: "local",
        model: "local",
        correlationId: `corr_${crypto.randomUUID()}`,
        request: { inputCharacters: 3_000 }
      });
      await usageGovernance.settleModelCall(admitted, ANSWER);
    },
    run: () => noticeReachedInstanceLimit(options, { now: new Date() }),
    notices: async () =>
      (
        await t.stores.approvals.listApprovalRequests({ clientInstanceId, kinds: [NOTICE_KIND] })
      ).map((item) => ({
        to: item.addresseeUserId,
        title: item.summary,
        text: noticeTextSchema.parse(item.payload).text
      }))
  };
}

describe("the notice that the instance's spend limit is reached", () => {
  it("reaches each holder of limits.manage once a day, in their language", async () => {
    const f = await setup();
    await f.t.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(f.t.admin.id),
      locale: "de"
    });
    await f.t.expectOk(f.t.admin.id, "usage.limits.set", {
      payload: { level: "instance", limits: { daily: 0.2 } }
    });

    // Below the limit nobody hears anything.
    await expect(f.run()).resolves.toEqual([]);
    await f.spend();
    await expect(f.run()).resolves.toEqual(["day"]);

    const notices = await f.notices();
    expect(notices.map((notice) => notice.to).sort()).toEqual([f.t.admin.id, f.t.root.id].sort());
    expect(notices.find((notice) => notice.to === f.t.admin.id)).toEqual({
      to: f.t.admin.id,
      title: "Das tägliche Ausgabenlimit für alle Arbeitsbereiche ist erreicht",
      text:
        "Alle Arbeitsbereiche zusammen haben ihr tägliches Ausgabenlimit von 0,20 € erreicht. " +
        "Bis es um Mitternacht UTC zurückgesetzt wird, wird in keinem Arbeitsbereich eine Nachricht beantwortet. " +
        "Du kannst es unter Einstellungen › Alle Arbeitsbereiche › Limits erhöhen, bis zur Obergrenze des technischen Teams."
    });
    expect(notices.find((notice) => notice.to === f.t.root.id)?.title).toBe(
      "The daily spend limit for all workspaces is reached"
    );

    // The same day again files nothing; the admin reads it in their own Inbox.
    await expect(f.run()).resolves.toEqual([]);
    expect(await f.notices()).toHaveLength(2);
    const inbox = await f.t.expectOk(f.t.admin.id, "approval_requests.list", {});
    expect(JSON.stringify(inbox.json())).toContain("Ausgabenlimit für alle Arbeitsbereiche");

    const sent = await f.t.stores.audit.listAuditEvents({ clientInstanceId, limit: 50 });
    expect(sent.filter((event) => event.type === "notice.sent")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ addressees: 2 }) })
    ]);
  });

  it("names the technical team at the release config's limit, and heeds a deny", async () => {
    const f = await setup({ dailySpendLimit: 0.2, monthlySpendLimit: 500 });
    await withTestSql(async (sql) => {
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values (${`grant_${crypto.randomUUID()}`}, ${clientInstanceId}, 'user', ${f.t.admin.id},
          'limits.manage', 'instance', 'deny', ${f.t.root.id}, now())`;
    });
    await f.spend();

    await expect(f.run()).resolves.toEqual(["day"]);
    const notices = await f.notices();
    expect(notices.map((notice) => notice.to)).toEqual([f.t.root.id]);
    expect(notices[0]?.text).toContain(
      "This is the technical team's upper limit: only the technical team can raise it."
    );
  });

  it("gives notice of the month apart from the day", async () => {
    const f = await setup();
    await f.t.expectOk(f.t.admin.id, "usage.limits.set", {
      payload: { level: "instance", limits: { monthly: 0.2 } }
    });
    await f.spend();

    await expect(f.run()).resolves.toEqual(["month"]);
    expect((await f.notices()).map((notice) => notice.title)).toEqual([
      "The monthly spend limit for all workspaces is reached",
      "The monthly spend limit for all workspaces is reached"
    ]);
    await expect(f.run()).resolves.toEqual([]);
  });
});
