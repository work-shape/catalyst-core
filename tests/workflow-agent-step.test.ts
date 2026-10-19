import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  asUserId,
  defineProvider,
  createPlatformId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  type ModelAdapterRequest,
  type ModelAdapterFactory,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import { connection, fixtureConnectorType } from "./support/connections";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { createTestInstance, getTestConfig, getTestJobs } from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { required, waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";

const toolName = "connection.fixture.change";
const outputSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false
};
const changed: string[] = [];

type Mode =
  | "test"
  | "plain"
  | "valid"
  | "repair"
  | "invalid"
  | "malformed"
  | "repair_tool"
  | "confirm"
  | "approval";
async function fixture(mode: Mode = "valid", structuredOutput = false, tester = "user-1") {
  changed.length = 0;
  const requests: ModelAdapterRequest[] = [];
  const answer = (request: ModelAdapterRequest): ModelCompletion => {
    requests.push(request);
    const repair = request.messages.some(
      (message) =>
        message.role === "user" &&
        modelContentText(message.content).includes("Repair the rejected answer")
    );
    const hasToolResult = request.messages.some((message) => message.role === "tool");
    const call =
      ((mode === "test" || mode === "confirm" || mode === "approval") &&
        !hasToolResult &&
        !repair) ||
      (mode === "repair_tool" && repair);
    return {
      text:
        mode === "malformed"
          ? "THIS_IS_PRIVATE_BROKEN_JSON"
          : call
            ? ""
            : mode === "invalid" || ((mode === "repair" || mode === "repair_tool") && !repair)
              ? '{"answer":42}'
              : '{"answer":"validated"}',
      toolCalls: call
        ? [{ toolCallId: createPlatformId("toolcall"), toolName, input: { text: "one" } }]
        : [],
      sources: [],
      citations: [],
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        source: "provider_reported",
        webSearchCallCount: 0
      }
    };
  };
  const provider = defineProvider({
    port: "models",
    type: "workflow-scripted",
    external: false,
    configSchema: z.object({}),
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => ({ ...DETERMINISTIC_CAPABILITIES, streaming: false, structuredOutput }),
        complete: async (request) => answer(request),
        async *stream(request) {
          yield { type: "completed", completion: answer(request) };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe: () => ({})
  });
  const config = createTestConfig({
    developmentAuth: {
      enabled: true,
      defaultUserId: "user-1",
      users: [
        {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "Owner",
          roles: ["superadmin"],
          permissionRefs: []
        },
        {
          id: "reader",
          externalUserId: "reader",
          displayLabel: "Reader",
          roles: [],
          permissionRefs: []
        }
      ]
    },
    tools: [],
    toolNames: []
  });
  config.modules = {
    ...config.modules,
    workflows: { enabled: true },
    connections: { enabled: true },
    assetManagement: { enabled: true }
  };
  config.egress = {
    allow: [
      {
        protocol: "http" as const,
        host: "127.0.0.1",
        port: 45454,
        network: "private",
        cidrs: ["127.0.0.1/32"]
      }
    ]
  };
  config.infrastructure.models = { local: { provider: "workflow-scripted", model: "local" } };
  const policies: CentralPolicySetting[] =
    mode === "test"
      ? [{ operation: toolName, value: "allow" }]
      : mode === "approval"
        ? [{ operation: toolName, value: "approval" }]
        : mode === "confirm"
          ? [{ operation: toolName, value: "confirm" }]
          : [];
  const app = await createTestInstance({
    config,
    env: {},
    tools: [],
    connectorTypes: [
      {
        ...fixtureConnectorType,
        discover: undefined,
        declared: undefined,
        target: () => ({ protocol: "http" as const, host: "127.0.0.1", port: 45454 }),
        catalog: [
          {
            name: "change",
            description: "Records a synthetic change.",
            inputSchema: { type: "object" },
            proposedEffect: "changing"
          }
        ],
        execute: async (_operation, input) => {
          changed.push(z.object({ text: z.string() }).parse(input).text);
          return { changed: "one" };
        }
      }
    ],
    capabilities: [{ name: "workflow-model", providers: [provider], create: () => ({}) }],
    operations: { centralPolicySettings: () => policies }
  });
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const principal = await app.stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    name: "workflow-runner",
    displayLabel: "Workflow account"
  });
  await applyAtCurrentRevisions(app.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "connection",
        name: "fixture",
        config: connection("fixture", {
          settings: { url: "http://127.0.0.1:45454" },
          authScheme: "none",
          secretHandle: undefined,
          operations: [{ name: "change", effect: "changing", exposure: ["agent"], enabled: true }]
        })
      }
    ]
  });
  const owner = await app.call("me.get");
  const connectionAsset = required(
    await app.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "fixture"
    })
  );
  await app.stores.access.createGrant({
    clientInstanceId,
    holderKind: "service_principal",
    holderId: principal.id,
    action: "connection.use",
    effect: "allow",
    scopeKind: "asset",
    scopeId: connectionAsset.id,
    grantedBy: asUserId(owner.json<{ id: string }>().id)
  });
  const manifest: Record<string, import("@work-shape/catalyst-core").JsonValue> & {
    id: string;
    steps: import("@work-shape/catalyst-core").JsonValue[];
  } = {
    id: "agent-check",
    name: "Monthly check",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: outputSchema,
    tools: [toolName],
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "analyse",
        name: "Analyse",
        type: "agent",
        instructions: "Return the validated synthetic answer.",
        inputSchema: { type: "object" },
        outputSchema,
        input: {}
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { answer: { ref: { step: "analyse", path: "answer" } } }
      }
    ]
  };
  if (mode === "plain")
    manifest.steps = [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: { answer: { value: "plain-result" } } }
    ];
  const address = { kind: "workflow", name: manifest.id };
  const put = await app.call("assets.put", {
    params: address,
    payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
  });
  expect(put.statusCode, put.body).toBe(200);
  const published = await app.call("assets.publish", {
    params: address,
    payload: { revision: put.json<{ revision: number }>().revision }
  });
  expect(published.statusCode, published.body).toBe(200);
  if (mode === "test" && tester === "reader") {
    const reader = await app.call("me.get", {}, "reader");
    await app.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: reader.json<{ id: string }>().id,
      action: "workflow.write",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(owner.json<{ id: string }>().id)
    });
  }
  const started =
    mode === "test"
      ? await app.call(
          "workflows.test",
          { params: { workflow: manifest.id }, payload: { input: {} } },
          tester
        )
      : await app.call("workflows.start", {
          params: { workflow: manifest.id },
          payload: { input: {} }
        });
  expect(started.statusCode, started.body).toBe(200);
  const runId = started.json<{ id: string }>().id;
  getTestJobs(app).start();
  const steps = async () => {
    const response = await app.call("workflows.list_step_runs", { params: { runId } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      items: Array<{
        id: string;
        stepId: string;
        status: string;
        error?: { code: string };
        outputPreview?: { text: string };
        agent?: {
          runId: string;
          usage: { totalTokens: number };
          transcript?: Array<{ text: string }>;
        };
      }>;
    }>().items;
  };
  const ended = async (status: string) => {
    await waitUntil(
      async () =>
        (await app.stores.workflowRuns.readRun({ clientInstanceId, id: runId }))?.status === status,
      `Workflow ${status}`
    );
    return required((await steps()).find((step) => step.stepId === "analyse"));
  };
  return { app, clientInstanceId, principal, runId, requests, steps, ended };
}

