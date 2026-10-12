import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createInstanceWorkflows, createJobWorker } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { asUserId, type JobWorker } from "@vivd-catalyst/core";
import { createSampleMcpServer } from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./support/assertions";
import { runJobs, statuses } from "./support/connection-discovery-world";
import { createTestConfig } from "./support/fixtures";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import {
  createTestInstance,
  createTestInstanceWith,
  getTestExecution,
  type TestInstance
} from "./support/test-instance";
import {
  WORKFLOW_RUNNER,
  fixtureDefinitions,
  runSchema,
  stepRunsSchema
} from "./support/workflow-instance";

// A Workflow of three steps against the sample MCP server of the demo, through an assembled
// instance: the Connection is seeded from release config, its catalog is discovered by the
// job, and the operation step calls the server through the instance's own call path. The
// assembly builds its engine without a definition until Workflows are stored as assets, so the
// test builds one over the fixture folders, on the stores and the call path of an assembled
// process, and hands its routes to an API process and its handler to a job worker.

const SAMPLE_MONTH = "2026-06";
const TOP = 3;

const outputSchema = z.object({
  customers: z.array(z.object({ rank: z.number(), revenueCents: z.number() }).loose())
});

describe("a three-step Workflow against the sample MCP Connection", () => {
  const closing: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of closing.splice(0).reverse()) await close();
  });

  it("runs to its end through the API and returns what the server answered", async () => {
    const key = generateTestSecret();
    const sample = createSampleMcpServer({ key, anchor: SAMPLE_MONTH });
    closing.push(() => sample.close());
    const { port } = await sample.listen(0, "127.0.0.1");

    const config = parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: {
        assetManagement: { enabled: true },
        connections: { enabled: true },
        workflows: { enabled: true }
      },
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
      connections: {
        sample: {
          connectorType: "mcp",
          displayName: "Sample system",
          settings: { url: `http://127.0.0.1:${port}/mcp` },
          authScheme: "bearer",
          secret: "SAMPLE_MCP_KEY",
          operations: [{ name: "top_customers", effect: "reading", exposure: ["workflow"] }]
        }
      },
      secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
      egress: {
        allow: [
          { protocol: "http", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
        ]
      }
    });
    const assembly = {
      config,
      env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), SAMPLE_MCP_KEY: key },
      tools: []
    };
    const keep = (instance: TestInstance) => {
      closing.push(() => instance.close());
      return instance;
    };

    // The API process of the assembly seeds the Connection and discovers what it offers.
    const seeded = keep(await createTestInstance(assembly));
    await runJobs(seeded);
    expect(await statuses(seeded, "sample")).toEqual({ top_customers: "ready" });

    // A process of the assembly that makes calls: its stores and its call path carry the engine.
    const execution = getTestExecution(keep(await createTestInstance({ execution: assembly })));
    const { clientInstanceId, modules, store: stores } = execution;
    const principal = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: WORKFLOW_RUNNER
    });
    const workflows = createInstanceWorkflows({
      modules,
      clientInstanceId,
      stores,
      operationCalls: execution.operationCalls,
      definitions: fixtureDefinitions()
    });
    const jobs: JobWorker = createJobWorker({
      stores,
      clientInstanceId,
      handlers: workflows.jobHandlers,
      modules,
      logger: execution.logger
    });
    closing.push(() => jobs.stop());

    const api = keep(
      await createTestInstanceWith(
        () => ({ config, modules, authorizer: execution.authorizer }),
        (route) => workflows.routes.forEach((register) => register(route))
      )
    );
    const read = async (runId: string) =>
      runSchema.parse((await api.call("workflows.get_run", { params: { runId } })).json());
    const finish = async (runId: string) => {
      for (let pass = 0; pass < 20; pass++) {
        await jobs.runDue();
        const run = await read(runId);
        if (!["queued", "running", "waiting"].includes(run.status)) return run;
      }
      throw new Error("The Workflow Run did not end");
    };
    const startRun = async () => {
      const response = await api.call("workflows.start", {
        params: { workflow: "top-customers" },
        payload: { input: { limit: TOP } }
      });
      expect(response.statusCode, response.body).toBe(200);
      return runSchema.parse(response.json());
    };

    // The principal holds nothing yet: the starter is a superadmin, and the step is refused.
    const refused = await finish((await startRun()).id);
    expect(refused).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });

    const starter = await stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: "user-1",
      displayLabel: "user-1",
      roles: ["user", "admin", "superadmin"],
      permissionRefs: [],
      permissions: [],
      correlationId: "test"
    });
    await stores.access.createGrant({
      clientInstanceId,
      // AP-10: the grant is written to the store; its administration does not give it yet.
      holderKind: "service_principal",
      holderId: principal.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(starter.id)
    });

    const run = await finish((await startRun()).id);
    expect(run.error).toBeUndefined();
    expect(run).toMatchObject({
      workflow: "top-customers",
      status: "done",
      stepRunCount: 3,
      principal: { id: principal.id }
    });
    expect(run.outputPreview?.truncated).toBe(false);
    const output = outputSchema.parse(JSON.parse(run.outputPreview?.text ?? "null"));
    expect(output.customers.map((row) => row.rank)).toEqual([1, 2, 3]);
    const revenues = output.customers.map((row) => row.revenueCents);
    expect(revenues).toEqual([...revenues].sort((left, right) => right - left));

    const stepRuns = stepRunsSchema.parse(
      (await api.call("workflows.list_step_runs", { params: { runId: run.id } })).json()
    ).items;
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["top", "done"],
      ["result", "done"]
    ]);
    const call = await stores.operationRuns.get({
      clientInstanceId,
      id: required(stepRuns[1]?.operationRunId)
    });
    expect(call).toMatchObject({
      operation: "connection.sample.top_customers",
      status: "done",
      actor: { kind: "service_principal", id: principal.id },
      origin: { kind: "workflow", workflowRunId: run.id, stepRunId: stepRuns[1]?.id }
    });
  });
});
