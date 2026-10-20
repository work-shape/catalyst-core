import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  asUserId,
  defineProvider,
  createPlatformId,
  WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES,
  WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS,
  type CentralPolicySetting,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  type ModelAdapterRequest,
  type ModelAdapterFactory,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
import type { CreateClientInstanceAppInput } from "@work-shape/catalyst-client-assembly";
import { connection, fixtureConnectorType } from "./support/connections";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  createTestInstance,
  getTestConfig,
  getTestExecution,
  getTestJobs,
  type TestInstance
} from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { required, waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import { agentOutputError } from "@work-shape/catalyst-workflows";

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
  | "approval"
  | "test_confirm";
interface FixtureOptions {
  /** The Workflow's account may use the connection; a test of the bound withholds it. */
  principalUses?: boolean;
  /** The Workflow runs as its own account: its definition names no `runAs`. */
  ownAccount?: boolean;
  /** Runs after the Workflow run started and before a job claims it. */
  beforeJobs?: (started: {
    app: TestInstance;
    clientInstanceId: ClientInstanceId;
    runId: string;
  }) => Promise<void>;
}
async function fixture(
  mode: Mode = "valid",
  structuredOutput = false,
  tester = "user-1",
  options: FixtureOptions = {}
) {
  changed.length = 0;
  const draft = mode === "test" || mode === "test_confirm";
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
      ((draft || mode === "confirm" || mode === "approval") && !hasToolResult && !repair) ||
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
        : mode === "confirm" || mode === "test_confirm"
          ? [{ operation: toolName, value: "confirm" }]
          : [];
  const input: CreateClientInstanceAppInput = {
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
  };
  const app = await createTestInstance(input);
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
  if (options.principalUses !== false)
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
  if (options.ownAccount) delete manifest.runAs;
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
  if (draft && tester === "reader") {
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
  const started = draft
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
  await options.beforeJobs?.({ app, clientInstanceId, runId });
  getTestJobs(app).start();
  const steps = async () => {
    const response = await app.call("workflows.list_step_runs", { params: { runId } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      items: Array<{
        id: string;
        stepId: string;
        status: string;
        error?: { code: string; message: string; operation?: string };
        outputPreview?: { text: string };
        agent?: { runId: string; usage: { totalTokens: number } };
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
  const transcript = async (stepRunId: string, as = "user-1") =>
    app.call("workflows.get_step_transcript", { params: { runId, stepRunId } }, as);
  return { app, input, clientInstanceId, principal, runId, requests, steps, ended, transcript };
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
      // The Operation Run says which account bounded the call (ADR-0031).
      expect(call.origin).toMatchObject({ kind: "agent", boundBy: { id: f.principal.id } });
      // A draft test's model usage counts to its tester (check 103).
      await withTestSql(async (sql) => {
        const rows =
          await sql`select user_id, workflow_run_id from model_usage_events where agent_run_id = ${child.id}`;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows).toEqual(
          rows.map(() => ({ user_id: child.ownerUserId, workflow_run_id: f.runId }))
        );
      });
    }
  );

  it("refuses a draft test the call its tester may make and its Workflow's account may not", async () => {
    const f = await fixture("test", false, "user-1", { principalUses: false });
    await f.ended("done");
    const call = required(
      (await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })).find(
        (call) => call.operation === toolName
      )
    );
    expect(call.actor.kind).toBe("user");
    expect(call.status).toBe("denied");
    expect(changed).toEqual([]);
  });

  it("tests an agent step of a Workflow-owned account as its tester, bounded by the rights its definition needs", async () => {
    const f = await fixture("test", false, "user-1", { ownAccount: true, principalUses: false });
    const step = await f.ended("done");
    const run = required(
      await f.app.stores.workflowRuns.readRun({ clientInstanceId: f.clientInstanceId, id: f.runId })
    );
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    const person = await f.app.call("me.get");
    expect(child.ownerUserId).toBe(person.json<{ id: string }>().id);
    const call = required(
      (await f.app.stores.operationRuns.list({ clientInstanceId: f.clientInstanceId })).find(
        (call) => call.operation === toolName
      )
    );
    expect(call.actor.id).toBe(child.ownerUserId);
    expect(call.status).toBe("done");
    // The test run's own account is the bound; it exists in no store (ADR-0031).
    expect(run.principal.id).not.toBe(f.principal.id);
    expect(call.origin).toMatchObject({ kind: "agent", boundBy: { id: run.principal.id } });
    expect(changed).toEqual([]);
  });

  it("executes a published agent step and validates the output, attributing usage to its Workflow", async () => {
    const f = await fixture();
    const step = await f.ended("done");
    expect(JSON.parse(required(step.outputPreview).text)).toEqual({ answer: "validated" });
    expect(step.agent?.usage.totalTokens).toBe(10);
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    expect(child.principalId).toBe(f.principal.id);
    expect(child.agentName).toBe("workflow.agent-check.analyse");
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
        agent?: { usage: { totalTokens: number } };
        outputPreview?: unknown;
      }>;
    }>().items;
    const step = required(items.find((step) => step.stepId === "analyse"));
    expect(step).toMatchObject({ status: "done", agent: { usage: { totalTokens: 10 } } });
    expect(step.finishedAt).toBeDefined();
    expect(step.outputPreview).toBeUndefined();
    expect(response.body).not.toContain("validated");
    const agentStep = required((await f.steps()).find((entry) => entry.stepId === "analyse"));
    const refused = await f.transcript(agentStep.id, "reader");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).not.toContain("validated");
    const listed = await f.app.call(
      "workflows.list_runs",
      { params: { workflow: "agent-check" } },
      "reader"
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain("validated");
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
    const listed = await f.app.call(
      "workflows.list_runs",
      { params: { workflow: "agent-check" } },
      "reader"
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain("plain-result");
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
        await f.app.stores.childAgentRuns.readWorkflowAgentSummaries({
          clientInstanceId: f.clientInstanceId,
          stepRunIds: [step.id]
        })
      ).get(step.id)?.usage.totalTokens
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
    const kept = await f.app.stores.childAgentRuns.readWorkflowAgentTranscript({
      clientInstanceId: f.clientInstanceId,
      stepRunId: step.id
    });
    expect(JSON.stringify(kept)).not.toContain("validated");
    const summaries = await f.app.stores.childAgentRuns.readWorkflowAgentSummaries({
      clientInstanceId: f.clientInstanceId,
      stepRunIds: [step.id]
    });
    expect(summaries.get(step.id)?.usage.totalTokens).toBe(10);
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
    const response = await f.transcript(step.id);
    expect(response.statusCode, response.body).toBe(200);
    const texts = response
      .json<{ messages: Array<{ role: string; text: string }> }>()
      .messages.map((message) => `${message.role}: ${message.text}`);
    const rejected = texts.indexOf('assistant: {"answer":42}');
    expect(rejected).toBeGreaterThan(-1);
    // The repair prompt follows the answer it rejects, as the model read it.
    expect(texts[rejected + 1]).toMatch(/^user: The output is invalid at answer\. Repair/);
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
    // The failure names the operation that needed the confirmation (check 101).
    expect(step.error).toMatchObject({ code: "confirmation_unattended", operation: toolName });
    expect(step.error?.message).toContain(toolName);
    expect(changed).toEqual([]);
  });

  it("fails a draft test's confirm call as the published run would", async () => {
    const f = await fixture("test_confirm");
    const step = await f.ended("failed");
    expect(step.error).toMatchObject({ code: "confirmation_unattended", operation: toolName });
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

  it("cancels the Agent Run of a step that waits for an approval with its Workflow run", async () => {
    const f = await fixture("approval");
    await waitUntil(async () => (await f.steps()).some((step) => step.agent?.runId), "child start");
    const step = required((await f.steps()).find((step) => step.stepId === "analyse"));
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    const status = async () =>
      (
        await f.app.stores.agentRuns.getAgentRun({
          clientInstanceId: f.clientInstanceId,
          runId: child.id
        })
      )?.status;
    await waitUntil(
      async () => (await status()) === "waiting_for_decision",
      "agent approval pause"
    );
    const cancelled = await f.app.call("workflows.cancel_run", { params: { runId: f.runId } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await status()).toBe("cancelled");
    expect(changed).toEqual([]);
  });

  it("serves one agent step's transcript, bounded, to a holder of run data", async () => {
    const f = await fixture();
    const step = await f.ended("done");
    const listed = await f.app.call("workflows.list_step_runs", { params: { runId: f.runId } });
    expect(listed.body).not.toContain("transcript");
    const response = await f.transcript(step.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ messages: Array<{ text: string }> }>().messages).toContainEqual(
      expect.objectContaining({ text: '{"answer":"validated"}' })
    );
    const start = required((await f.steps()).find((entry) => entry.stepId === "start"));
    expect((await f.transcript(start.id)).statusCode).toBe(404);
    expect((await f.transcript("wsr_missing")).statusCode).toBe(404);
    // A step run of another run of the Workflow is not this run's.
    const other = await f.app.call("workflows.start", {
      params: { workflow: "agent-check" },
      payload: { input: {} }
    });
    expect(other.statusCode, other.body).toBe(200);
    const otherRunId = other.json<{ id: string }>().id;
    await waitUntil(
      async () =>
        (
          await f.app.stores.workflowRuns.readRun({
            clientInstanceId: f.clientInstanceId,
            id: otherRunId
          })
        )?.status === "done",
      "other Workflow done"
    );
    const otherSteps = await f.app.call("workflows.list_step_runs", {
      params: { runId: otherRunId }
    });
    const otherStep = required(
      otherSteps
        .json<{ items: Array<{ id: string; stepId: string }> }>()
        .items.find((entry) => entry.stepId === "analyse")
    );
    expect((await f.transcript(otherStep.id)).statusCode).toBe(404);
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    const append = (text: string) =>
      f.app.stores.conversations.appendMessage({
        clientInstanceId: f.clientInstanceId,
        conversationId: child.conversationId,
        role: "assistant",
        text
      });
    await append("x".repeat(WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS + 1));
    const cut = (await f.transcript(step.id)).json<{
      messages: Array<{ text: string }>;
      truncated: boolean;
    }>();
    expect(cut.truncated).toBe(true);
    expect(cut.messages.at(-1)?.text).toHaveLength(WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS);
    for (let index = 0; index < WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES; index += 1)
      await append(`line ${index}`);
    const long = (await f.transcript(step.id)).json<{
      messages: unknown[];
      truncated: boolean;
    }>();
    expect(long.messages).toHaveLength(WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES);
    expect(long.truncated).toBe(true);
  });

  it("refuses an agent Workflow whose tools start subagents", async () => {
    const f = await fixture("plain");
    const manifest = {
      id: "subagent-check",
      name: "Subagent check",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: outputSchema,
      tools: [toolName, "run_agent"],
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "analyse",
          name: "Analyse",
          type: "agent",
          instructions: "Answer.",
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
    const put = await f.app.call("assets.put", {
      params: { kind: "workflow", name: manifest.id },
      payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
    });
    expect(put.statusCode, put.body).toBe(422);
    expect(put.body).toContain("An agent step cannot start subagents");
  });

  it("never offers run_agent to a step's agent, even where its pinned definition lists it", async () => {
    const f = await fixture("valid", false, "user-1", {
      beforeJobs: async ({ runId }) => {
        await withTestSql(async (sql) => {
          await sql`update workflow_runs set definition = jsonb_set(definition, '{tools}',
            (definition -> 'tools') || '["run_agent"]'::jsonb) where id = ${runId}`;
        });
      }
    });
    await f.ended("done");
    const offered = required(f.requests[0]).tools.map((tool) => ("name" in tool ? tool.name : ""));
    expect(offered).toContain(toolName);
    expect(offered).not.toContain("run_agent");
  });

  it("gives a step's agent its Workflow's tools, never an agent asset's of its name", async () => {
    const name = "workflow.agent-check.analyse";
    const f = await fixture("test", false, "user-1", {
      beforeJobs: async ({ app, clientInstanceId }) => {
        await applyAtCurrentRevisions(app.stores.configAssets, {
          clientInstanceId,
          mutations: [
            {
              type: "upsert",
              kind: "agent",
              name,
              config: {
                name,
                displayName: name,
                instructions: "Use tools when useful.",
                modelProviderId: "local",
                toolNames: ["connection.fixture.other"],
                skillNames: [],
                initialPrompts: []
              }
            }
          ]
        });
      }
    });
    const step = await f.ended("done");
    const child = required(
      await f.app.stores.childAgentRuns.readWorkflowAgentRun({
        clientInstanceId: f.clientInstanceId,
        stepRunId: step.id
      })
    );
    expect(child.agentName).toBe(name);
    // A second process on the same database, as a worker is: its call path asks the tools.
    const execution = await createTestInstance({
      execution: f.input
    });
    const { agentToolNames } = getTestExecution(execution).operationCalls.deps;
    expect(await agentToolNames?.(child.agentName, child.conversationId)).toEqual([toolName]);
  });
});

describe("the engine's second check of an agent step's answer", () => {
  it("names where the answer misses its schema", () => {
    expect(agentOutputError(outputSchema, { text: '{"answer":42}' })).toEqual({
      code: "output_invalid",
      message: "Agent output is invalid at answer"
    });
    expect(agentOutputError(outputSchema, { text: '{"answer":"fits"}' })).toBeUndefined();
  });
});
