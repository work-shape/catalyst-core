import { describe, expect, it } from "vitest";
import {
  ModelUsageLimitReachedError,
  type AdmittedModelCall,
  type ClientInstanceId,
  type ModelCallAdmission,
  type UsageRateCardConfig
} from "@vivd-catalyst/core";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { required } from "./support/assertions";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";

const CONCURRENT_CALLS = 200;
const ROOM = 7;
// Three thousand characters are reserved as 1,000 input tokens, and a request without a
// maximum as 16,000 output tokens.
const REQUEST_CHARACTERS = 3_000;
const RESERVED_TOKENS = 17_000;
// The cached input is cheaper than the uncached: a cost without the cached tokens is not whole.
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
// 1,000 input tokens at 2 and 16,000 output tokens at 8 per million, in millionths.
const RESERVED_COST_MICROS = 130_000;

type Limits = Pick<ConstructorParameters<typeof ModelUsageGovernance>[0], "budget" | "safeguards">;

function call(clientInstanceId: ClientInstanceId, index: number): ModelCallAdmission {
  return {
    clientInstanceId,
    attribution: { kind: "system", purpose: "document_extraction" },
    providerId: "azure-eu",
    model: "gpt-main",
    correlationId: `corr_race_${index}`,
    request: { inputCharacters: REQUEST_CHARACTERS }
  };
}

