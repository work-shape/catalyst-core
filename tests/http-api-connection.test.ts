import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { asClientInstanceId, type OperationOrigin } from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { createTestInstance, getTestExecution, type TestInstance } from "./support/test-instance";

// An `http_api` Connection made on an assembled instance as a person makes it: the definition
// saved through `assets.put`, the key entered once through `connections.set_secret`, the test,
// then the declarations pasted and a call from a Workflow step through `runOperation()`. Every
// test fails without the type: before it no instance had a type that reads a REST interface.

const clientInstanceId = asClientInstanceId("demo-local");
const NAME = "exampledata";
const INSTANCE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

const declared = {
  name: "list_clients",
  effect: "reading",
  exposure: ["workflow"],
  enabled: true,
  method: "GET",
  path: "/clients",
  description: "Lists the Mandanten with their number."
};
const openItems = {
  name: "open_items",
  effect: "reading",
  exposure: ["workflow"],
  enabled: true,
  method: "GET",
  path: "/clients/{clientId}/open-items",
  description: "Reads the open items of one Mandant.",
  pathParams: { clientId: { schema: { type: "string" } } }
};

const workflowStep: OperationOrigin = {
  kind: "workflow",
  workflowRunId: "wfrun_test",
  stepRunId: "step_test"
};

const errorSchema = z.object({
  error: z.object({ message: z.string(), details: z.record(z.string(), z.unknown()).optional() })
});
const detailSchema = z.object({
  health: z.string(),
  secret: z.object({ state: z.string(), version: z.number().optional() }),
  operations: z.array(z.object({ name: z.string(), status: z.string() }))
});

const servers: RestTestServer[] = [];
const started: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The key release config hands its `http_api` Connection, where a test defines one. */
const RELEASE_KEY = generateTestSecret();

async function world(options: { release?: true } = {}) {
  const server = await startRestTestServer(json([{ number: 10001 }, { number: 10002 }]));
  servers.push(server);
  const releaseConnections = {
    gateway: {
      connectorType: "http_api",
      displayName: "Gateway",
      settings: { baseUrl: `http://127.0.0.1:${server.port}/datevconnect` },
      authScheme: "bearer",
      secret: "GATEWAY_KEY",
      // Release config names no `enabled`: a release operation is on.
      operations: [declared, openItems].map(({ enabled: _enabled, ...operation }) => operation)
    }
  };
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
    modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
    ...(options.release ? { connections: releaseConnections } : {}),
    secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
    egress: {
      allow: [
        {
          protocol: "http",
          host: "127.0.0.1",
          port: server.port,
          network: "private",
          cidrs: ["127.0.0.1/32"]
        },
        // Another host, which the key was not set for.
        {
          protocol: "http",
          host: "127.0.0.2",
          port: server.port,
          network: "private",
          cidrs: ["127.0.0.2/32"]
        }
      ]
    }
  });
  // No connector type is handed to the assembly: `http_api` is the platform's own.
  const assembly = {
    config,
    env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), GATEWAY_KEY: RELEASE_KEY },
    tools: []
  };
  const instance = await createTestInstance(assembly);
  started.push(instance);
  /** A process that runs the calls of Workflow steps, on the same rows. */
  let execution: TestInstance | undefined;
  const baseUrl = `http://127.0.0.1:${server.port}/datevconnect`;

  const definition = (overrides: Record<string, unknown> = {}) => ({
    name: NAME,
    displayName: "Exampledata",
    connectorType: "http_api",
    settings: {
      baseUrl,
      headers: { "x-client-instance-id": INSTANCE_ID },
      testPath: "/health"
    },
    authScheme: "bearer",
    operations: [],
    enabled: true,
    ...overrides
  });
  const put = (config: Record<string, unknown>, expectedRevision: number | null) =>
    instance.call("assets.put", {
      params: { kind: "connection", name: NAME },
      payload: { config, expectedRevision }
    });
  const setSecret = (value: string, expectedVersion: number | null) =>
    instance.call("connections.set_secret", {
      params: { name: NAME },
      payload: { value, expectedVersion }
    });
  const detail = async () => {
    const response = await instance.call("connections.get", { params: { name: NAME } });
    expect(response.statusCode).toBe(200);
    return detailSchema.parse(response.json());
  };
  const call = async (operation: string, input: unknown, connection = NAME) => {
    if (execution === undefined) {
      execution = await createTestInstance({ execution: assembly });
      started.push(execution);
    }
    const { operationCalls } = getTestExecution(execution);
    return runOperation(
      {
        operation: `connection.${connection}.${operation}`,
        effect: "reading",
        input,
        actor: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"],
          permissions: [],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test",
          scopes: ["*"]
        },
        origin: workflowStep,
        correlationId: "corr_http_api"
      },
      operationCalls.deps
    );
  };
  const runs = async () =>
    (await instance.stores.operationRuns.list({ clientInstanceId })).filter((run) =>
      run.operation.startsWith(`connection.${NAME}.`)
    );
  return { server, instance, baseUrl, definition, put, setSecret, detail, call, runs };
}

