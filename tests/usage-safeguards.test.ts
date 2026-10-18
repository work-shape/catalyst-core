import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadClientInstanceConfigFromFile,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  asAgentRunId,
  asConversationId,
  asUserId,
  isAppError,
  KNOWLEDGE_INGESTION_PURPOSES,
  ModelUsageLimitReachedError,
  runFailureCodeOf,
  type AdmittedModelCall,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelCallAdmission,
  type ModelSystemPurpose,
  type ModelUsageRefusal,
  type UsageBudgetConfig,
  type UsageRateCardConfig,
  type UsageSafeguardsConfig
} from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { required } from "./support/assertions";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance, type TestPostgresStore } from "./support/test-instance";
import { ensureTestUser } from "./support/test-store";

// Three thousand characters are reserved as 1,000 input tokens, and a request without a
// maximum as 16,000 output tokens: 1,000 at 2 and 16,000 at 8 per million cost 130,000 micros.
const REQUEST_CHARACTERS = 3_000;
const RESERVED_TOKENS = 17_000;
const RESERVED_COST_MICROS = 130_000;
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

/**
 * One person's normal agent use, measured in the acceptance walk of 2026-10-18 (ACCEPT-1c): 91
 * model calls holding 2.5 million tokens on the counters in 35 minutes, until the instance-wide
 * safeguard of 2.5 million tokens a day stopped everyone.
 */
const MEASURED = { calls: 91, tokens: 2_500_000, minutes: 35 };
const WORKING_DAY_MINUTES = 8 * 60;
const WORKING_DAYS_A_MONTH = 22;
/** Ten times the measured session, and five times an extrapolated eight-hour day. */
const SESSION_HEADROOM = 10;
const BUSY_DAY_HEADROOM = 5;
const honestDay = {
  calls: Math.ceil((MEASURED.calls * WORKING_DAY_MINUTES) / MEASURED.minutes),
  tokens: Math.ceil((MEASURED.tokens * WORKING_DAY_MINUTES) / MEASURED.minutes)
};

type Limits = { budget?: UsageBudgetConfig; safeguards?: UsageSafeguardsConfig };