describe("usage admission under concurrent calls", () => {
  const db = usePostgresSuite("usageadmission");

  async function counters(clientInstanceId: ClientInstanceId) {
    const rows = await db.sql<
      { period_kind: string; calls: number; tokens: number; cost: number }[]
    >`
      select period_kind, model_call_count::float8 as calls, tokens::float8 as tokens,
        cost_micros::float8 as cost
      from model_usage_counters where client_instance_id = ${clientInstanceId}
      order by period_kind`;
    return rows.map((row) => ({ ...row }));
  }

  /** Two hundred calls at once from three processes of the instance, each with its own pool. */
  async function race(clientInstanceId: ClientInstanceId, limits: Limits) {
    const third = await createTestInstance({
      postgres: { applicationName: `${db.first}_third` }
    });
    try {
      const processes = [db.store, db.secondStore, third.stores].map(
        (store) =>
          new ModelUsageGovernance({ store: store.usage, costs: { customer: rateCard }, ...limits })
      );
      return await Promise.allSettled(
        Array.from({ length: CONCURRENT_CALLS }, (_unused, index) =>
          required(processes[index % processes.length]).admitModelCall(
            call(clientInstanceId, index)
          )
        )
      );
    } finally {
      await third.close();
    }
  }

  function expectExactlyTheRoom(
    results: PromiseSettledResult<AdmittedModelCall>[],
    message: string
  ): void {
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(ROOM);
    expect(refused).toHaveLength(CONCURRENT_CALLS - ROOM);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(ModelUsageLimitReachedError);
      expect(reason).toMatchObject({ message });
    }
  }

  // Fails without the change: each process counted its own calls.
  it("admits exactly seven of two hundred calls against a daily call limit with room for seven", async () => {
    const clientInstanceId = db.clientInstance("calls");

    const results = await race(clientInstanceId, {
      budget: {},
      safeguards: { modelCallsPerDay: ROOM }
    });

    expectExactlyTheRoom(results, "Daily model call safeguard has been reached");
    await expect(db.store.usage.listModelUsageEvents({ clientInstanceId })).resolves.toHaveLength(
      ROOM
    );
  });

  // Fails without the change: a call in flight held no tokens, so every call was admitted
  // until the first one ended.
  it("admits exactly the calls whose reserved tokens fit a daily token limit", async () => {
    const clientInstanceId = db.clientInstance("tokens");

    const results = await race(clientInstanceId, {
      budget: {},
      safeguards: { tokensPerDay: ROOM * RESERVED_TOKENS + RESERVED_TOKENS - 1 }
    });

    expectExactlyTheRoom(results, "Daily model token safeguard has been reached");
    expect(await counters(clientInstanceId)).toEqual([
      {
        period_kind: "day",
        calls: ROOM,
        tokens: ROOM * RESERVED_TOKENS,
        cost: ROOM * RESERVED_COST_MICROS
      },
      {
        period_kind: "month",
        calls: ROOM,
        tokens: ROOM * RESERVED_TOKENS,
        cost: ROOM * RESERVED_COST_MICROS
      }
    ]);
  });

  // Fails without the change: the second call in flight was refused because the cost of the
  // first was not whole, and nothing held the cost of calls in flight against the budget.
  it("admits exactly the calls whose reserved cost fits a monthly spend budget", async () => {
    const clientInstanceId = db.clientInstance("cost");

    const results = await race(clientInstanceId, {
      budget: { monthlySpendLimit: (ROOM * RESERVED_COST_MICROS + 1) / 1_000_000 },
      safeguards: {}
    });

    expectExactlyTheRoom(results, "Monthly model spend budget has been reached");
  });

  // Fails without the change: a call that failed stayed a row without a whole cost, and every
  // later call was refused for the rest of the month.
  it("lets the next call in after a call that failed", async () => {
    const clientInstanceId = db.clientInstance("failed");
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      costs: { customer: rateCard },
      // Room for one call in flight.
      budget: { monthlySpendLimit: RESERVED_COST_MICROS / 1_000_000 },
      safeguards: { tokensPerDay: RESERVED_TOKENS }
    });

    const first = await governance.admitModelCall(call(clientInstanceId, 1));
    await expect(governance.admitModelCall(call(clientInstanceId, 2))).rejects.toBeInstanceOf(
      ModelUsageLimitReachedError
    );
    await governance.settleModelCall(first);

    await expect(governance.admitModelCall(call(clientInstanceId, 3))).resolves.toBeDefined();
    const events = await db.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events.map((event) => event.status).sort()).toEqual(["failed", "pending"]);
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      totalTokens: 0,
      source: "not_reported",
      customerBillableCost: { status: "settled", totalCostMicros: 0 }
    });
  });

  // Fails without the change: a call whose process went away held its place for good.
  it("releases what a call reserved that never ended", async () => {
    const clientInstanceId = db.clientInstance("abandoned");
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      costs: { customer: rateCard },
      budget: {},
      safeguards: { tokensPerDay: RESERVED_TOKENS },
      abandonedAfterMs: 0
    });
    const lost = await governance.admitModelCall(call(clientInstanceId, 1));
    await expect(governance.admitModelCall(call(clientInstanceId, 2))).rejects.toBeInstanceOf(
      ModelUsageLimitReachedError
    );

    await expect(governance.releaseAbandonedModelCalls({ clientInstanceId })).resolves.toBe(1);

    expect(await counters(clientInstanceId)).toEqual([
      { period_kind: "day", calls: 1, tokens: 0, cost: 0 },
      { period_kind: "month", calls: 1, tokens: 0, cost: 0 }
    ]);
    const [event] = await db.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(event).toMatchObject({ id: lost.id, status: "abandoned", totalTokens: 0 });
    // A second look releases nothing again.
    await expect(governance.releaseAbandonedModelCalls({ clientInstanceId })).resolves.toBe(0);
    await expect(governance.admitModelCall(call(clientInstanceId, 3))).resolves.toBeDefined();
  });

  // Fails without the change: there were no counters and no sums to compare.
  it("keeps the counters and the sums equal to the events through a mixed run", async () => {
    const clientInstanceId = db.clientInstance("mixed");
    const governances = [db.store, db.secondStore].map(
      (store) =>
        new ModelUsageGovernance({
          store: store.usage,
          costs: { customer: rateCard },
          budget: {},
          safeguards: {},
          abandonedAfterMs: 0
        })
    );
    const governance = required(governances[0]);

    await Promise.all(
      Array.from({ length: 60 }, async (_unused, index) => {
        const process = required(governances[index % governances.length]);
        if (index % 6 === 5) {
          await process.recordModelUsage({
            ...call(clientInstanceId, index),
            inputTokens: 300,
            cachedInputTokens: 100,
            outputTokens: 50,
            totalTokens: 350,
            source: "provider_reported"
          });
          return;
        }
        const admitted = await process.admitModelCall(call(clientInstanceId, index));
        // A third of the calls end with usage, some fail, some report no cached tokens, and
        // the rest stay in flight.
        if (index % 6 === 0 || index % 6 === 1) {
          await process.settleModelCall(admitted, {
            inputTokens: 1_000 + index,
            cachedInputTokens: 200,
            outputTokens: 400,
            totalTokens: 1_400 + index,
            source: "provider_reported"
          });
        } else if (index % 6 === 2) {
          await process.settleModelCall(admitted);
        } else if (index % 6 === 3) {
          await process.settleModelCall(admitted, {
            inputTokens: 500,
            outputTokens: 20,
            totalTokens: 520,
            source: "provider_reported"
          });
        }
      })
    );
    // Half of the calls in flight are taken as abandoned, and one of those ends after all.
    const pending = await db.store.usage.listModelUsageEvents({ clientInstanceId });
    const inFlight = pending.filter((event) => event.status === "pending");
    expect(inFlight).toHaveLength(10);
    await governance.releaseAbandonedModelCalls({ clientInstanceId });
    const late = required(inFlight[0]);
    await governance.settleModelCall(
      { ...late, reserved: { tokens: 0, costMicros: 0 } },
      {
        inputTokens: 90,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 100,
        source: "provider_reported"
      }
    );
    const running = await governance.admitModelCall(call(clientInstanceId, 99));

    const [ledger] = await db.sql<
      { calls: number; tokens: number; cost: number; ended: number; ended_tokens: number }[]
    >`
      select count(*)::float8 as calls, sum(counted_tokens)::float8 as tokens,
        sum(counted_cost_micros)::float8 as cost,
        (count(*) filter (where status <> 'pending'))::float8 as ended,
        (sum(total_tokens) filter (where status <> 'pending'))::float8 as ended_tokens
      from model_usage_events where client_instance_id = ${clientInstanceId}`;
    const held = required(ledger);
    expect(held.calls).toBe(61);
    expect(await counters(clientInstanceId)).toEqual([
      { period_kind: "day", calls: held.calls, tokens: held.tokens, cost: held.cost },
      { period_kind: "month", calls: held.calls, tokens: held.tokens, cost: held.cost }
    ]);
    // The call in flight holds its reservation, and it is in no sum.
    expect(held.tokens).toBeGreaterThanOrEqual(RESERVED_TOKENS);
    const history = await db.store.usage.summarizeModelUsageHistory({ clientInstanceId });
    expect(history.allTime).toMatchObject({
      modelCallCount: held.ended,
      totalTokens: held.ended_tokens
    });
    expect(history.allTime.modelCallCount).toBe(60);
    // Ten calls reported no cached tokens: their cost is not whole, and the sums say so.
    expect(history.allTime.settledModelCallCount).toBe(50);
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "all" })
    ).resolves.toEqual({ correctedCounters: 0, correctedSums: 0 });
    await governance.settleModelCall(running);
  });

  // Fails without the change: nothing compared the counters with the events.
  it("corrects the counters and the sums by what a process of the previous release wrote", async () => {
    const clientInstanceId = db.clientInstance("drift");
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      costs: { customer: rateCard },
      budget: {},
      safeguards: {}
    });
    const admitted = await governance.admitModelCall(call(clientInstanceId, 1));
    await governance.settleModelCall(admitted, {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 110,
      source: "provider_reported"
    });
    // The previous release writes an event and knows no counter, no status and no sum.
    await db.sql`
      insert into model_usage_events (
        id, client_instance_id, agent_name, provider_id, model, input_tokens, output_tokens,
        total_tokens, source, customer_billable_cost, correlation_id, created_at
      ) values (
        ${`usage_old_${clientInstanceId}`}, ${clientInstanceId}, 'conversation_title', 'azure-eu',
        'gpt-main', 40, 2, 42, 'provider_reported',
        '{"status":"settled","currency":"EUR","totalCostMicros":96,"components":{"uncachedInputCostMicros":80,"cachedInputCostMicros":0,"outputCostMicros":16,"webSearchCostMicros":0}}'::jsonb,
        'corr_old', now()
      )`;

    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toEqual({ correctedCounters: 2, correctedSums: 1 });

    expect(await counters(clientInstanceId)).toEqual([
      { period_kind: "day", calls: 2, tokens: 152, cost: 280 + 96 },
      { period_kind: "month", calls: 2, tokens: 152, cost: 280 + 96 }
    ]);
    const history = await db.store.usage.summarizeModelUsageHistory({ clientInstanceId });
    expect(history.allTime).toMatchObject({ modelCallCount: 2, totalTokens: 152 });
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toEqual({ correctedCounters: 0, correctedSums: 0 });
  });
});
