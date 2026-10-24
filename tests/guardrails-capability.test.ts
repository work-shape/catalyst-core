import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "@work-shape/catalyst-capability-sdk";
import { guardrailsModule } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { defineProvider } from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { createTestConfig } from "./support/fixtures";
import { errorOf, fixture } from "./support/operation-approval";
import { createTestInstance, getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// The guardrails as the platform's built-in capability (core-extraction-guardrails.md,
// slice 2): they answer, seed and delete their hits through the capability seams, and an
// instance whose guardrails module is on with a capability that ships it and checks nothing
// does not start (section 3, rule 3).

const DAY_MS = 24 * 60 * 60 * 1000;

/** A model provider that records each request and finds every content breaks the rule. */
function judgeProvider() {
  const requests: ModelAdapterRequest[] = [];
  const reply = (request: ModelAdapterRequest): Promise<ModelCompletion> => {
    requests.push(request);
    return Promise.resolve({
      text: '{"violates":true,"reason":"Names a person."}',
      toolCalls: [],
      sources: [],
      citations: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: "not_reported",
        webSearchCallCount: 0
      }
    });
  };
  const provider = defineProvider({
    port: "models",
    type: "judge-test",
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: reply,
        async *stream(request) {
          const completion = await reply(request);
          yield { type: "completed", completion };
        }
      });
    },
    check: () => Promise.resolve({ ok: true }),
    describe: () => ({})
  });
  return {
    requests,
    capability: defineCapability({ name: "judge-test", providers: [provider], create: () => ({}) })
  };
}

/** A capability that ships the guardrails module in place of the built-in one, and no check. */
const silentGuardrails = defineCapability({
  name: "guardrails",
  modules: [guardrailsModule],
  create: () => ({})
});

describe("the guardrails capability", () => {
  it("asks a model judge through the models of its context, under guardrail_judge", async () => {
    const judge = judgeProvider();
    const t = await fixture({
      capabilities: [judge.capability],
      settings: () => [],
      release: {
        infrastructure: { models: { local: { provider: "judge-test", model: "local" } } },
        modelBindings: [{ id: "judge", providerId: "local", agentSelectable: false }],
        guardrails: {
          no_names: {
            on: "operation.before_call",
            check: { kind: "model_judge", modelBindingId: "judge", instruction: "No names." },
            outcome: "block"
          }
        }
      }
    });
    const blocked = await t.call("requester", "Ada Lovelace");
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "no_names" }
    });
    expect(t.executed).toEqual([]);

    const [request] = judge.requests;
    expect(judge.requests).toHaveLength(1);
    expect(request?.tools).toEqual([]);
    expect(request?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(request?.messages[0]?.content)).toContain("No names.");
    expect(JSON.stringify(request?.messages[1]?.content)).toContain(
      "BEGIN UNTRUSTED PROPOSED CONTENT"
    );
    const usage = await withTestSql(
      (sql) => sql<{ purpose: string }[]>`
        select purpose from model_usage_events
        where client_instance_id = ${t.clientInstanceId}`
    );
    expect(usage.map((row) => row.purpose)).toContain("guardrail_judge");
  });

  it("deletes hits past the audit retention, also while its module is off", async () => {
    for (const enabled of [true, false]) {
      const t = await fixture({
        settings: () => [],
        release: { modules: { guardrails: { enabled } } }
      });
      await t.app.stores.guardrails.recordHits({
        clientInstanceId: t.clientInstanceId,
        hits: [
          {
            guardrailName: "old",
            event: "operation.before_call",
            outcome: "block",
            message: "Old.",
            subjectKind: "operation"
          }
        ]
      });
      const auditDays = createTestConfig().retention.auditDays;
      await withTestSql(
        (sql) => sql`
          update guardrail_hits set created_at = now() - make_interval(days => ${auditDays + 1})
          where client_instance_id = ${t.clientInstanceId} and guardrail_name = 'old'`
      );
      await t.app.call("health.get");
      // The pass before ran the schedule's tick: the next one is made due now.
      await withTestSql(
        (sql) => sql`
          update platform_jobs set run_after = now()
          where kind = 'audit.prune' and status = 'queued'`
      );
      await getTestJobs(t.app, { now: () => new Date(Date.now() + 730 * DAY_MS) }).runDue();

      const hits = await t.app.stores.guardrails.listHits({
        clientInstanceId: t.clientInstanceId,
        guardrailName: "old",
        limit: 10
      });
      expect(hits, `module on: ${enabled}`).toEqual([]);
      const pruned = (
        await t.app.stores.audit.listAuditEvents({
          clientInstanceId: t.clientInstanceId,
          limit: 100
        })
      ).filter((event) => event.type === "audit.pruned");
      expect(pruned.at(-1)?.metadata, `module on: ${enabled}`).toMatchObject({
        guardrailHitsDeletedCount: 1
      });
      await t.app.close();
    }
  });

  it("refuses to start with the module on where the capability that ships it checks nothing", async () => {
    await expect(
      createTestInstance({
        config: parseClientInstanceConfig(createTestConfig()),
        env: {},
        tools: [],
        capabilities: [silentGuardrails]
      })
    ).rejects.toThrow(
      /Module 'guardrails' is on but capability 'guardrails' that ships it contributes no check/u
    );

    // Off, the same capability starts: nothing is meant to answer.
    const off = await createTestInstance({
      config: parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { guardrails: { enabled: false } }
      }),
      env: {},
      tools: [],
      capabilities: [silentGuardrails]
    });
    expect((await off.call("health.get")).statusCode).toBe(200);
    await off.close();
  });
});
