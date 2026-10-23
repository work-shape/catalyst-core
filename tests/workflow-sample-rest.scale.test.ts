import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createInstanceWorkflows, createJobWorker } from "@work-shape/catalyst-client-assembly";
import {
  loadClientInstanceConfigFromFile,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { asUserId } from "@work-shape/catalyst-core";
import {
  createAccountingSample,
  createSampleMcpServer
} from "@work-shape/catalyst-demo/sample-mcp";
import { required, waitUntil } from "./support/assertions";
import { createTestConfig, setTestAgent } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import {
  createTestInstance,
  createTestInstanceWith,
  getTestExecution
} from "./support/test-instance";
import { publishedDefinitions, runSchema } from "./support/workflow-instance";

// Hosted only: real Postgres and the assembled agent/Workflow paths, against the demo's
// own REST declaration. The local unit test holds the rows, profiles and fault switches.
const NAME = "sample-accounting-rest";
const TOOL = `connection.${NAME}.listClients`;
const MONTH = "2026-09";
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

/** The sample server, and an instance on the demo's own REST declaration pointed at it. */
async function hosted(
  accountingRest: Parameters<typeof createSampleMcpServer>[0]["accountingRest"] = {}
) {
  const key = generateTestSecret();
  const log: string[] = [];
  const sample = createSampleMcpServer({ key, accountingRest, log: (line) => log.push(line) });
  closing.push(() => sample.close());
  const { port } = await sample.listen(0);
  const loaded = await loadClientInstanceConfigFromFile(resolve("clients/demo/config/app.yaml"));
  const declared = required(loaded.connections?.[NAME]);
  const config = parseClientInstanceConfig({
    ...createTestConfig({
      developmentAuth: {
        enabled: true,
        user: {
          id: "rest-user",
          externalUserId: "rest-user",
          displayLabel: "REST user",
          roles: ["user", "admin", "superadmin"]
        }
      }
    }),
    modules: {
      assetManagement: { enabled: true },
      connections: { enabled: true },
      workflows: { enabled: true }
    },
    connections: {
      [NAME]: {
        ...declared,
        settings: { ...declared.settings, baseUrl: `http://127.0.0.1:${port}/rest` }
      }
    },
    secretStore: { keys: [{ id: "local", ref: "CATALYST_SECRET_STORE_KEY" }] },
    egress: {
      allow: [
        { protocol: "http", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
      ]
    }
  });
  setTestAgent(config, {
    name: "rest_reader",
    displayName: "REST reader",
    instructions: "Read clients through the configured tool.",
    modelProviderId: "local",
    toolNames: [TOOL],
    initialPrompts: []
  });
  const assembly = {
    config,
    env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), DEMO_SAMPLE_MCP_KEY: key },
    tools: []
  };
  const instance = await createTestInstance(assembly);
  closing.push(() => instance.close());
  return { key, log, port, config, assembly, instance };
}

/** Workflows of the instance, run as a service principal that may use the Connection. */
async function workflowsOf({ assembly, config }: Awaited<ReturnType<typeof hosted>>) {
  const executionInstance = await createTestInstance({ execution: assembly });
  closing.push(() => executionInstance.close());
  const execution = getTestExecution(executionInstance);
  const { clientInstanceId, modules, store: stores } = execution;
  const principal = await stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: "workflow-runner"
  });
  const starter = await stores.users.resolveUserIdentity({
    clientInstanceId,
    authSource: "test",
    externalUserId: "rest-user",
    displayLabel: "REST user",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: [],
    permissions: [],
    correlationId: "test"
  });
  const connection = required(
    await stores.configAssets.getConfigAsset({ clientInstanceId, kind: "connection", name: NAME })
  );
  await stores.access.createGrant({
    clientInstanceId,
    holderKind: "service_principal",
    holderId: principal.id,
    action: "connection.use",
    effect: "allow",
    scopeKind: "asset",
    scopeId: connection.id,
    grantedBy: asUserId(starter.id)
  });
  const definitions = publishedDefinitions();
  const objects = new MemoryObjectStorage();
  const workflows = createInstanceWorkflows({
    modules,
    clientInstanceId,
    stores,
    operationCalls: execution.operationCalls,
    definitions: definitions.source,
    datasetObjects: objects
  });
  const jobs = createJobWorker({
    stores,
    clientInstanceId,
    handlers: workflows.jobHandlers,
    modules,
    logger: execution.logger
  });
  closing.push(() => jobs.stop());
  const api = await createTestInstanceWith(
    () => ({ config, modules, authorizer: execution.authorizer }),
    (route) => workflows.routes.forEach((register) => register(route))
  );
  closing.push(() => api.close());
  return { clientInstanceId, stores, definitions, objects, jobs, api };
}

it("reads the large client's whole month in one paged run with three filter values", async () => {
  const { clientInstanceId, stores, definitions, objects, jobs, api } = await workflowsOf(
    await hosted()
  );
  const sample = createAccountingSample();
  const large = required(
    sample.clients.find((client) => sample.postingCount(client.client_id, MONTH) === 100_000)
  ).client_id;
  const operation = `connection.${NAME}.listPostings`;
  definitions.publish({
    id: "rest-postings",
    name: "REST postings",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: {}, additionalProperties: false },
    outputs: {
      type: "object",
      properties: { postings: { type: "dataset", row: { type: "object" } } },
      required: ["postings"]
    },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "postings",
        name: "Read postings",
        type: "operation",
        operation,
        input: {
          filter: {
            value: [`client_id eq ${large}`, `date gte ${MONTH}-01`, "date lt 2026-10-01"]
          }
        },
        paginate: true,
        dataset: { at: "items" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { postings: { ref: { step: "postings", path: "items" } } }
      }
    ]
  });
  const response = await api.call("workflows.start", {
    params: { workflow: "rest-postings" },
    payload: { input: {} }
  });
  expect(response.statusCode, response.body).toBe(200);
  const runId = runSchema.parse(response.json()).id;
  const runOf = async () =>
    runSchema.parse((await api.call("workflows.get_run", { params: { runId } })).json());
  // One pass of the worker reads all 101 pages, so the wait is a bound on a slow runner.
  await waitUntil(
    async () => {
      await jobs.runDue();
      return ["done", "failed"].includes((await runOf()).status);
    },
    "the paged run ends",
    90_000
  );
  const run = await runOf();
  expect(run.status, JSON.stringify(run.error)).toBe("done");
  // 100 full pages and the empty page that ends them, under one Operation Run.
  const reads = (await stores.operationRuns.list({ clientInstanceId })).filter(
    (call) => call.operation === operation
  );
  expect(reads).toMatchObject([
    { status: "done", output: { value: { pages: 101, rows: 100_000 } } }
  ]);
  const [dataset] = await stores.workflowRunDatasets.listForRun({
    clientInstanceId,
    runId: z
      .custom<Parameters<typeof stores.workflowRunDatasets.listForRun>[0]["runId"]>()
      .parse(runId),
    limit: 10
  });
  expect(dataset).toMatchObject({ state: "complete", rowCount: 100_000 });
  const parts = required(dataset).parts;
  expect(parts).toHaveLength(101);
  const rowsOf = async (index: number) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await objects.get(required(parts[index]).key)).body)
      chunks.push(chunk);
    return gunzipSync(Buffer.concat(chunks))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  };
  // Only all three filters together select this client's month, in the sample's own order.
  expect(await rowsOf(0)).toEqual(sample.postings(large, MONTH, 0, 1000));
  expect(await rowsOf(99)).toEqual(sample.postings(large, MONTH, 99_000, 1000));
}, 120_000);
