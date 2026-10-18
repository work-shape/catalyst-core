import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { asAgentRunId, asConversationId, type ModelCallAdmission } from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { usePostgresSuite } from "./support/postgres-suite";
import { ensureTestUser } from "./support/test-store";

const TOKENS_PER_MINUTE = 2_000_000;
// ACCEPT-1c measured 2.5M tokens in 35 minutes. An eight-hour day is about 34.3M.
const BUSY_DAY_TOKENS = Math.ceil((2_500_000 * 480) / 35);

describe("runaway loops under shipped safeguards", () => {
  const db = usePostgresSuite("usagerunaway");
  it.each([
    ["own", 1],
    ["product", 1],
    ["unattended", 7]
  ] as const)(
    "stops a sequential %s loop, including an unattended UTC rollover",
    async (scope, factor) => {
      const safeguards = parseClientInstanceConfig({
        clientInstance: { id: "runaway", displayName: "Runaway" },
        infrastructure: { models: { local: { provider: "deterministic" } } }
      }).usage.safeguards;
      const clientInstanceId = db.clientInstance(scope);
      const person = `${clientInstanceId}_anna`;
      await ensureTestUser(clientInstanceId, person);
      const governance = new ModelUsageGovernance({
        store: db.store.usage,
        budget: {},
        safeguards
      });
      const call: ModelCallAdmission = {
        clientInstanceId,
        providerId: "local",
        model: "local",
        correlationId: "runaway",
        request: { inputCharacters: 3_000 },
        attribution:
          scope === "own"
            ? {
                kind: "agent_run",
                userId: person,
                agentName: "assistant",
                conversationId: asConversationId("conv_runaway"),
                runId: asAgentRunId("run_runaway")
              }
            : {
                kind: "system",
                purpose: "guardrail_judge",
                ...(scope === "product" ? { userId: person } : {})
              }
      };
      const consumed = 200_000_000 * factor;
      const usage = {
        inputTokens: consumed,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: consumed,
        source: "provider_reported" as const
      };
      let beforeReset = 0;
      if (scope === "unattended") {
        // Start just below the previous day's limit. Only this fixture's rows move to yesterday;
        // admission must start fresh daily counters while preserving monthly consumption.
        beforeReset = consumed - TOKENS_PER_MINUTE;
        await governance.recordModelUsage({
          ...call,
          ...usage,
          inputTokens: beforeReset,
          totalTokens: beforeReset
        });
        await db.sql`update model_usage_events set created_at = created_at - interval '1 day'
          where client_instance_id = ${clientInstanceId}`;
        await db.sql`update model_usage_counters set period_start = period_start - 1
          where client_instance_id = ${clientInstanceId} and period_kind = 'day'`;
      }
      await governance.settleModelCall(await governance.admitModelCall(call), usage);
      await expect(governance.admitModelCall(call)).rejects.toMatchObject({
        details: { scope: scope === "own" ? "user" : "system", period: "day", metric: "tokens" }
      });
      expect((beforeReset + consumed) / TOKENS_PER_MINUTE).toBeLessThan(24 * 60);
      if (scope === "unattended") {
        expect((2 * consumed) / TOKENS_PER_MINUTE).toBe(1_400);
        expect((2 * consumed) / TOKENS_PER_MINUTE).toBeLessThan(24 * 60);
        // Ten workflows, each twice a busy measured day, fit daily and for 22 working days.
        expect(10 * 2 * BUSY_DAY_TOKENS).toBeLessThan(consumed);
        expect(10 * 2 * Math.ceil((91 * 480) / 35)).toBeLessThan(20_000 * factor);
        expect(10 * 2 * BUSY_DAY_TOKENS * 22).toBeLessThan(4_000_000_000 * factor);
      }
    }
  );
});