describe("usage safeguards per person", () => {
  const db = usePostgresSuite("usagesafeguards");

  function governanceOf(
    limits: Limits,
    store: TestPostgresStore = db.store,
    abandonedAfterMs?: number
  ): ModelUsageGovernance {
    return new ModelUsageGovernance({
      store: store.usage,
      costs: { customer: rateCard },
      budget: limits.budget ?? {},
      safeguards: limits.safeguards ?? {},
      ...(abandonedAfterMs === undefined ? {} : { abandonedAfterMs })
    });
  }

  /** A client instance of its own with the rows of the people its calls are for. */
  async function instanceWith(label: string, people: string[]) {
    const clientInstanceId = db.clientInstance(label);
    const ids = people.map((person) => `${clientInstanceId}_${person}`);
    for (const id of ids) await ensureTestUser(clientInstanceId, id);
    return { clientInstanceId, people: ids };
  }

  function admission(
    clientInstanceId: ClientInstanceId,
    attribution: ModelAttribution
  ): ModelCallAdmission {
    return {
      clientInstanceId,
      attribution,
      providerId: "azure-eu",
      model: "gpt-main",
      correlationId: `corr_${clientInstanceId}`,
      request: { inputCharacters: REQUEST_CHARACTERS }
    };
  }

  /** A call a person makes in a conversation: an agent run's. */
  const own = (clientInstanceId: ClientInstanceId, userId: string, workspaceId?: string) =>
    admission(clientInstanceId, {
      kind: "agent_run",
      conversationId: asConversationId(`conv_${userId}`),
      runId: asAgentRunId(`run_${userId}`),
      agentName: "assistant",
      userId,
      ...(workspaceId === undefined ? {} : { workspaceId })
    });

  /** A call the product makes for a person, or for nobody when `userId` is absent. */
  const product = (
    clientInstanceId: ClientInstanceId,
    purpose: ModelSystemPurpose,
    userId?: string
  ) =>
    admission(clientInstanceId, {
      kind: "system",
      purpose,
      ...(userId === undefined ? {} : { userId })
    });

  /** Every counter of the instance, by scope and period, without the period's date. */
  async function counters(clientInstanceId: ClientInstanceId) {
    const rows = await db.sql<
      { scope: string; period: string; calls: number; tokens: number; cost: number }[]
    >`
      select scope_kind || ':' || scope_id as scope, period_kind as period,
        model_call_count::float8 as calls, tokens::float8 as tokens,
        cost_micros::float8 as cost
      from model_usage_counters where client_instance_id = ${clientInstanceId}
      order by scope_kind, scope_id, period_kind`;
    return rows.map((row) => ({ ...row }));
  }

  async function refusalOf(attempt: Promise<AdmittedModelCall>) {
    const error: unknown = await attempt.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ModelUsageLimitReachedError);
    return isAppError(error)
      ? { code: runFailureCodeOf(error), status: error.statusCode, details: error.details }
      : undefined;
  }

  // Fails without the change: the safeguard was one counter of the instance, so the first
  // person to reach it stopped everyone.
  it("stops one person at their safeguard and lets another go on", async () => {
    const { clientInstanceId, people } = await instanceWith("two", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 2 } });

    await governance.admitModelCall(own(clientInstanceId, anna));
    await governance.admitModelCall(own(clientInstanceId, anna));

    await expect(
      refusalOf(governance.admitModelCall(own(clientInstanceId, anna)))
    ).resolves.toEqual({
      code: "MODEL_USAGE_LIMIT_REACHED",
      status: 403,
      details: {
        reason: "MODEL_USAGE_LIMIT_REACHED",
        period: "day",
        metric: "modelCallCount",
        scope: "user"
      }
    });
    await expect(governance.admitModelCall(own(clientInstanceId, ben))).resolves.toBeDefined();
  });

  // Fails without the change: the safeguards of tokens held for the instance, so Ben was
  // refused with Anna; removing the monthly one lets Anna past it.
  it.each([
    ["day", { tokensPerDay: RESERVED_TOKENS }],
    ["month", { tokensPerMonth: RESERVED_TOKENS }]
  ] as const)(
    "stops one person at their %s's tokens and lets another go on",
    async (period, safeguards) => {
      const { clientInstanceId, people } = await instanceWith(`tokens${period}`, ["anna", "ben"]);
      const [anna, ben] = [required(people[0]), required(people[1])];
      const governance = governanceOf({ safeguards });

      await governance.admitModelCall(own(clientInstanceId, anna));
      await expect(
        refusalOf(governance.admitModelCall(own(clientInstanceId, anna)))
      ).resolves.toMatchObject({ details: { period, metric: "tokens", scope: "user" } });
      await expect(governance.admitModelCall(own(clientInstanceId, ben))).resolves.toBeDefined();
    }
  );

  // Fails without the change: an outer default of zod skips the inner ones, so a config without
  // safeguards, or with an empty block, had none.
  it.each([
    ["without usage", {}],
    ["with empty safeguards", { usage: { safeguards: {} } }]
  ])("gives a config %s the shipped safeguards", (_label, usage) => {
    const config = parseClientInstanceConfig({
      clientInstance: { id: "defaults", displayName: "Defaults" },
      infrastructure: { models: { local: { provider: "deterministic" } } },
      ...usage
    });
    expect(config.usage.safeguards).toEqual({
      modelCallsPerDay: 20_000,
      tokensPerDay: 200_000_000,
      tokensPerMonth: 4_000_000_000
    });
  });

  // Fails without the change: A multiple of the largest valid limit is no safe integer of JS.
  it("keeps the shared bucket's limits safe integers for the largest valid safeguards", async () => {
    const { clientInstanceId } = await instanceWith("largest", []);
    const largest = Number.MAX_SAFE_INTEGER;
    const seen: number[] = [];
    const store = db.store;
    const governance = new ModelUsageGovernance({
      store: {
        ...store.usage,
        admitModelUsageEvent: (input) => {
          for (const scope of [input.limits.person, input.limits.unattended]) {
            for (const limit of [scope.day, scope.month]) {
              seen.push(...Object.values(limit).filter((value) => value !== undefined));
            }
          }
          return store.usage.admitModelUsageEvent(input);
        }
      },
      costs: { customer: rateCard },
      budget: {},
      safeguards: { modelCallsPerDay: largest, tokensPerDay: largest, tokensPerMonth: largest }
    });

    await expect(
      governance.admitModelCall(product(clientInstanceId, "document_extraction"))
    ).resolves.toBeDefined();
    expect(seen).toHaveLength(6);
    expect(seen.every((limit) => Number.isSafeInteger(limit) && limit === largest)).toBe(true);
  });

  // Fails without the change: a counter per workspace would let one person run a loop in each.
  it("holds one person's safeguard across all their workspaces", async () => {
    const { clientInstanceId, people } = await instanceWith("workspaces", ["anna"]);
    const anna = required(people[0]);
    const workspaces = await Promise.all(
      ["Sales", "Legal"].map((name) =>
        db.store.workspaces.createWorkspace({
          clientInstanceId,
          kind: "shared",
          name,
          creatorUserId: asUserId(anna)
        })
      )
    );
    const [sales, legal] = workspaces.map((workspace) => workspace.id);
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 2 } });

    await governance.admitModelCall(own(clientInstanceId, anna, sales));
    await governance.admitModelCall(own(clientInstanceId, anna, legal));

    await expect(
      refusalOf(governance.admitModelCall(own(clientInstanceId, anna, legal)))
    ).resolves.toMatchObject({ details: { scope: "user" } });
    const events = await db.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events.map((event) => event.collaborationWorkspaceId).sort()).toEqual(
      [sales, legal].sort()
    );
  });

  // Fails without the change: titles and guardrail checks used up the person's own safeguard.
  it("keeps the calls the product makes for a person off that person's own safeguard", async () => {
    const { clientInstanceId, people } = await instanceWith("system", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 2 } });

    await governance.admitModelCall(own(clientInstanceId, anna));
    // The query of a Knowledge Base search is chat: the person's own.
    await governance.admitModelCall(product(clientInstanceId, "knowledge_query", anna));
    await expect(
      refusalOf(governance.admitModelCall(own(clientInstanceId, anna)))
    ).resolves.toMatchObject({ details: { scope: "user" } });

    await governance.admitModelCall(product(clientInstanceId, "conversation_title", anna));
    await governance.admitModelCall(product(clientInstanceId, "guardrail_judge", anna));
    await expect(
      refusalOf(governance.admitModelCall(product(clientInstanceId, "document_extraction", anna)))
    ).resolves.toMatchObject({ details: { scope: "system", metric: "modelCallCount" } });
    // Another person's checks have their own bucket.
    await expect(
      governance.admitModelCall(product(clientInstanceId, "guardrail_judge", ben))
    ).resolves.toBeDefined();
  });

  // Fails without the change: the calls of no person were held against the instance, or
  // against one person's safeguard, so a busy instance stopped its scheduled workflows.
  it("gives the calls of no person one bucket of seven times a person's", async () => {
    const { clientInstanceId, people } = await instanceWith("unattended", ["anna"]);
    const anna = required(people[0]);
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 2 } });

    for (let call = 0; call < 14; call += 1) {
      await governance.admitModelCall(product(clientInstanceId, "document_extraction"));
    }
    await expect(
      refusalOf(governance.admitModelCall(product(clientInstanceId, "document_extraction")))
    ).resolves.toMatchObject({ details: { scope: "system", metric: "modelCallCount" } });

    await expect(governance.admitModelCall(own(clientInstanceId, anna))).resolves.toBeDefined();
    await expect(
      governance.admitModelCall(product(clientInstanceId, "conversation_title", anna))
    ).resolves.toBeDefined();
    expect(await counters(clientInstanceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "instance:", period: "day", calls: 16 }),
        expect.objectContaining({ scope: "system:", period: "day", calls: 14 }),
        expect.objectContaining({ scope: `system:${anna}`, period: "day", calls: 1 }),
        expect.objectContaining({ scope: `user:${anna}`, period: "day", calls: 1 })
      ])
    );
  });

  // Fails without the change: everyone raced for one counter, so two people together got the
  // room of one.
  it("admits exactly each person's room when two people's calls race from three processes", async () => {
    const { clientInstanceId, people } = await instanceWith("race", ["anna", "ben"]);
    const room = 5;
    const third = await createTestInstance({ postgres: { applicationName: `${db.first}_third` } });
    try {
      const processes = [db.store, db.secondStore, third.stores].map((store) =>
        governanceOf({ safeguards: { modelCallsPerDay: room } }, store)
      );
      const results = await Promise.allSettled(
        Array.from({ length: 120 }, (_unused, index) =>
          required(processes[index % processes.length]).admitModelCall(
            own(clientInstanceId, required(people[index % people.length]))
          )
        )
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        room * people.length
      );
      const events = await db.store.usage.listModelUsageEvents({ clientInstanceId });
      for (const person of people) {
        expect(events.filter((event) => event.userId === person)).toHaveLength(room);
      }
    } finally {
      await third.close();
    }
  });

  // Fails without the change: a spend limit per person would let every person spend the budget.
  it("holds the spend budget for the whole instance, across people", async () => {
    const { clientInstanceId, people } = await instanceWith("budget", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const governance = governanceOf({
      budget: { monthlySpendLimit: (3 * RESERVED_COST_MICROS) / 1_000_000 }
    });

    await governance.admitModelCall(own(clientInstanceId, anna));
    await governance.admitModelCall(own(clientInstanceId, anna));
    await governance.admitModelCall(own(clientInstanceId, ben));

    for (const person of [anna, ben]) {
      await expect(
        refusalOf(governance.admitModelCall(own(clientInstanceId, person)))
      ).resolves.toMatchObject({
        code: "MODEL_USAGE_LIMIT_REACHED",
        details: { period: "month", metric: "costMicros", scope: "instance" }
      });
    }
  });

  // Fails without the change: settlement and recovery corrected only the instance's counters,
  // so a person's reservation stayed and refused them for the rest of the day.
  it("replaces a person's reservation by what the call used, and releases an abandoned one", async () => {
    const { clientInstanceId, people } = await instanceWith("settle", ["anna"]);
    const anna = required(people[0]);
    // Room for one call in flight.
    const governance = governanceOf({ safeguards: { tokensPerDay: RESERVED_TOKENS } }, db.store, 0);

    const first = await governance.admitModelCall(own(clientInstanceId, anna));
    await expect(
      refusalOf(governance.admitModelCall(own(clientInstanceId, anna)))
    ).resolves.toMatchObject({ details: { metric: "tokens", scope: "user" } });
    await governance.settleModelCall(first, {
      inputTokens: 900,
      cachedInputTokens: 0,
      outputTokens: 100,
      totalTokens: 1_000,
      source: "provider_reported"
    });
    expect(await counters(clientInstanceId)).toContainEqual(
      expect.objectContaining({ scope: `user:${anna}`, period: "day", tokens: 1_000 })
    );

    // A call whose process went away holds the person's place until recovery releases it.
    const small = {
      ...own(clientInstanceId, anna),
      request: { inputCharacters: 300, maxOutputTokens: 15_000 }
    };
    const lost = await governance.admitModelCall(small);
    await expect(
      refusalOf(governance.admitModelCall(own(clientInstanceId, anna)))
    ).resolves.toBeDefined();
    await expect(governance.releaseAbandonedModelCalls({ clientInstanceId })).resolves.toBe(1);
    expect(await counters(clientInstanceId)).toContainEqual(
      expect.objectContaining({ scope: `user:${anna}`, period: "day", calls: 2, tokens: 1_000 })
    );
    expect(lost.reserved.tokens).toBe(15_100);
    await expect(governance.admitModelCall(small)).resolves.toBeDefined();
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toEqual({ correctedCounters: 0, correctedSums: 0 });
  });

  /** Marks a person's account for deletion and takes them off every usage event. */
  async function erase(clientInstanceId: ClientInstanceId, userId: string) {
    await db.sql`
      update product_users set deletion_requested_at = now()
      where client_instance_id = ${clientInstanceId} and id = ${userId}`;
    let cleared = 0;
    for (;;) {
      const batch = await db.store.usage.clearUserFromModelUsageEvents({
        clientInstanceId,
        userId: asUserId(userId),
        limit: 10
      });
      if (batch === 0) return cleared;
      cleared += batch;
    }
  }

  // Fails without the change: the deletion left the person's counters, with their id, or moved
  // what the person used to the shared bucket, so deleting accounts stopped unattended work.
  it("keeps a deleted person's usage on the instance alone, and a call that ends after it too", async () => {
    const { clientInstanceId, people } = await instanceWith("deletion", ["anna"]);
    const anna = required(people[0]);
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 100 } });
    const settled = await governance.admitModelCall(own(clientInstanceId, anna));
    await governance.settleModelCall(settled, {
      inputTokens: 400,
      cachedInputTokens: 0,
      outputTokens: 100,
      totalTokens: 500,
      source: "provider_reported"
    });
    const inFlight = await governance.admitModelCall(
      product(clientInstanceId, "conversation_title", anna)
    );

    // No shared counter exists before the deletion, and none is made by it.
    await expect(erase(clientInstanceId, anna)).resolves.toBe(2);
    const instanceOnly = (tokens: number) =>
      ["day", "month"].map((period) =>
        expect.objectContaining({ scope: "instance:", period, calls: 2, tokens })
      );
    expect(await counters(clientInstanceId)).toEqual(instanceOnly(500 + RESERVED_TOKENS));

    // The title ends after the deletion: it settles on the instance's counters alone.
    await governance.settleModelCall(inFlight, {
      inputTokens: 30,
      cachedInputTokens: 0,
      outputTokens: 12,
      totalTokens: 42,
      source: "provider_reported"
    });
    expect(await counters(clientInstanceId)).toEqual(instanceOnly(542));
    // The shared counters start after the deletion without the erased calls.
    await governance.admitModelCall(product(clientInstanceId, "document_extraction"));
    expect(await counters(clientInstanceId)).toContainEqual(
      expect.objectContaining({ scope: "system:", period: "day", calls: 1 })
    );
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toEqual({ correctedCounters: 0, correctedSums: 0 });
    const [kept] = await db.sql<{ named: number }[]>`
      select count(*)::int as named from model_usage_counters
      where client_instance_id = ${clientInstanceId} and scope_id = ${anna}`;
    expect(kept?.named).toBe(0);
  });

  // Fails without the change: a deleted person's calls filled the shared bucket and stopped the
  // calls of no person.
  it("leaves the shared bucket and another person's room as they were after a deletion", async () => {
    const { clientInstanceId, people } = await instanceWith("deletedroom", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 1 } });
    for (let call = 0; call < 6; call += 1) {
      await governance.admitModelCall(product(clientInstanceId, "document_extraction"));
    }
    await governance.admitModelCall(own(clientInstanceId, anna));
    await governance.admitModelCall(product(clientInstanceId, "conversation_title", anna));

    await expect(erase(clientInstanceId, anna)).resolves.toBe(2);
    expect(await counters(clientInstanceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "instance:", period: "day", calls: 8 }),
        expect.objectContaining({ scope: "system:", period: "day", calls: 6 })
      ])
    );
    // Reconciliation does not put the erased calls on the shared bucket either.
    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" });
    expect(await counters(clientInstanceId)).toContainEqual(
      expect.objectContaining({ scope: "system:", period: "day", calls: 6 })
    );
    // The shared bucket still has the room of its own calls, and no more.
    await expect(
      governance.admitModelCall(product(clientInstanceId, "document_extraction"))
    ).resolves.toBeDefined();
    await expect(
      refusalOf(governance.admitModelCall(product(clientInstanceId, "document_extraction")))
    ).resolves.toMatchObject({ details: { scope: "system", metric: "modelCallCount" } });
    await expect(governance.admitModelCall(own(clientInstanceId, ben))).resolves.toBeDefined();
  });

  // Fails without the change: an empty correlation id marks an erased event, which counts on
  // the instance alone, so a call of no person that came without one escaped every safeguard.
  it("holds a call of no person that comes without a correlation id to the shared bucket", async () => {
    const { clientInstanceId } = await instanceWith("nocorrelation", []);
    const governance = governanceOf({ safeguards: { modelCallsPerDay: 1 } });
    // A service principal's call names a user that is no person of the instance.
    const unnamed = (userId?: string) => ({
      ...product(clientInstanceId, "document_extraction", userId),
      correlationId: ""
    });
    for (let call = 0; call < 7; call += 1) {
      await governance.admitModelCall(unnamed(call % 2 === 0 ? undefined : "service_principal"));
    }
    await expect(refusalOf(governance.admitModelCall(unnamed()))).resolves.toMatchObject({
      details: { scope: "system", metric: "modelCallCount" }
    });
    const [blank] = await db.sql<{ count: number }[]>`
      select count(*)::int from model_usage_events
      where client_instance_id = ${clientInstanceId} and correlation_id = ''`;
    expect(blank?.count).toBe(0);
  });

  // Fails without the change: reconciliation compared the instance's counters alone.
  it("adds what a previous release wrote to a person's counters, and removes those of days past", async () => {
    const { clientInstanceId, people } = await instanceWith("reconcile", ["anna"]);
    const anna = required(people[0]);
    const governance = governanceOf({});
    await governance.settleModelCall(await governance.admitModelCall(own(clientInstanceId, anna)));
    // The previous release writes an event of the person and counts it nowhere.
    await db.sql`
      insert into model_usage_events (
        id, client_instance_id, agent_name, provider_id, model, input_tokens, output_tokens,
        total_tokens, source, customer_billable_cost, correlation_id, user_id, created_at
      ) values (
        ${`usage_old_${clientInstanceId}`}, ${clientInstanceId}, 'assistant', 'azure-eu',
        'gpt-main', 40, 2, 42, 'provider_reported', '{"status":"pending"}'::jsonb, 'corr_old',
        ${anna}, now()
      )`;
    // A counter of the person for a day past.
    await db.sql`
      insert into model_usage_counters (
        client_instance_id, scope_kind, scope_id, period_kind, period_start, model_call_count
      ) values (
        ${clientInstanceId}, 'user', ${anna}, 'day', (now() at time zone 'UTC')::date - 1, 7
      )`;

    // Of the instance and of the person, the day and the month.
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toMatchObject({ correctedCounters: 4 });

    const person = (await counters(clientInstanceId)).filter(
      (counter) => counter.scope === `user:${anna}`
    );
    expect(person).toEqual([
      { scope: `user:${anna}`, period: "day", calls: 2, tokens: 42, cost: 0 },
      { scope: `user:${anna}`, period: "month", calls: 2, tokens: 42, cost: 0 }
    ]);
  });

  // Fails without the change: the instance-wide 2.5 million tokens a day stopped everyone
  // after 35 minutes of one person's work.
  it("lets several people use ten measured sessions and fits five extrapolated busy days", async () => {
    const shipped = parseClientInstanceConfig({
      clientInstance: { id: "defaults", displayName: "Defaults" },
      infrastructure: { models: { local: { provider: "deterministic" } } }
    }).usage.safeguards;
    const demo = await loadClientInstanceConfigFromFile(resolve("clients/demo/config/app.yaml"));
    expect(demo.usage.safeguards).toEqual(shipped);
    const { modelCallsPerDay, tokensPerDay, tokensPerMonth } = shipped;
    expect(required(modelCallsPerDay)).toBeGreaterThanOrEqual(SESSION_HEADROOM * MEASURED.calls);
    expect(required(tokensPerDay)).toBeGreaterThanOrEqual(BUSY_DAY_HEADROOM * honestDay.tokens);
    expect(required(tokensPerMonth)).toBeGreaterThanOrEqual(
      BUSY_DAY_HEADROOM * WORKING_DAYS_A_MONTH * honestDay.tokens
    );

    const { clientInstanceId, people } = await instanceWith("day", ["anna", "ben", "cleo"]);
    const governance = governanceOf({ safeguards: shipped });
    const callTokens = Math.ceil(MEASURED.tokens / MEASURED.calls);
    for (const person of people) {
      await governance.settleModelCall(
        await governance.admitModelCall(own(clientInstanceId, person)),
        {
          inputTokens: callTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: callTokens,
          source: "provider_reported"
        }
      );
    }
    // Each person used ten measured sessions today, written as the calls a previous release counted
    // nowhere, so reconciliation puts them on the counters in one step.
    for (const person of people) {
      await db.sql`
        insert into model_usage_events (
          id, client_instance_id, agent_name, provider_id, model, input_tokens, output_tokens,
          total_tokens, source, customer_billable_cost, correlation_id, user_id, status,
          counted_tokens, counted_cost_micros, created_at
        )
        select ${`usage_day_${person}_`} || n, ${clientInstanceId}, 'assistant', 'azure-eu',
          'gpt-main', ${callTokens}, 0, ${callTokens}, 'provider_reported',
          '{"status":"pending"}'::jsonb, 'corr_day', ${person}, 'settled', ${callTokens}, 0,
          now()
        from generate_series(1, ${SESSION_HEADROOM * MEASURED.calls - 1}) n`;
    }
    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" });

    for (const person of people) {
      await expect(governance.admitModelCall(own(clientInstanceId, person))).resolves.toBeDefined();
    }
    // The old safeguard of the instance, 2.5 million tokens a day, refuses all of them now.
    const old = governanceOf({ safeguards: { tokensPerDay: MEASURED.tokens } });
    await expect(
      refusalOf(old.admitModelCall(own(clientInstanceId, required(people[2]))))
    ).resolves.toMatchObject({
      details: { scope: "user", metric: "tokens" }
    });
  });
  it.each([
    {
      period: "day",
      metric: "modelCallCount",
      scope: "user",
      message:
        "Daily model call safeguard has been reached for your own calls. Resets at midnight UTC."
    },
    {
      period: "month",
      metric: "tokens",
      scope: "system",
      message:
        "Monthly model token safeguard has been reached for product calls. Resets at the start of next month UTC."
    },
    {
      period: "day",
      metric: "costMicros",
      scope: "instance",
      message: "Daily model spend budget has been reached for the instance. Resets at midnight UTC."
    }
  ] satisfies (ModelUsageRefusal & { message: string })[])(
    "names the refused $period $metric $scope limit and its reset",
    async ({ message, ...refused }) => {
      const governance = new ModelUsageGovernance({
        store: { ...db.store.usage, admitModelUsageEvent: async () => ({ refused }) },
        budget: {},
        safeguards: {}
      });
      await expect(
        governance.admitModelCall(own(db.clientInstance("notice"), "anna"))
      ).rejects.toMatchObject({ message, details: refused });
    }
  );

  it.each([
    ["knowledge_embedding", true],
    ["knowledge_embedding", false],
    ["knowledge_field_extraction", true],
    ["knowledge_field_extraction", false]
  ] as const)("keeps %s off chat counters with a person: %s", async (purpose, withPerson) => {
    const { clientInstanceId, people } = await instanceWith(`ingestion_${purpose}_${withPerson}`, [
      "anna"
    ]);
    const person = required(people[0]);
    const governance = governanceOf({
      safeguards: {
        modelCallsPerDay: 1,
        tokensPerDay: RESERVED_TOKENS,
        tokensPerMonth: RESERVED_TOKENS
      },
      budget: { dailySpendLimit: 0.26, monthlySpendLimit: 0.26 }
    });
    const ingestion = product(clientInstanceId, purpose, withPerson ? person : undefined);
    const usage = {
      inputTokens: 100_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 100_000_000,
      source: "provider_reported" as const
    };
    // Appended events, admission, settlement, lazy counter start and reconciliation all agree.
    await governance.recordModelUsage({ ...ingestion, ...usage });
    await governance.settleModelCall(await governance.admitModelCall(ingestion), usage);
    expect(await counters(clientInstanceId)).toEqual([]);
    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" });
    expect(await counters(clientInstanceId)).toEqual([]);
    await governance.admitModelCall(own(clientInstanceId, person));
    await governance.admitModelCall(product(clientInstanceId, "guardrail_judge", person));
    const before = await counters(clientInstanceId);
    // Exhausted own/product safeguards and instance spend budgets do not stop ingestion.
    await governance.settleModelCall(await governance.admitModelCall(ingestion), usage);
    // Reconciliation must not mask a temporary loss of chat headroom at settlement.
    expect(await counters(clientInstanceId)).toEqual(before);
    await db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" });
    expect(await counters(clientInstanceId)).toEqual(before);
    await expect(
      refusalOf(governance.admitModelCall(product(clientInstanceId, "knowledge_query", person)))
    ).resolves.toMatchObject({ details: { scope: "user", metric: "modelCallCount" } });
    const events = await db.store.usage.listModelUsageEvents({ clientInstanceId, limit: 20 });
    const imports = events.filter((event) => event.purpose === purpose);
    expect(imports).toHaveLength(3);
    expect(imports.every((event) => event.totalTokens === usage.totalTokens)).toBe(true);
    if (withPerson) expect(imports.every((event) => event.userId === person)).toBe(true);
  });

  it.each(KNOWLEDGE_INGESTION_PURPOSES)(
    "does not require chat budget pricing for %s",
    async (purpose) => {
      const { clientInstanceId, people } = await instanceWith("ingestion_unpriced", ["anna"]);
      const governance = new ModelUsageGovernance({
        store: db.store.usage,
        budget: { dailySpendLimit: 1 },
        safeguards: { modelCallsPerDay: 1 }
      });
      await expect(
        governance.admitModelCall(product(clientInstanceId, purpose, required(people[0])))
      ).resolves.toBeDefined();
      await expect(
        governance.admitModelCall(own(clientInstanceId, required(people[0])))
      ).rejects.toMatchObject({ details: { reason: "MODEL_NOT_PRICED" } });
    }
  );
});
