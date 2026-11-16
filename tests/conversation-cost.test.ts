import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { conversationCostSchema } from "@work-shape/catalyst-api-contract";
import {
  asAgentRunId,
  asConversationId,
  asUserId,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelUsageEventStore,
  type UsageRateCardConfig
} from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { usePostgresSuite } from "./support/postgres-suite";
import { createSubagentFixture } from "./support/subagent-runs";
import { withTestSql } from "./support/test-sql";

// The cost of a conversation so far in the context indicator (LU-7, limits spec 3.6, checks 27
// to 29): the chat, its subagent threads and its title; whose calls by the chat's readers and
// `usage.view`; off unless the instance turns it on.

const rateCard: UsageRateCardConfig = {
  id: "customer",
  version: "2026-11",
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

/** One call of 1,000 input and 1,000 output tokens: 0.002 € plus 0.008 €. */
const CALL_MICROS = 10_000;

const governanceOf = (store: ModelUsageEventStore) =>
  new ModelUsageGovernance({
    store,
    costs: { customer: rateCard },
    budget: {},
    safeguards: {}
  });

function recordCall(
  governance: ModelUsageGovernance,
  instance: ClientInstanceId,
  attribution: ModelAttribution,
  model = "local"
) {
  return governance.recordModelUsage({
    clientInstanceId: instance,
    attribution,
    providerId: "local",
    model,
    correlationId: `corr_${randomUUID()}`,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    outputTokens: 1_000,
    totalTokens: 2_000,
    source: "provider_reported"
  });
}

const runCall = (conversationId: string, userId: string): ModelAttribution => ({
  kind: "agent_run",
  conversationId: asConversationId(conversationId),
  runId: asAgentRunId(`run_${randomUUID()}`),
  agentName: "assistant",
  userId
});

const titleCall = (conversationId: string, userId: string): ModelAttribution => ({
  kind: "system",
  purpose: "conversation_title",
  conversationId: asConversationId(conversationId),
  userId
});

describe("the cost of a conversation in Postgres", () => {
  const db = usePostgresSuite("convcost");

  it("sums the chat, its subagent threads and its title, without calls in flight", async () => {
    const fixture = await createSubagentFixture(db, "sum");
    const governance = governanceOf(db.store.usage);
    const root = await fixture.createConversation("split the report");
    const parent = await fixture.startParent(root);
    const child = await fixture.startChild(parent.run, "first half");
    const other = await fixture.createConversation("something else");
    const author = fixture.user.id;
    const colleague = await db.store.users.createUser({
      clientInstanceId: fixture.clientInstanceId,
      displayLabel: "Colleague"
    });

    await recordCall(governance, fixture.clientInstanceId, runCall(root.id, author));
    await recordCall(governance, fixture.clientInstanceId, runCall(child.threadId, author));
    await recordCall(governance, fixture.clientInstanceId, titleCall(root.id, author));
    await recordCall(governance, fixture.clientInstanceId, runCall(root.id, colleague.id));
    // Another chat's call, and a call still running, are in no sum.
    await recordCall(governance, fixture.clientInstanceId, runCall(other.id, author));
    const running = await recordCall(
      governance,
      fixture.clientInstanceId,
      runCall(root.id, author)
    );
    await db.sql`update model_usage_events set status = 'pending' where id = ${running.id}`;

    await expect(
      governance.summarizeConversationCost({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: root.id
      })
    ).resolves.toEqual({ currency: "EUR", costMicros: 4 * CALL_MICROS, complete: true });
    await expect(
      governance.summarizeConversationCost({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: root.id,
        userId: author
      })
    ).resolves.toEqual({ currency: "EUR", costMicros: 3 * CALL_MICROS, complete: true });

    // A call the rate card does not price leaves the sum at what is known.
    await recordCall(governance, fixture.clientInstanceId, runCall(root.id, author), "unpriced");
    await expect(
      governance.summarizeConversationCost({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: root.id,
        userId: author
      })
    ).resolves.toEqual({ currency: "EUR", costMicros: 3 * CALL_MICROS, complete: false });
  });

  it("names no currency without a Customer Rate Card, so the line is not shown", async () => {
    const fixture = await createSubagentFixture(db, "nocard");
    const root = await fixture.createConversation("priced once");
    await recordCall(
      governanceOf(db.store.usage),
      fixture.clientInstanceId,
      runCall(root.id, fixture.user.id)
    );
    const unpriced = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });
    const cost = await unpriced.summarizeConversationCost({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: root.id
    });
    expect(cost.currency).toBeUndefined();
  });

  it("reads the events of a conversation by its index", async () => {
    const [plan] = await db.sql<{ "QUERY PLAN": string }[]>`
      select indexdef as "QUERY PLAN" from pg_indexes
      where indexname = 'model_usage_events_conversation_idx'`;
    expect(plan?.["QUERY PLAN"]).toContain("(client_instance_id, conversation_id)");
  });
});

