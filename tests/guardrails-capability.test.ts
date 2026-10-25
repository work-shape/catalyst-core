import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCapability } from "@work-shape/catalyst-capability-sdk";
import {
  createInstanceInfrastructure,
  createWorkerCapabilityModels,
  guardrailsModule
} from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  asAgentRunId,
  asToolCallId,
  asUserId,
  createUserPrincipal,
  defineProvider,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { createTestConfig } from "./support/fixtures";
import { silentTestLogger } from "./support/model-gateway";
import { errorOf, fixture } from "./support/operation-approval";
import {
  createTestInstance,
  getTestConfig,
  getTestExecution,
  getTestJobs
} from "./support/test-instance";
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

/**
 * A capability that ships the guardrails module in place of the built-in one with a check that
 * allows everything, and brings no kind.
 */
const kindlessGuardrails = defineCapability({
  name: "guardrails",
  modules: [guardrailsModule],
  create: () => ({
    beforeActionCheck: { answer: () => Promise.resolve([]), preview: () => Promise.resolve([]) }
  })
});

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

  it("refuses a judge on a route outside the personal regions in a conversation with personal data", async () => {
    const judge = judgeProvider();
    const t = await fixture({
      capabilities: [judge.capability],
      settings: () => [],
      release: {
        modules: { connections: { enabled: true } },
        infrastructure: {
          models: {
            local: { provider: "judge-test", model: "local", region: "eu" },
            abroad: { provider: "judge-test", model: "abroad", region: "us" }
          }
        },
        modelBindings: [{ id: "judge", providerId: "abroad", agentSelectable: false }],
        guardrails: {
          no_names: {
            on: "operation.before_call",
            check: { kind: "model_judge", modelBindingId: "judge", instruction: "No names." },
            outcome: "block"
          }
        }
      }
    });
    // Agent calls run in a worker process of the instance, on the same rows.
    const worker = await createTestInstance({
      execution: {
        config: getTestConfig(t.app),
        env: {},
        tools: [],
        capabilities: [judge.capability]
      }
    });
    const OPERATION = "test.notes.read";
    const execute = vi.fn(async () => ({ read: true }));
    const definition = {
      name: OPERATION,
      effect: "reading" as const,
      defaultPolicy: "allow" as const,
      action: null,
      authorize: async () => ({ allowed: true as const }),
      scope: null,
      auth: "principal" as const,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => undefined,
      timeoutMs: 1000,
      execute
    };
    getTestExecution(worker).operationCalls.registry.addSource({
      resolve: async (name) => (name === OPERATION ? definition : undefined),
      list: async () => ({ operations: [definition], truncated: [] })
    });
    const stores = t.app.stores;
    // The development user exists once it has signed in.
    expect((await t.app.call("me.get", { headers: t.as("requester") })).statusCode).toBe(200);
    const userId = asUserId(await t.userId("Requester"));
    const user = await stores.users.getUser({ clientInstanceId: t.clientInstanceId, userId });
    if (!user) throw new Error("No requester");
    const actor: AuthenticatedUser = { ...user, externalUserId: "requester", authSource: "test" };
    const { collaborationWorkspaceId } = await stores.workspaces
      .ensurePersonalWorkspace({ clientInstanceId: t.clientInstanceId, userId })
      .then((workspace) => ({ collaborationWorkspaceId: workspace.id }));
    /** The agent's call of the operation in a new private chat of the requester. */
    const agentCall = async (marked: boolean) => {
      const conversation = await stores.conversations.createConversation({
        clientInstanceId: t.clientInstanceId,
        collaborationWorkspaceId,
        createdByUserId: userId,
        createdByExternalUserId: "requester",
        visibility: "private",
        title: "Held call",
        retainedUntil: "2099-01-01T00:00:00.000Z"
      });
      const message = await stores.conversations.appendMessage({
        clientInstanceId: t.clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Add Ada"
      });
      const agentRunId = asAgentRunId(`run_${conversation.id}`);
      await stores.agentRuns.createAgentRun({
        id: agentRunId,
        clientInstanceId: t.clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: userId,
        inputMessageId: message.id,
        agentName: "assistant",
        status: "running",
        startedAt: new Date().toISOString(),
        correlationId: agentRunId,
        authorization: {
          principal: createUserPrincipal(actor),
          subjectUserId: userId,
          scopes: ["*"]
        }
      });
      if (marked) {
        await stores.conversations.markPersonalData({
          clientInstanceId: t.clientInstanceId,
          conversationId: conversation.id,
          userId,
          at: new Date().toISOString()
        });
      }
      const calls = getTestExecution(worker).operationCalls;
      return runOperation(
        {
          operation: OPERATION,
          effect: "reading",
          input: { note: "Ada Lovelace" },
          actor,
          origin: {
            kind: "agent",
            conversationId: conversation.id,
            agentRunId,
            toolCallId: asToolCallId(`call_${conversation.id}`),
            agentName: "assistant",
            toolName: OPERATION
          },
          correlationId: `corr_${conversation.id}`
        },
        { ...calls.deps, agentToolNames: async () => [OPERATION] },
        { modelRoutes: [{ id: "local", region: "eu" }] }
      );
    };

    // Marked: the judge's model is never asked, the check could not be evaluated, the call stops.
    const marked = await agentCall(true);
    expect(marked.result).toMatchObject({
      status: "denied",
      reason: {
        kind: "guardrail",
        guardrailId: "no_names",
        guardrailReason: "Check 'no_names' could not be evaluated."
      }
    });
    expect(JSON.stringify(marked)).not.toMatch(/abroad|"us"|Ada Lovelace/u);
    expect(judge.requests).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();

    // Unmarked, the judge is asked as before and finds the name.
    const unmarked = await agentCall(false);
    expect(judge.requests).toHaveLength(1);
    expect(unmarked.result).toMatchObject({
      status: "denied",
      reason: { kind: "guardrail", guardrailReason: "Names a person." }
    });
    expect(execute).not.toHaveBeenCalled();

    // A worker process of a capability, such as the document worker, holds its calls that name
    // a conversation to the same rule: an extraction's task is an agent's text.
    const config = getTestConfig(t.app);
    const workerModels = await createWorkerCapabilityModels({
      config,
      clientInstanceId: t.clientInstanceId,
      infrastructure: await createInstanceInfrastructure({
        config,
        env: {},
        logger: silentTestLogger,
        providers: judge.capability.providers ?? []
      }),
      store: stores,
      bindingIds: ["judge"]
    });
    const extract = async (marked: boolean) => {
      const conversation = await stores.conversations.createConversation({
        clientInstanceId: t.clientInstanceId,
        collaborationWorkspaceId,
        createdByUserId: userId,
        createdByExternalUserId: "requester",
        visibility: "private",
        title: "Extraction",
        retainedUntil: "2099-01-01T00:00:00.000Z"
      });
      if (marked) {
        await stores.conversations.markPersonalData({
          clientInstanceId: t.clientInstanceId,
          conversationId: conversation.id,
          userId,
          at: new Date().toISOString()
        });
      }
      return workerModels.complete({
        bindingId: "judge",
        purpose: "document_extraction",
        content: [{ type: "text", text: "Ada Lovelace" }],
        conversationId: conversation.id,
        correlationId: `corr_extract_${conversation.id}`
      });
    };
    const asked = judge.requests.length;
    await expect(extract(true)).rejects.toMatchObject({
      details: { reason: "personal_data_model_region" }
    });
    expect(judge.requests).toHaveLength(asked);
    await extract(false);
    expect(judge.requests).toHaveLength(asked + 1);
    await worker.close();
    await t.app.close();
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

  it("brings the guardrail kind: an instance whose guardrails capability brings none has none", async () => {
    const builtIn = await fixture({ settings: () => [] });
    const listed = await builtIn.app.call("assets.list", {
      params: { kind: "guardrail" },
      headers: builtIn.as("root")
    });
    expect(listed.statusCode, listed.body).toBe(200);
    await builtIn.app.close();

    const kindless = await fixture({ capabilities: [kindlessGuardrails], settings: () => [] });
    const refused = await kindless.app.call("assets.list", {
      params: { kind: "guardrail" },
      headers: kindless.as("root")
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorOf(refused).message).toBe("Asset kind 'guardrail' is not registered");
    await kindless.app.close();
  });
});