describe("an http_api Connection made on the instance", () => {
  it("is saved without a key, takes it once, passes its test, takes pasted declarations and answers a Workflow step with one run", async () => {
    const w = await world();
    expect((await w.put(w.definition(), null)).statusCode).toBe(200);
    const key = generateTestSecret();
    expect((await w.setSecret(key, null)).json()).toEqual({ state: "set", version: 1 });

    const tested = await w.instance.call("connections.test", { params: { name: NAME } });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ status: "ready" });
    // The test asked the health address and handed back nothing of what it answered.
    expect(tested.body).not.toContain("10001");
    expect(w.server.requests.map((request) => request.url)).toEqual(["/datevconnect/health"]);

    // The person pastes the declarations: one save accepts them with effect and exposure.
    expect((await w.put(w.definition({ operations: [declared, openItems] }), 1)).statusCode).toBe(
      200
    );
    expect((await w.detail()).operations).toEqual([
      expect.objectContaining({ name: "list_clients", status: "ready" }),
      expect.objectContaining({ name: "open_items", status: "ready" })
    ]);

    const outcome = await w.call("list_clients", {});
    expect(outcome.result).toMatchObject({
      status: "done",
      output: { items: [{ number: 10001 }, { number: 10002 }] }
    });
    const sent = required(w.server.requests.at(-1));
    expect(sent.url).toBe("/datevconnect/clients");
    expect(sent.headers.authorization).toBe(`Bearer ${key}`);
    expect(sent.headers["x-client-instance-id"]).toBe(INSTANCE_ID);
    expect((await w.runs()).map((run) => [run.operation, run.status])).toEqual([
      [`connection.${NAME}.list_clients`, "done"]
    ]);

    // A path parameter that leaves its segment is refused before anything is sent.
    const before = w.server.requests.length;
    const refused = await w.call("open_items", { clientId: "../admin" });
    expect(refused.result).toMatchObject({ status: "failed" });
    expect(refused.run.error?.reason).toBe("input_invalid");
    expect(w.server.requests).toHaveLength(before);
    // No answer, revision or run holds the key.
    const read = await w.instance.call("assets.get", {
      params: { kind: "connection", name: NAME }
    });
    expect(read.body).not.toContain(key);
    expect(JSON.stringify(await w.runs())).not.toContain(key);
  });

  it("refuses every operation scope value at save and in release config with SCOPE-2", async () => {
    const w = await world();
    for (const scope of [
      { mandant: { input: "clientId", output: "items[].number" } },
      {},
      null,
      false,
      "mandant"
    ]) {
      const operation = { ...openItems, scope };
      const response = await w.put(w.definition({ operations: [operation] }), null);
      expect(response.statusCode, response.body).toBe(422);
      expect(JSON.stringify(errorSchema.parse(response.json()).error)).toContain("SCOPE-2");
      const { enabled: _enabled, ...releaseOperation } = operation;
      expect(() =>
        parseClientInstanceConfig({
          ...createTestConfig(),
          connections: {
            source: {
              connectorType: "http_api",
              authScheme: "none",
              settings: { baseUrl: "https://api.example.test" },
              operations: [releaseOperation]
            }
          }
        })
      ).toThrow(/scope.*SCOPE-2/u);
    }
    expect(
      await w.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: NAME
      })
    ).toBeUndefined();
    expect((await w.put(w.definition({ operations: [openItems] }), null)).statusCode).toBe(200);
  });

  it("refuses at save a method other than GET, the effect changing and a credential header", async () => {
    const w = await world();
    const refusedBy = async (config: Record<string, unknown>) => {
      const response = await w.put(config, null);
      expect(response.statusCode, response.body).toBe(422);
      return JSON.stringify(errorSchema.parse(response.json()).error);
    };
    expect(
      await refusedBy(w.definition({ operations: [{ ...declared, method: "POST" }] }))
    ).toContain("the method is GET");
    expect(
      await refusedBy(w.definition({ operations: [{ ...declared, effect: "changing" }] }))
    ).toContain("the effect is 'reading'");
    for (const header of [
      "Authorization",
      "Cookie",
      "X-Api-Key",
      "X-Auth-Token",
      "Client-Secret"
    ]) {
      const settings = { baseUrl: w.baseUrl, headers: { [header]: "value" } };
      expect(await refusedBy(w.definition({ settings })), header).toContain(
        "credential_in_settings"
      );
    }
    expect(
      await refusedBy(w.definition({ operations: [{ ...declared, path: "/clients/{clientId}" }] }))
    ).toContain("{clientId}");
    // Nothing was saved, and nothing was sent.
    const stored = await w.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: NAME
    });
    expect(stored).toBeUndefined();
    expect(w.server.requests).toEqual([]);
  });

  it("clears the stored key when the host of the address changes, and a call is refused until a key is set again", async () => {
    const w = await world();
    await w.put(w.definition({ operations: [declared] }), null);
    await w.setSecret(generateTestSecret(), null);
    expect((await w.detail()).secret.state).toBe("set");

    // Another path on the same host keeps the key.
    const samePath = `${w.baseUrl}/v2`;
    const kept = w.definition({
      operations: [declared],
      settings: { baseUrl: samePath, headers: { "x-client-instance-id": INSTANCE_ID } }
    });
    expect((await w.put(kept, 1)).statusCode).toBe(200);
    expect((await w.detail()).secret.state).toBe("set");

    const moved = w.definition({
      operations: [declared],
      settings: { baseUrl: w.baseUrl.replace("127.0.0.1", "127.0.0.2") }
    });
    expect((await w.put(moved, 2)).statusCode).toBe(200);
    expect((await w.detail()).secret.state).toBe("not_set");

    const before = w.server.requests.length;
    const outcome = await w.call("list_clients", {});
    expect(outcome.result).toMatchObject({ status: "failed" });
    expect(w.server.requests).toHaveLength(before);
  });

  it("is seeded from release config with its declarations, and a Workflow step calls it", async () => {
    const w = await world({ release: true });
    const stored = required(
      await w.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "gateway"
      })
    );
    expect(stored.config).toMatchObject({
      origin: "release",
      operations: [
        { name: "list_clients", method: "GET", path: "/clients" },
        { name: "open_items", pathParams: { clientId: { schema: { type: "string" } } } }
      ]
    });
    const outcome = await w.call("open_items", { clientId: "10001" }, "gateway");
    expect(outcome.result).toMatchObject({ status: "done", output: { items: [{}, {}] } });
    const sent = required(w.server.requests.at(-1));
    expect(sent.url).toBe("/datevconnect/clients/10001/open-items");
    expect(sent.headers.authorization).toBe(`Bearer ${RELEASE_KEY}`);
  });
});
