import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createInstanceWorkflows, createJobWorker } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  asConversationId,
  asUserId,
  type AuthenticatedIdentity,
  type JobWorker
} from "@work-shape/catalyst-core";
import { createSampleMcpServer } from "@work-shape/catalyst-demo/sample-mcp";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { createWorkflowFolderSource } from "@work-shape/catalyst-workflows";
import { runJobs, statuses } from "./support/connection-discovery-world";
import { createTestConfig } from "./support/fixtures";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import {
  createTestInstance,
  createTestInstanceWith,
  getTestExecution,
  type TestInstance
} from "./support/test-instance";
import { runSchema } from "./support/workflow-instance";

// What the demo seeds reads the two MCP Connections of the demo's release config, against the
// demo's own sample MCP server and through an assembled instance: the seeded App `customer-list`
// reads the answer of `sample-business.list_customers`, and the seeded Workflows
// `accounting-clients` and `kai-client-years` loop over the answer of
// `sample-accounting.list_accounting_clients`. A Connection of the type `mcp` answers
// `{ content, structuredContent }` (packages/connections/src/mcp/result.ts), so whatever reads
// the rows reads them under `structuredContent`.

const SAMPLE_MONTH = "2026-06";
/** The module of the seeded App that reads the answer of its action, as the App ships it. */
const CUSTOMER_READER = resolve("clients/demo/seed/apps/customer-list/1/src/customers.ts");
const customerReaderSchema = z.object({
  readCustomerPage: z.custom<(result: unknown) => unknown>((value) => typeof value === "function")
});
const USER = "user-1";

const closing: (() => Promise<unknown>)[] = [];
let execution: ReturnType<typeof getTestExecution>;
let api: TestInstance;
let jobs: JobWorker;
let viewer: AuthenticatedIdentity;