describe("Workflow Child Agent Runs (CR-2)", () => {
  it.each(["user-1", "reader"])(
    "owns a draft test as %s and never makes a live changing call",
    async (tester) => {
      const f = await fixture("test", false, tester);
      const step = await f.ended("done");
      const child = required(
        await f.app.stores.childAgentRuns.readWorkflowAgentRun({
          clientInstanceId: f.clientInstanceId,
          stepRunId: step.id
        })
      );
      const person = await f.app.call("me.get", {}, tester);
      expect(child.ownerUserId).toBe(person.json<{ id: string }>().id);
      expect(child.authorization?.principal.kind).toBe("user");
      expect(changed).toEqual([]);
      const calls = await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId });
      const call = required(calls.find((call) => call.operation === toolName));
      expect(call.actor.kind).toBe("user");
      expect(call.actor.id).toBe(child.ownerUserId);
      expect(call.status).toBe(tester === "user-1" ? "done" : "denied");
    }
  );

  it("executes a published agent step and validates the output, attributing usage to its Workflow", async () => {
    const f = await fixture();
    const step = await f.ended("done");
    expect(JSON.parse(required(step.outputPreview).text)).toEqual({ answer: "validated" });
    expect(step.agent?.transcript?.some((message) => message.text.includes("validated"))).toBe(
      true
    );
    expect(step.agent?.usage.totalTokens).toBe(10);
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    expect(child.principalId).toBe(f.principal.id);
    await withTestSql(async (sql) => {
      const rows =
        await sql`select workflow_run_id, purpose, user_id from model_usage_events where agent_run_id = ${child.id}`;
      expect(rows).toMatchObject([
        { workflow_run_id: f.runId, purpose: "workflow_step", user_id: null }
      ]);
    });
    for (const operation of [
      "conversations.thread.get",
      "conversations.messages.list",
      "conversations.resources.list"
    ] as const) {
      const response = await f.app.call(operation, {
        params: { conversationId: child.conversationId }
      });
      expect(response.statusCode, response.body).toBe(404);
    }
  });

  it("answers a reader without run data with status, duration and usage only", async () => {
    const f = await fixture();
    await f.ended("done");
    const readerResponse = await f.app.call("me.get", {}, "reader");
    expect(readerResponse.statusCode, readerResponse.body).toBe(200);
    const readerId = readerResponse.json<{ id: string }>().id;
    const ownerResponse = await f.app.call("me.get");
    const ownerId = ownerResponse.json<{ id: string }>().id;
    await f.app.stores.access.createGrant({
      clientInstanceId: f.clientInstanceId,
      holderKind: "user",
      holderId: readerId,
      action: "workflow.read",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(ownerId)
    });
    const response = await f.app.call(
      "workflows.list_step_runs",
      { params: { runId: f.runId } },
      "reader"
    );
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<{
      items: Array<{
        stepId: string;
        status: string;
        finishedAt?: string;
        agent?: { usage: { totalTokens: number }; transcript?: unknown };
        outputPreview?: unknown;
      }>;
    }>().items;
    const step = required(items.find((step) => step.stepId === "analyse"));
    expect(step).toMatchObject({ status: "done", agent: { usage: { totalTokens: 10 } } });
    expect(step.finishedAt).toBeDefined();
    expect(step.agent?.transcript).toBeUndefined();
    expect(step.outputPreview).toBeUndefined();
    expect(response.body).not.toContain("validated");
    const run = await f.app.call("workflows.get_run", { params: { runId: f.runId } }, "reader");
    expect(run.statusCode, run.body).toBe(200);
    expect(run.body).not.toContain("validated");
    await f.app.stores.access.createGrant({
      clientInstanceId: f.clientInstanceId,
      holderKind: "user",
      holderId: readerId,
      action: "workflow.write",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(ownerId)
    });
    const cancelled = await f.app.call(
      "workflows.cancel_run",
      { params: { runId: f.runId } },
      "reader"
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.body).not.toContain("validated");
  });

  it("keeps the existing result access of a Workflow without an agent step", async () => {
    const f = await fixture("plain");
    await waitUntil(
      async () =>
        (
          await f.app.stores.workflowRuns.readRun({
            clientInstanceId: f.clientInstanceId,
            id: f.runId
          })
        )?.status === "done",
      "plain Workflow done"
    );
    const reader = await f.app.call("me.get", {}, "reader");
    const owner = await f.app.call("me.get");
    await f.app.stores.access.createGrant({
      clientInstanceId: f.clientInstanceId,
      holderKind: "user",
      holderId: reader.json<{ id: string }>().id,
      action: "workflow.read",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(owner.json<{ id: string }>().id)
    });
    const response = await f.app.call(
      "workflows.get_run",
      { params: { runId: f.runId } },
      "reader"
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ outputPreview?: { text: string } }>().outputPreview?.text).toContain(
      "plain-result"
    );
  });

  it("reads one agent usage through its index in a ledger of 10,000 other calls", async () => {
    const f = await fixture();
    const step = await f.ended("done");
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    await withTestSql(async (sql) => {
      await sql`insert into model_usage_events (id, client_instance_id, agent_run_id, agent_name, provider_id, model,
          input_tokens, output_tokens, total_tokens, source, correlation_id, created_at)
        select 'usage_scale_' || n, ${f.clientInstanceId}, 'other_agent_' || n, 'synthetic', 'local', 'local',
          7, 3, 10, 'provider_reported', 'scale', now() from generate_series(1, 10000) n`;
      await sql`analyze model_usage_events`;
      const plan =
        await sql`explain (analyze, format json) select sum(total_tokens) from model_usage_events
        where client_instance_id = ${f.clientInstanceId} and agent_run_id = ${child.id}`;
      expect(JSON.stringify(plan)).toContain("model_usage_events_agent_run_idx");
    });
    expect(
      (
        await f.app.stores.childAgentRuns.readWorkflowAgentData({
          clientInstanceId: f.clientInstanceId,
          stepRunId: step.id,
          includeTranscript: false
        })
      )?.usage.totalTokens
    ).toBe(10);
  });

  it("removes the thread transcript with Workflow run-data retention", async () => {
    const f = await fixture();
    const step = await f.ended("done");
    const storedRun = required(
      await f.app.stores.workflowRuns.readRun({ clientInstanceId: f.clientInstanceId, id: f.runId })
    );
    await f.app.stores.workflowRuns.pruneStepRunData({
      clientInstanceId: f.clientInstanceId,
      id: storedRun.id,
      limit: 100
    });
    expect(
      await f.app.stores.workflowRuns.markRunDataPruned({
        clientInstanceId: f.clientInstanceId,
        id: storedRun.id,
        prunedAt: new Date().toISOString()
      })
    ).toBe(true);
    const data = await f.app.stores.childAgentRuns.readWorkflowAgentData({
      clientInstanceId: f.clientInstanceId,
      stepRunId: step.id,
      includeTranscript: true
    });
    expect(JSON.stringify(data?.transcript)).not.toContain("validated");
    expect(data?.usage.totalTokens).toBe(10);
  });

  it("uses provider structured output mode when available", async () => {
    const f = await fixture("valid", true);
    await f.ended("done");
    expect(f.requests[0]?.output).toEqual({ jsonSchema: outputSchema });
  });

  it("refuses a provider tool call during the one repair turn", async () => {
    const f = await fixture("repair_tool");
    const step = await f.ended("failed");
    expect(step.error?.code).toBe("output_invalid");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.tools).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("repairs once in the same run with no tools and continues on valid JSON", async () => {
    const f = await fixture("repair");
    const step = await f.ended("done");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.tools).toEqual([]);
    expect(step.agent?.usage.totalTokens).toBe(20);
    expect(step.agent?.transcript?.some((message) => message.text === '{"answer":42}')).toBe(true);
  });

  it.each(["invalid", "malformed"] as const)(
    "fails after one invalid repair (%s), keeping rejected text out of audit",
    async (mode) => {
      const f = await fixture(mode);
      const step = await f.ended("failed");
      expect(step.error?.code).toBe("output_invalid");
      expect(
        (
          await f.app.stores.childAgentRuns.readWorkflowAgentRun({
            clientInstanceId: f.clientInstanceId,
            stepRunId: step.id
          })
        )?.status
      ).toBe("failed");
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.tools).toEqual([]);
      await withTestSql(async (sql) => {
        const rows =
          await sql`select metadata from audit_events where client_instance_id = ${f.clientInstanceId}`;
        expect(JSON.stringify(rows)).not.toContain('"answer":42');
        expect(JSON.stringify(rows)).not.toContain("THIS_IS_PRIVATE_BROKEN_JSON");
      });
    }
  );

  it("fails a confirm call while unattended, without executing it", async () => {
    const f = await fixture("confirm");
    const step = await f.ended("failed");
    expect(step.error?.code).toBe("confirmation_unattended");
    expect(changed).toEqual([]);
  });

  it("pauses for an approval and resumes with the same principal", async () => {
    const f = await fixture("approval");
    await waitUntil(async () => (await f.steps()).some((step) => step.agent?.runId), "child start");
    const step = required((await f.steps()).find((step) => step.stepId === "analyse"));
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    await waitUntil(
      async () =>
        (
          await f.app.stores.agentRuns.getAgentRun({
            clientInstanceId: f.clientInstanceId,
            runId: child.id
          })
        )?.status === "waiting_for_decision",
      "agent approval pause"
    );
    expect(changed).toEqual([]);
    await waitUntil(
      async () =>
        (
          await f.app.stores.workflowRuns.readRun({
            clientInstanceId: f.clientInstanceId,
            id: f.runId
          })
        )?.waitingSince !== undefined,
      "Workflow external approval wait"
    );
    const call = required(
      (await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })).find(
        (call) => call.origin.kind === "agent" && call.origin.agentRunId === child.id
      )
    );
    expect(call.actor).toMatchObject({ kind: "service_principal", id: f.principal.id });
    const decision = await f.app.call("approval_requests.decide", {
      params: { requestId: required(call.approvalRequestId) },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await f.ended("done");
    expect(
      (
        await f.app.stores.workflowRuns.readRun({
          clientInstanceId: f.clientInstanceId,
          id: f.runId
        })
      )?.waitedMs
    ).toBeGreaterThan(0);
    expect(changed).toEqual(["one"]);
  });
});
