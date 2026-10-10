import { describe, expect, it } from "vitest";
import { ModelUsageLimitReachedError, type ClientInstanceId } from "@vivd-catalyst/core";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { usePostgresSuite } from "./support/postgres-suite";

const CONCURRENT_CALLS = 20;
const ROOM = 5;

describe("usage admission under concurrent calls", () => {
  const db = usePostgresSuite("usageadmission");

  function admissions(
    clientInstanceId: ClientInstanceId,
    limits: ConstructorParameters<typeof ModelUsageGovernance>[0]["safeguards"]
  ) {
    // Two processes of the instance: each has its own pool and its own governance.
    const processes = [db.store, db.secondStore].map(
      (store) => new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: limits })
    );
    return Promise.allSettled(
      Array.from({ length: CONCURRENT_CALLS }, (_unused, index) => {
        const governance = processes[index % processes.length];
        if (!governance) throw new Error("No governance for the call");
        return governance.admitModelCall({
          clientInstanceId,
          attribution: { kind: "system", purpose: "document_extraction" },
          providerId: "azure-eu",
          model: "gpt-main",
          correlationId: `corr_race_${index}`
        });
      })
    );
  }

  // Fails without the change: each process counted its own calls, so two processes admitted
  // ten, and a call left no row until it ended.
  it("admits exactly five of twenty calls against a daily call limit with room for five", async () => {
    const clientInstanceId = db.clientInstance("calls");

    const results = await admissions(clientInstanceId, { modelCallsPerDay: ROOM });

    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(ROOM);
    expect(refused).toHaveLength(CONCURRENT_CALLS - ROOM);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(ModelUsageLimitReachedError);
      expect(reason).toMatchObject({ message: "Daily model call safeguard has been reached" });
    }
    await expect(db.store.usage.listModelUsageEvents({ clientInstanceId })).resolves.toHaveLength(
      ROOM
    );
  });
});