beforeAll(async () => {
  const key = generateTestSecret();
  const sample = createSampleMcpServer({ key, anchor: SAMPLE_MONTH });
  closing.push(() => sample.close());
  const { port } = await sample.listen(0, "127.0.0.1");
  const config = parseClientInstanceConfig({
    ...createTestConfig({
      developmentAuth: {
        enabled: true,
        user: {
          id: USER,
          externalUserId: USER,
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
    // The two Connections as clients/demo/config/app.yaml names them, at the test's server.
    connections: {
      "sample-business": {
        connectorType: "mcp",
        displayName: "Sample business",
        settings: { url: `http://127.0.0.1:${port}/mcp` },
        authScheme: "bearer",
        secret: "DEMO_SAMPLE_MCP_KEY",
        operations: [{ name: "list_customers", effect: "reading", exposure: ["agent", "bridge"] }]
      },
      "sample-accounting": {
        connectorType: "mcp",
        displayName: "Sample accounting",
        settings: { url: `http://127.0.0.1:${port}/accounting/mcp` },
        authScheme: "bearer",
        secret: "DEMO_SAMPLE_MCP_KEY",
        operations: [
          { name: "list_accounting_clients", effect: "reading", exposure: ["workflow"] },
          { name: "list_fiscal_years", effect: "reading", exposure: ["workflow"] }
        ]
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
    env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), DEMO_SAMPLE_MCP_KEY: key },
    tools: []
  };
  const keep = (instance: TestInstance) => {
    closing.push(() => instance.close());
    return instance;
  };

  // The API process seeds both Connections and discovers what they offer.
  const seeded = keep(await createTestInstance(assembly));
  await runJobs(seeded);
  expect(await statuses(seeded, "sample-business")).toEqual({ list_customers: "ready" });
  expect(await statuses(seeded, "sample-accounting")).toEqual({
    list_accounting_clients: "ready",
    list_fiscal_years: "ready"
  });

  execution = getTestExecution(keep(await createTestInstance({ execution: assembly })));
  const { clientInstanceId, modules, store: stores } = execution;
  const starter = await stores.users.resolveUserIdentity({
    clientInstanceId,
    authSource: "test",
    externalUserId: USER,
    displayLabel: USER,
    roles: ["user", "admin", "superadmin"],
    permissionRefs: [],
    permissions: [],
    correlationId: "test"
  });
  viewer = {
    id: starter.id,
    externalUserId: USER,
    displayLabel: starter.displayLabel,
    roles: starter.roles,
    permissions: starter.permissions,
    permissionRefs: starter.permissionRefs,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
  // The seed's principal of both Workflows, with the one grant the seed gives it.
  const principal = await stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: "workflow-demo"
  });
  await stores.access.createGrant({
    clientInstanceId,
    holderKind: "service_principal",
    holderId: principal.id,
    action: "connection.use",
    effect: "allow",
    scopeKind: "instance",
    grantedBy: asUserId(starter.id)
  });

  // The engine reads the seeded Workflows from the demo's seed folder as they are shipped.
  const workflows = createInstanceWorkflows({
    modules,
    clientInstanceId,
    stores,
    operationCalls: execution.operationCalls,
    definitions: createWorkflowFolderSource(resolve("clients/demo/seed/workflows"))
  });
  jobs = createJobWorker({
    stores,
    clientInstanceId,
    handlers: workflows.jobHandlers,
    modules,
    logger: execution.logger
  });
  closing.push(() => jobs.stop());
  api = keep(
    await createTestInstanceWith(
      () => ({ config, modules, authorizer: execution.authorizer }),
      (route) => workflows.routes.forEach((register) => register(route))
    )
  );
}, 120_000);

afterAll(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

describe("the demo's seeded App and Workflows against the sample MCP server", () => {
  // Fails on main: `readCustomerPage(answer.result)` (customer-list/1/src/routes/index.tsx)
  // looks for `rows` and `total` at the top of the result, where the Connection answers
  // `{ content, structuredContent }`, and the tile says "The customers could not be loaded."
  it("lets the Customers App read the rows its named action answers", async () => {
    // The call the action `list-customers` stands for (actions/list-customers.action.yaml),
    // made on the call path of the instance as a frame makes it. A named action of an App
    // answers its operation's output as it is (packages/chat-server/src/apps/action-call.ts).
    const outcome = await runOperation(
      {
        operation: "connection.sample-business.list_customers",
        effect: "reading",
        input: { limit: 12 },
        actor: viewer,
        origin: {
          kind: "app",
          appRevisionId: "rev_test",
          actionName: "list-customers",
          pageSessionId: "page_session_test",
          // A frame of a conversation: the call path asks no stored App (app-origin-guard.ts).
          conversationId: asConversationId("conv_test"),
          target: { connection: "sample-business", operation: "list_customers" }
        },
        correlationId: "corr_customer_list"
      },
      execution.operationCalls.deps
    );
    expect(outcome.result.status).toBe("done");
    if (outcome.result.status !== "done") return;
    // What the frame hands the App: `{ status, result }` with the operation's output.
    const answer = { status: "done", result: outcome.result.output };
    // The rows are in the answer, under `structuredContent`.
    expect(answer.result).toMatchObject({
      structuredContent: { rows: expect.any(Array), total: expect.any(Number) }
    });
    // What the App reads of it, as index.tsx reads it.
    const { readCustomerPage } = customerReaderSchema.parse(await import(CUSTOMER_READER));
    const page = readCustomerPage(answer.result);
    expect(page).toMatchObject({ rows: expect.any(Array), total: expect.any(Number) });
    expect(z.object({ rows: z.array(z.unknown()) }).parse(page).rows).toHaveLength(12);
  });

  const outputSchema = z.object({ read: z.number(), failed: z.number() });
  const finish = async (runId: string) => {
    for (let pass = 0; pass < 40; pass++) {
      await jobs.runDue();
      const response = await api.call("workflows.get_run", { params: { runId } });
      const run = runSchema.parse(response.json());
      if (!["queued", "running", "waiting"].includes(run.status)) return run;
    }
    throw new Error("The Workflow Run did not end");
  };

  // Fails on main: the loop's `items: { step: clients, path: rows }` names a field the output
  // `{ content, structuredContent }` of the step does not have, and the step fails as
  // `reference_unresolved`, which the interface shows as "The step did not get the data it
  // needs from the steps before it."
  it.each(["accounting-clients", "kai-client-years"])(
    "runs the seeded Workflow '%s' through its loop to its end",
    async (workflow) => {
      const response = await api.call("workflows.start", {
        params: { workflow },
        payload: { input: {} }
      });
      expect(response.statusCode, response.body).toBe(200);
      const run = await finish(runSchema.parse(response.json()).id);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("done");
      expect(outputSchema.parse(JSON.parse(run.outputPreview?.text ?? "null"))).toEqual({
        read: 5,
        failed: 0
      });
    },
    60_000
  );
});
