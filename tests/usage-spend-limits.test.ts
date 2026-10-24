import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asConversationId,
  asUserId,
  isAppError,
  ModelNotPricedError,
  ModelUsageLimitReachedError,
  type AdmittedModelCall,
  type ClientInstanceId,
  type ModelAttribution,
  type ModelSystemPurpose,
  type UsageBudgetConfig,
  type UsageRateCardConfig,
  type UsageSpendAmounts,
  type UsageSpendLimitLevel
} from "@work-shape/catalyst-core";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { required } from "./support/assertions";
import { usePostgresSuite } from "./support/postgres-suite";
import { ensureTestUser } from "./support/test-store";

// Spend limits at three levels (LU-2, limits spec 3.1). Three thousand characters reserve
// 1,000 input tokens and 16,000 output tokens: at 2 and 8 per million, 130,000 micros a call.
const CALL_MICROS = 130_000;
/** Room for one call and not for two. */
const ONE_CALL_MICROS = 200_000;
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

describe("spend limits at three levels", () => {
  const db = usePostgresSuite("usagespendlimits");

  const governanceOf = (budget: UsageBudgetConfig = {}) =>
    new ModelUsageGovernance({
      store: db.store.usage,
      costs: { customer: rateCard },
      budget,
      safeguards: {}
    });

  async function instanceWith(label: string, people: string[]) {
    const clientInstanceId = db.clientInstance(label);
    const ids = people.map((person) => `${clientInstanceId}_${person}`);
    for (const id of ids) await ensureTestUser(clientInstanceId, id);
    return { clientInstanceId, people: ids };
  }

  async function workspace(
    clientInstanceId: ClientInstanceId,
    creator: string,
    kind: "shared" | "personal" = "shared"
  ) {
    const created = await db.store.workspaces.createWorkspace({
      clientInstanceId,
      kind,
      name: `${kind}-${randomUUID().slice(0, 6)}`,
      creatorUserId: asUserId(creator),
      ...(kind === "personal" ? { personalUserId: asUserId(creator) } : {})
    });
    return created.id as string;
  }

  const setLimit = (
    clientInstanceId: ClientInstanceId,
    level: UsageSpendLimitLevel,
    limits: UsageSpendAmounts | null,
    targetId?: string
  ) =>
    db.store.usage.setSpendLimit({
      clientInstanceId,
      level,
      limits,
      ...(targetId === undefined ? {} : { targetId })
    });

  const call = (
    clientInstanceId: ClientInstanceId,
    attribution: ModelAttribution,
    model = "gpt-main"
  ) => ({
    clientInstanceId,
    attribution,
    providerId: "azure-eu",
    model,
    correlationId: `corr_${randomUUID()}`,
    request: { inputCharacters: 3_000 }
  });

  /** A message a person sends: a new run each time, unless `runId` continues one. */
  const message = (
    clientInstanceId: ClientInstanceId,
    userId: string,
    options: { workspaceId?: string; runId?: string; model?: string } = {}
  ) =>
    call(
      clientInstanceId,
      {
        kind: "agent_run",
        conversationId: asConversationId(`conv_${randomUUID()}`),
        runId: asAgentRunId(options.runId ?? `run_${randomUUID()}`),
        agentName: "assistant",
        userId,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId })
      },
      options.model
    );

  /** A call the product makes for a person, or for nobody without `userId`. */
  const product = (
    clientInstanceId: ClientInstanceId,
    purpose: ModelSystemPurpose,
    options: { userId?: string; workspaceId?: string } = {}
  ) =>
    call(clientInstanceId, {
      kind: "system",
      purpose,
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId })
    });

  async function refusal(attempt: Promise<AdmittedModelCall>) {
    const error: unknown = await attempt.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ModelUsageLimitReachedError);
    return isAppError(error) ? error.details : undefined;
  }

  it("stops a person at their own limit in every workspace and lets another go on", async () => {
    const { clientInstanceId, people } = await instanceWith("own", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const sales = await workspace(clientInstanceId, anna);
    const personal = await workspace(clientInstanceId, anna, "personal");
    await setLimit(clientInstanceId, "user", { monthlyMicros: ONE_CALL_MICROS }, anna);
    const governance = governanceOf();

    await governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: sales }));
    for (const workspaceId of [sales, personal, undefined]) {
      await expect(
        refusal(
          governance.admitModelCall(
            message(clientInstanceId, anna, workspaceId === undefined ? {} : { workspaceId })
          )
        )
      ).resolves.toMatchObject({ period: "month", metric: "costMicros", scope: "user" });
    }
    await expect(
      governance.admitModelCall(message(clientInstanceId, ben, { workspaceId: sales }))
    ).resolves.toBeDefined();
  });

  it("holds every person to the user default unless they have a value of their own", async () => {
    const { clientInstanceId, people } = await instanceWith("userdefault", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    await setLimit(clientInstanceId, "user_default", { dailyMicros: ONE_CALL_MICROS });
    await setLimit(clientInstanceId, "user", { dailyMicros: 10 * CALL_MICROS }, ben);
    const governance = governanceOf();

    await governance.admitModelCall(message(clientInstanceId, anna));
    await expect(
      refusal(governance.admitModelCall(message(clientInstanceId, anna)))
    ).resolves.toMatchObject({ period: "day", scope: "user" });
    for (let index = 0; index < 3; index += 1) {
      await governance.admitModelCall(message(clientInstanceId, ben));
    }
  });

  it("stops everyone in a shared workspace at its limit and nowhere else", async () => {
    const { clientInstanceId, people } = await instanceWith("workspace", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    const sales = await workspace(clientInstanceId, anna);
    const legal = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "workspace", { dailyMicros: ONE_CALL_MICROS }, sales);
    const governance = governanceOf();

    await governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: sales }));
    await expect(
      refusal(governance.admitModelCall(message(clientInstanceId, ben, { workspaceId: sales })))
    ).resolves.toMatchObject({ period: "day", metric: "costMicros", scope: "workspace" });
    await expect(
      governance.admitModelCall(message(clientInstanceId, ben, { workspaceId: legal }))
    ).resolves.toBeDefined();
    await expect(governance.admitModelCall(message(clientInstanceId, ben))).resolves.toBeDefined();
  });

  it("gives a Personal Workspace no workspace limit", async () => {
    const { clientInstanceId, people } = await instanceWith("personal", ["anna"]);
    const anna = required(people[0]);
    const personal = await workspace(clientInstanceId, anna, "personal");
    await setLimit(clientInstanceId, "workspace_default", { dailyMicros: ONE_CALL_MICROS });
    const governance = governanceOf();

    for (let index = 0; index < 3; index += 1) {
      await governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: personal }));
    }
  });

  it("stops everyone at the instance limit an admin set below the release config", async () => {
    const { clientInstanceId, people } = await instanceWith("instance", ["anna", "ben"]);
    const [anna, ben] = [required(people[0]), required(people[1])];
    await setLimit(clientInstanceId, "instance", { dailyMicros: ONE_CALL_MICROS });
    const governance = governanceOf({ dailySpendLimit: 100 });

    await governance.admitModelCall(message(clientInstanceId, anna));
    await expect(
      refusal(governance.admitModelCall(message(clientInstanceId, ben)))
    ).resolves.toMatchObject({ period: "day", scope: "instance" });
  });

  it("keeps the release config as the ceiling over a higher stored instance limit", async () => {
    const { clientInstanceId, people } = await instanceWith("ceiling", ["anna"]);
    const anna = required(people[0]);
    // Written past the operation, which refuses it: the ceiling still holds.
    await setLimit(clientInstanceId, "instance", { dailyMicros: 100_000_000 });
    const governance = governanceOf({ dailySpendLimit: ONE_CALL_MICROS / 1_000_000 });

    expect(governance.instanceSpendLimits({ dailyMicros: 100_000_000 })).toEqual({
      dailyMicros: ONE_CALL_MICROS
    });
    await governance.admitModelCall(message(clientInstanceId, anna));
    await expect(
      refusal(governance.admitModelCall(message(clientInstanceId, anna)))
    ).resolves.toMatchObject({ scope: "instance" });
  });

  it("lets an answer finish past a user or workspace limit, not past the instance's", async () => {
    const { clientInstanceId, people } = await instanceWith("continue", ["anna"]);
    const anna = required(people[0]);
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "user", { dailyMicros: ONE_CALL_MICROS }, anna);
    await setLimit(clientInstanceId, "workspace", { dailyMicros: ONE_CALL_MICROS }, sales);
    const governance = governanceOf({ dailySpendLimit: (4 * CALL_MICROS) / 1_000_000 });
    const runId = `run_${randomUUID()}`;

    for (let step = 0; step < 4; step += 1) {
      await governance.admitModelCall(
        message(clientInstanceId, anna, { workspaceId: sales, runId })
      );
    }
    // The instance limit stops the same run.
    await expect(
      refusal(
        governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: sales, runId }))
      )
    ).resolves.toMatchObject({ scope: "instance" });
  });

  it("blocks the next message once a run has crossed the user limit", async () => {
    const { clientInstanceId, people } = await instanceWith("next", ["anna"]);
    const anna = required(people[0]);
    await setLimit(clientInstanceId, "user", { dailyMicros: ONE_CALL_MICROS }, anna);
    const governance = governanceOf();
    const runId = `run_${randomUUID()}`;

    await governance.admitModelCall(message(clientInstanceId, anna, { runId }));
    await governance.admitModelCall(message(clientInstanceId, anna, { runId }));
    await expect(
      refusal(governance.admitModelCall(message(clientInstanceId, anna)))
    ).resolves.toMatchObject({ scope: "user" });
  });

  it("keeps titles and guardrail checks off the person's limit and on the workspace's", async () => {
    const { clientInstanceId, people } = await instanceWith("system", ["anna"]);
    const anna = required(people[0]);
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "user", { dailyMicros: ONE_CALL_MICROS }, anna);
    await setLimit(clientInstanceId, "workspace", { dailyMicros: 3 * CALL_MICROS }, sales);
    const governance = governanceOf();

    for (const purpose of ["conversation_title", "guardrail_judge"] as const) {
      await governance.admitModelCall(
        product(clientInstanceId, purpose, { userId: anna, workspaceId: sales })
      );
    }
    // The person's own limit is untouched: the message goes through.
    await governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: sales }));
    // Three calls fill the workspace: a fourth from the product is refused there.
    await expect(
      refusal(
        governance.admitModelCall(
          product(clientInstanceId, "conversation_title", { userId: anna, workspaceId: sales })
        )
      )
    ).resolves.toMatchObject({ scope: "workspace" });
  });

  it("counts a scheduled workflow's calls against the workspace and the instance only", async () => {
    const { clientInstanceId, people } = await instanceWith("schedule", ["anna"]);
    const anna = required(people[0]);
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "user_default", { dailyMicros: 1 });
    await setLimit(clientInstanceId, "workspace", { dailyMicros: ONE_CALL_MICROS }, sales);
    const governance = governanceOf();

    await governance.admitModelCall(
      product(clientInstanceId, "workflow_step", { workspaceId: sales })
    );
    await expect(
      refusal(
        governance.admitModelCall(
          product(clientInstanceId, "workflow_step", { workspaceId: sales })
        )
      )
    ).resolves.toMatchObject({ scope: "workspace" });
    const counters = await db.store.usage.readSpendCounters({ clientInstanceId, all: true });
    expect(counters.filter((counter) => counter.scopeKind === "user")).toEqual([]);
    expect(counters).toEqual(
      expect.arrayContaining([
        { scopeKind: "workspace", scopeId: sales, period: "day", costMicros: CALL_MICROS },
        { scopeKind: "instance", scopeId: "", period: "day", costMicros: CALL_MICROS }
      ])
    );
  });

  it("holds Knowledge Base ingestion to no limit", async () => {
    const { clientInstanceId, people } = await instanceWith("ingestion", ["anna"]);
    const anna = required(people[0]);
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "instance", { dailyMicros: 1 });
    await setLimit(clientInstanceId, "workspace", { dailyMicros: 1 }, sales);
    await setLimit(clientInstanceId, "user", { dailyMicros: 1 }, anna);
    const governance = governanceOf();

    for (let index = 0; index < 3; index += 1) {
      await governance.admitModelCall(
        product(clientInstanceId, "knowledge_embedding", { userId: anna, workspaceId: sales })
      );
    }
  });

  it("admits no more concurrent calls than a user or workspace limit has room for", async () => {
    const { clientInstanceId, people } = await instanceWith("race", ["anna", "ben", "cara"]);
    const [anna, ben, cara] = [required(people[0]), required(people[1]), required(people[2])];
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "user", { dailyMicros: 3 * CALL_MICROS + 1 }, anna);
    await setLimit(clientInstanceId, "workspace", { dailyMicros: 5 * CALL_MICROS + 1 }, sales);
    const governance = governanceOf();
    const own = await Promise.allSettled(
      Array.from({ length: 20 }, () => governance.admitModelCall(message(clientInstanceId, anna)))
    );
    expect(own.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const shared = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        governance.admitModelCall(
          message(clientInstanceId, i % 2 ? ben : cara, { workspaceId: sales })
        )
      )
    );
    expect(shared.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });

  // ADR-0014: a model without a price makes the cost of the period unknown.
  it.each(["user", "workspace", "instance"] as const)(
    "refuses an unpriced model under a %s limit",
    async (level) => {
      const { clientInstanceId, people } = await instanceWith(`unpriced${level}`, ["anna"]);
      const anna = required(people[0]);
      const sales = await workspace(clientInstanceId, anna);
      const target = { user: anna, workspace: sales, instance: undefined }[level];
      const amounts: UsageSpendAmounts = { monthlyMicros: 10 * CALL_MICROS };
      const governance = governanceOf();
      const unpriced = () =>
        governance.admitModelCall(
          message(clientInstanceId, anna, { workspaceId: sales, model: "gpt-unpriced" })
        );

      await expect(unpriced()).resolves.toBeDefined();
      await setLimit(clientInstanceId, level, amounts, target);
      await expect(unpriced()).rejects.toBeInstanceOf(ModelNotPricedError);
    }
  );

  it("admits the next call as soon as an admin raises the limit", async () => {
    const { clientInstanceId, people } = await instanceWith("raise", ["anna"]);
    const anna = required(people[0]);
    await setLimit(clientInstanceId, "user", { dailyMicros: ONE_CALL_MICROS }, anna);
    const governance = governanceOf();

    await governance.admitModelCall(message(clientInstanceId, anna));
    await refusal(governance.admitModelCall(message(clientInstanceId, anna)));
    await expect(
      setLimit(clientInstanceId, "user", { dailyMicros: 3 * CALL_MICROS }, anna)
    ).resolves.toEqual({ previous: { dailyMicros: ONE_CALL_MICROS } });
    await expect(governance.admitModelCall(message(clientInstanceId, anna))).resolves.toBeDefined();
  });

  it("measures what is left and reached against the limit as admission holds it", async () => {
    const { clientInstanceId, people } = await instanceWith("margin", ["anna"]);
    const anna = required(people[0]);
    // A safety multiplier of 2 holds a limit of two calls and a half at one call and a quarter.
    await setLimit(clientInstanceId, "user", { dailyMicros: 2.5 * CALL_MICROS }, anna);
    const governance = governanceOf({ costSafetyMultiplier: 2 });

    await governance.admitModelCall(message(clientInstanceId, anna));
    const { own } = await governance.spendStatus({ clientInstanceId, userId: anna });
    expect(own.day).toEqual({
      spentMicros: CALL_MICROS,
      limitMicros: 2.5 * CALL_MICROS,
      leftMicros: 1.25 * CALL_MICROS - CALL_MICROS,
      reached: false
    });
    await refusal(governance.admitModelCall(message(clientInstanceId, anna)));
  });

  it("tells a person where they stand against each level", async () => {
    const { clientInstanceId, people } = await instanceWith("status", ["anna"]);
    const anna = required(people[0]);
    const sales = await workspace(clientInstanceId, anna);
    await setLimit(clientInstanceId, "user", { dailyMicros: ONE_CALL_MICROS }, anna);
    await setLimit(clientInstanceId, "workspace_default", { monthlyMicros: 10 * CALL_MICROS });
    const governance = governanceOf({ monthlySpendLimit: 1 });

    await governance.admitModelCall(message(clientInstanceId, anna, { workspaceId: sales }));
    await expect(
      governance.spendStatus({ clientInstanceId, userId: anna, workspaceId: sales })
    ).resolves.toEqual({
      currency: "EUR",
      own: {
        day: {
          spentMicros: CALL_MICROS,
          limitMicros: ONE_CALL_MICROS,
          leftMicros: ONE_CALL_MICROS - CALL_MICROS,
          reached: false
        },
        month: { spentMicros: CALL_MICROS }
      },
      workspace: {
        id: sales,
        day: { spentMicros: CALL_MICROS },
        month: {
          spentMicros: CALL_MICROS,
          limitMicros: 10 * CALL_MICROS,
          leftMicros: 9 * CALL_MICROS,
          reached: false
        }
      },
      instance: {
        day: { spentMicros: CALL_MICROS },
        month: {
          spentMicros: CALL_MICROS,
          limitMicros: 1_000_000,
          leftMicros: 1_000_000 - CALL_MICROS,
          reached: false
        }
      }
    });
  });
});
