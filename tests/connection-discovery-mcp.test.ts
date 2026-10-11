import { afterEach, describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { required } from "./support/assertions";
import { auditEvents, runJobs, statuses, storedState } from "./support/connection-discovery-world";
import { createTestConfig } from "./support/fixtures";
import { startMcpTestServer, tool, type McpTestServer } from "./support/mcp-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { createTestInstance } from "./support/test-instance";

// The discovery job with the platform's own `mcp` Connector type and a server that speaks
// the protocol: the type's `discover` is what the job calls, and what the server lists is
// what the catalog holds. It fails without the job: nothing asked the server for its tools,
// and an accepted operation of an MCP Connection stayed `awaiting_discovery`.

describe("the discovery of an MCP Connection", () => {
  const servers: McpTestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("stores what the server lists once its job ran, and reaches no server before", async () => {
    const key = generateTestSecret();
    const server = await startMcpTestServer({
      requireHeader: { name: "authorization", value: `Bearer ${key}` },
      tools: [
        tool("revenue_by_month", { annotations: { readOnlyHint: true } }),
        tool("orders_by_day", { annotations: { readOnlyHint: true } })
      ]
    });
    servers.push(server);
    const operation = (name: string) => ({ name, effect: "reading", exposure: ["agent"] });
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
          // The second one is accepted and not offered by the server.
          operations: [operation("revenue_by_month"), operation("refunds_by_month")]
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
    const instance = await createTestInstance({
      config,
      env: { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), OUTSIDE_MCP_KEY: key },
      tools: []
    });
    try {
      // The start queued the discovery and contacted nothing.
      expect(server.connections).toBe(0);
      expect(await statuses(instance)).toEqual({
        revenue_by_month: "awaiting_discovery",
        refunds_by_month: "awaiting_discovery"
      });

      await runJobs(instance);

      expect(server.rpc("tools/list").length).toBeGreaterThan(0);
      const { state, catalog } = await storedState(instance);
      expect(state).toMatchObject({ health: "ok" });
      expect(state?.lastErrorCode ?? null).toBeNull();
      expect(
        required(catalog)
          .entries.map((entry) => entry.name)
          .sort()
      ).toEqual(["orders_by_day", "revenue_by_month"]);
      expect(await statuses(instance)).toEqual({
        revenue_by_month: "ready",
        refunds_by_month: "unknown"
      });
      expect(await auditEvents(instance)).toMatchObject([
        {
          type: "connection.discovered",
          status: "success",
          metadata: { connectionName: "outside", operationCount: 2, leftOutCount: 0 }
        }
      ]);
    } finally {
      await instance.close();
    }
  });
});
