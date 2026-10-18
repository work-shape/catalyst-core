import { describe, expect, it } from "vitest";
import type { ModelCallAdmission, PlatformStores } from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { orderedStoreCalls } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { ensureTestUser } from "./support/test-store";

// Reconciliation must subtract the drift it observed, preserving an admission committed while
// it waited for the counters. Both processes use real pools and a lock proves the overlap.
describe("usage reconciliation during admission", () => {
  const db = usePostgresSuite("usagecounteroverlap");

  it("preserves an admission committed after its comparison snapshot in every scope", async () => {
    const clientInstanceId = db.clientInstance("admission");
    const userId = `${clientInstanceId}_person`;
    await ensureTestUser(clientInstanceId, userId);
    const call: ModelCallAdmission = {
      clientInstanceId,
      attribution: { kind: "system", purpose: "knowledge_query", userId },
      providerId: "local",
      model: "test",
      correlationId: "reconciliation-overlap",
      request: { inputCharacters: 3_000 }
    };
    const governance = (stores: PlatformStores) =>
      new ModelUsageGovernance({ store: stores.usage, budget: {}, safeguards: {} });
    const first = governance(db.store);
    await first.settleModelCall(await first.admitModelCall(call));
    // A previous process left drift in each counter. Reconciliation sees this while the next
    // admission and its event are still uncommitted.
    await db.sql`
      update model_usage_counters set model_call_count = model_call_count + 7,
        tokens = tokens + 19
      where client_instance_id = ${clientInstanceId}`;

    const outcomes = await orderedStoreCalls(
      db.sql,
      { first: db.store, firstName: db.first, secondName: db.second },
      (stores) => governance(stores).admitModelCall(call),
      () => db.secondStore.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    );
    for (const outcome of outcomes) expect(outcome.status).toBe("fulfilled");
    const counters = await db.sql<
      { kind: string; period: string; calls: number; tokens: number }[]
    >`
      select scope_kind as kind, period_kind as period, model_call_count::int as calls,
        tokens::int as tokens
      from model_usage_counters where client_instance_id = ${clientInstanceId}
      order by scope_kind, period_kind`;
    expect(counters).toEqual([
      { kind: "instance", period: "day", calls: 2, tokens: 17_000 },
      { kind: "instance", period: "month", calls: 2, tokens: 17_000 },
      { kind: "user", period: "day", calls: 2, tokens: 17_000 },
      { kind: "user", period: "month", calls: 2, tokens: 17_000 }
    ]);
    await expect(
      db.store.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
    ).resolves.toEqual({ correctedCounters: 0, correctedSums: 0 });
  });
});
