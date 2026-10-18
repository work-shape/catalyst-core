import { describe, expect, it } from "vitest";
import type { ModelCallAdmission } from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { settled, waitUntilBlocked } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";
import { ensureTestUser } from "./support/test-store";

// Admission and settlement lock the instance's counters before a person's. Reconciliation must
// too: holding a person's counter while it waits for the instance's would deadlock against an
// admission that holds the instance's and waits for the person's.
describe("usage reconciliation lock order", () => {
  const db = usePostgresSuite("usagecounterlockorder");

  it("waits for the instance's counters before it locks a person's", async () => {
    const clientInstanceId = db.clientInstance("lockorder");
    const userId = `${clientInstanceId}_person`;
    await ensureTestUser(clientInstanceId, userId);
    const call: ModelCallAdmission = {
      clientInstanceId,
      attribution: { kind: "system", purpose: "knowledge_query", userId },
      providerId: "local",
      model: "test",
      correlationId: "reconciliation-lock-order",
      request: { inputCharacters: 3_000 }
    };
    const governance = new ModelUsageGovernance({
      store: db.store.usage,
      budget: {},
      safeguards: {}
    });
    await governance.settleModelCall(await governance.admitModelCall(call));
    // Drift on every counter, the instance's written last, so its rows come after the person's
    // in the table and a scan in table order meets the person's first.
    await db.sql`
      update model_usage_counters set model_call_count = model_call_count + 3
      where client_instance_id = ${clientInstanceId} and scope_kind = 'user'`;
    await db.sql`
      update model_usage_counters set model_call_count = model_call_count + 5
      where client_instance_id = ${clientInstanceId} and scope_kind = 'instance'`;

    // Reconciliation runs on connections, opened after this, on which the planner may not walk
    // an index or merge, so it visits the counters in table order: the order of its locks must
    // not come from its plan. The database is this file's alone.
    const [{ name } = { name: "" }] = await db.sql<{ name: string }[]>`
      select current_database() as name`;
    await db.sql`
      alter database ${db.sql(name)} set enable_indexscan = off`;
    await db.sql`alter database ${db.sql(name)} set enable_bitmapscan = off`;
    await db.sql`alter database ${db.sql(name)} set enable_mergejoin = off`;

    const tableOrder = `${db.first}_tableorder`;
    const reconciling = await createTestInstance({ postgres: { applicationName: tableOrder } });
    try {
      // An admission's first lock: the instance's day counter.
      const admission = await db.hold(
        (tx) => tx`
          select 1 from model_usage_counters
          where client_instance_id = ${clientInstanceId} and scope_kind = 'instance'
            and period_kind = 'day'
          for update`
      );
      const reconciliation = settled(
        reconciling.stores.usage.reconcileModelUsage({ clientInstanceId, scope: "recent" })
      );
      await waitUntilBlocked(db.sql, { waiter: tableOrder, holder: db.barrier });

      // The admission's next lock, the person's counters, is free: reconciliation holds none.
      const personFree = await settled(
        db.sql.begin(
          (tx) => tx`
            select 1 from model_usage_counters
            where client_instance_id = ${clientInstanceId} and scope_kind = 'user'
            for update nowait`
        )
      );
      await admission.commit();
      expect(personFree.status).toBe("fulfilled");
      expect((await reconciliation).status).toBe("fulfilled");
    } finally {
      await reconciling.close();
    }

    const counters = await db.sql<{ kind: string; calls: number }[]>`
      select scope_kind as kind, model_call_count::int as calls
      from model_usage_counters where client_instance_id = ${clientInstanceId}
      order by scope_kind, period_kind`;
    expect(counters).toEqual([
      { kind: "instance", calls: 1 },
      { kind: "instance", calls: 1 },
      { kind: "user", calls: 1 },
      { kind: "user", calls: 1 }
    ]);
  });
});
