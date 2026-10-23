import { afterEach, describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createHttpApiConnectorType } from "@work-shape/catalyst-connections";
import {
  asClientInstanceId,
  type ConnectorTypeDefinition,
  type ResultShaper
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { createTestConfig, setTestAgent } from "./support/fixtures";
import { createTestInstance, getTestExecution, type TestInstance } from "./support/test-instance";
import { agentOrigin } from "./support/connection-operations";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { required } from "./support/assertions";

const instances: TestInstance[] = [];
const servers: RestTestServer[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function world() {
  const secret = generateTestSecret();
  const server = await startRestTestServer(json({ raw: "sample answer" }));
  servers.push(server);
  const resultShapers: Record<string, ResultShaper> = {
    count: () => ({ count: 1 }),
    invalid: () => ({ wrong: 1 }),
    large: () => ({ value: "x".repeat(2 * 1024 * 1024) }),
    echo: () => ({ value: secret }),
    fail: () => {
      throw new Error("private upstream data");
    }
  };
  const http = createHttpApiConnectorType(resultShapers);
  const declared = required(http.declared);
  const checkedHttp: ConnectorTypeDefinition = {
    ...http,
    type: "checked_http",
    catalog: undefined,
    discover: undefined,
    declared: {
      ...declared,
      describe: (operation: Parameters<typeof declared.describe>[0]) => ({
        ...declared.describe(operation),
        outputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
          additionalProperties: false
        }
      })
    }
  };
  const operation = (name: string, shaper?: string) => ({
    name,
    method: "GET",
    path: "/items",
    description: "Read sample items.",
    effect: "reading",
    exposure: ["agent", "outside"],
    ...(shaper === undefined ? {} : { shaper })
  });
  const operations = [
    operation("raw"),
    ...Object.keys(resultShapers).map((name) => operation(name, name))
  ];
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
    secretStore: { keys: [{ id: "k1", ref: "STORE_KEY" }] },
    egress: {
      allow: [
        {
          protocol: "http",
          host: "127.0.0.1",
          port: server.port,
          network: "private",
          cidrs: ["127.0.0.1/32"]
        }
      ]
    },
    connections: Object.fromEntries(
      ["http_api", "checked_http"].map((connectorType) => [
        connectorType,
        {
          connectorType,
          settings: { baseUrl: `http://127.0.0.1:${server.port}` },
          authScheme: "bearer",
          secret: "API_KEY",
          operations
        }
      ])
    )
  });
  setTestAgent(config, {
    name: "test_agent",
    displayName: "Test agent",
    instructions: "Read sample data.",
    modelProviderId: "local",
    toolNames: ["connection.http_api.count"],
    initialPrompts: []
  });
  const assembly = {
    config,
    tools: [],
    resultShapers,
    connectorTypes: [checkedHttp],
    env: { STORE_KEY: generateSecretStoreKey(), API_KEY: secret }
  };
  const api = await createTestInstance(assembly);
  instances.push(api);
  const execution = await createTestInstance({ execution: assembly });
  instances.push(execution);
  const { operationCalls } = getTestExecution(execution);
  return {
    server,
    api,
    async call(name: string, type = "http_api", agent = false) {
      const operation = `connection.${type}.${name}`;
      return runOperation(
        {
          operation,
          effect: "reading",
          input: {},
          actor: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"],
            permissions: [],
            permissionRefs: [],
            clientInstanceId: asClientInstanceId(config.clientInstance.id),
            authSource: "test",
            scopes: ["*"]
          },
          origin: agent ? agentOrigin(operation, "test_agent") : { kind: "cli" },
          correlationId: "shaper-test"
        },
        operationCalls.deps
      );
    }
  };
}

describe("result shapers through the assembled call path", () => {
  it("returns the shaped value to an agent, leaves an unshaped operation raw, and checks shaped output schemas", async () => {
    const w = await world();
    expect((await w.call("count", "http_api", true)).result).toMatchObject({
      status: "done",
      output: { count: 1 }
    });
    expect((await w.call("raw")).result).toMatchObject({
      status: "done",
      output: { raw: "sample answer" }
    });
    expect((await w.call("count", "checked_http")).result).toMatchObject({
      status: "done",
      output: { count: 1 }
    });
    expect((await w.call("invalid", "checked_http")).run.error?.reason).toBe("output_invalid");
  });

  it("bounds shaped output, rejects a shaped secret echo, and reports a throwing shaper as output_invalid", async () => {
    const w = await world();
    for (const [name, reason] of [
      ["large", "output_invalid"],
      ["echo", "output_rejected"],
      ["fail", "output_invalid"]
    ]) {
      const result = await w.call(required(name));
      expect(result.run.error?.reason).toBe(reason);
      expect(JSON.stringify(result)).not.toContain("private upstream data");
    }
    const put = await w.api.call("assets.put", {
      params: { kind: "connection", name: "unknown" },
      payload: {
        expectedRevision: null,
        config: {
          name: "unknown",
          displayName: "Unknown shaper",
          connectorType: "http_api",
          settings: { baseUrl: "https://sample.example.test" },
          authScheme: "none",
          operations: [
            {
              name: "read",
              effect: "reading",
              exposure: [],
              enabled: true,
              method: "GET",
              path: "/items",
              description: "Read items.",
              shaper: "unregistered"
            }
          ]
        }
      }
    });
    expect(put.statusCode, put.body).toBe(422);
    expect(put.body).toContain("Unknown result shaper");
  });
});