describe("conversations.cost.get", () => {
  const instances: AccessInstance[] = [];
  afterEach(async () => {
    await Promise.all(instances.splice(0).map((t) => t.instance.close()));
  });

  async function setup(showConversationCost: boolean) {
    const t = await setupAccessInstance({
      server: (stores, config) => ({
        config: { ...config, usage: { ...config.usage, showConversationCost } },
        usageGovernance: governanceOf(stores.usage)
      })
    });
    instances.push(t);
    const team = await t.sharedWorkspace("Team");
    for (const person of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(person.id),
        role: "member"
      });
    }
    // A chat starts private; a team chat is one the whole workspace reads.
    const create = async (visibility: "workspace" | "private") => {
      const { id } = await t
        .expectOk(t.kai.id, "conversations.create", {
          payload: { title: "Figures", collaborationWorkspaceId: team, visibility: "private" }
        })
        .then((response) => response.json<{ id: string }>());
      if (visibility === "workspace") {
        await withTestSql(
          (sql) => sql`update conversations set visibility = 'workspace' where id = ${id}`
        );
      }
      return id;
    };
    return { t, governance: governanceOf(t.stores.usage), team, create };
  }

  const read = async (t: AccessInstance, userId: string, conversationId: string) => {
    const response = await t.expectOk(userId, "conversations.cost.get", {
      params: { conversationId }
    });
    return conversationCostSchema.parse(response.json());
  };

  it("shows each reader of a team chat their own share, and the whole chat with usage.view", async () => {
    const { t, governance, create } = await setup(true);
    const chat = await create("workspace");
    await recordCall(governance, clientInstanceId, runCall(chat, t.kai.id));
    await recordCall(governance, clientInstanceId, titleCall(chat, t.kai.id));
    await recordCall(governance, clientInstanceId, runCall(chat, t.lena.id));

    await expect(read(t, t.kai.id, chat)).resolves.toEqual({
      scope: "own",
      shared: true,
      currency: "EUR",
      costMicros: 2 * CALL_MICROS,
      complete: true
    });
    await expect(read(t, t.lena.id, chat)).resolves.toMatchObject({
      scope: "own",
      costMicros: CALL_MICROS
    });
    // The administrator, a member of the workspace, holds `usage.view`.
    await expect(read(t, t.admin.id, chat)).resolves.toMatchObject({
      scope: "conversation",
      shared: true,
      costMicros: 3 * CALL_MICROS
    });
  });

  it("shows a private chat's person their own calls and nobody else anything", async () => {
    const { t, governance, create } = await setup(true);
    const chat = await create("private");
    await recordCall(governance, clientInstanceId, runCall(chat, t.kai.id));

    await expect(read(t, t.kai.id, chat)).resolves.toEqual({
      scope: "own",
      shared: false,
      currency: "EUR",
      costMicros: CALL_MICROS,
      complete: true
    });
    for (const userId of [t.lena.id, t.admin.id]) {
      await t.expectRefused(
        userId,
        "conversations.cost.get",
        { params: { conversationId: chat } },
        { status: 404, code: "NOT_FOUND" }
      );
    }

    // Shared with Lena, it is a chat more people read: the administrator still reads nothing,
    // and Kai's figure is his share.
    await t.expectOk(t.kai.id, "conversations.add_person", {
      params: { conversationId: chat },
      payload: { userId: t.lena.id }
    });
    await recordCall(governance, clientInstanceId, runCall(chat, t.lena.id));
    await expect(read(t, t.kai.id, chat)).resolves.toMatchObject({
      scope: "own",
      shared: true,
      costMicros: CALL_MICROS
    });
    await expect(read(t, t.lena.id, chat)).resolves.toMatchObject({
      scope: "own",
      costMicros: CALL_MICROS
    });
  });

  it("answers not found while the instance does not show it", async () => {
    const { t, governance, create } = await setup(false);
    const chat = await create("workspace");
    await recordCall(governance, clientInstanceId, runCall(chat, t.kai.id));
    await t.expectRefused(
      t.kai.id,
      "conversations.cost.get",
      { params: { conversationId: chat } },
      { status: 404, code: "NOT_FOUND" }
    );
  });
});
