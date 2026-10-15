import { afterEach, describe, expect, it } from "vitest";
import {
  connectionConfigSchema,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { openConnectorContext } from "@work-shape/catalyst-connections";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { startMcpTestServer, tool, type McpTestServer } from "./support/mcp-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { createTestInstance, getTestExecution } from "./support/test-instance";

// The `mcp` Connector type as an assembled instance has it: no assembly registers it, a
// start with a seeded MCP Connection reaches no server, and the first request leaves with
// the first test. It fails without the type: release config that names `mcp` stops the
// start with `connector_type_unknown`.

describe("the mcp type on an assembled instance", () => {
  const servers: McpTestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("is a type of the build, a start reaches no server, and a test of the seeded Connection is ready", async () => {
    const key = generateTestSecret();
    const server = await startMcpTestServer({
      requireHeader: { name: "authorization", value: `Bearer ${key}` },
      tools: [tool("revenue_by_month", { annotations: { readOnlyHint: true } })]
    });
    servers.push(server);
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
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
      connections: {
        outside: {
          connectorType: "mcp",
          displayName: "Outside",
          settings: { url: `http://127.0.0.1:${server.port}/mcp` },
          authScheme: "bearer",
          secret: "OUTSIDE_MCP_KEY",
          operations: [{ name: "revenue_by_month", effect: "reading", exposure: ["agent"] }]
        }
      },
      secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
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
      }
    });
    // No connector type is handed to the assembly: `mcp` is the platform's own.
    const assembly = {
      config,
      env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), OUTSIDE_MCP_KEY: key },
      tools: []
    };
    // One start of the API process, which seeds, and then a process that would make calls.
    await (await createTestInstance({ ...assembly, seedAssets: false })).close();
    const instance = await createTestInstance({ execution: assembly });
    try {
      const connections = required(getTestExecution(instance).connections);
      const type = required(connections.connectorTypes.get("mcp"));
      const stored = required(
        await instance.stores.configAssets.getConfigAsset({
          clientInstanceId: asClientInstanceId("demo-local"),
          kind: "connection",
          name: "outside"
        })
      );
      // The start seeded the Connection and its key, and nothing has reached the server.
      expect(server.connections).toBe(0);

      const open = () =>
        openConnectorContext({
          type,
          connection: {
            id: stored.id,
            revision: stored.revision,
            config: connectionConfigSchema.parse(stored.config)
          },
          egress: connections.egress,
          credentials: required(connections.credentials),
          signal: new AbortController().signal
        });
      expect(await type.test(await open())).toEqual({ status: "ready" });
      expect((await required(type.discover)(await open())).map(({ name }) => name)).toEqual([
        "revenue_by_month"
      ]);
      expect(server.connections).toBe(1);
    } finally {
      await instance.close();
    }
  });
});
