import { afterEach, describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { randomUUID } from "node:crypto";
import {
  asAgentRunId,
  asClientInstanceId,
  asToolCallId,
  asUserId,
  createPlatformId,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { createAppActionOperationSource } from "@work-shape/catalyst-server";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { required } from "./support/assertions";
import { auditEvents, runJobs, statuses, storedState } from "./support/connection-discovery-world";
import { createTestConfig } from "./support/fixtures";
import { startMcpTestServer, tool, type McpTestServer } from "./support/mcp-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { createTestInstance, getTestExecution } from "./support/test-instance";

// The discovery job with the platform's own `mcp` Connector type and a server that speaks
// the protocol: the type's `discover` is what the job calls, and what the server lists is
// what the catalog holds. It fails without the job: nothing asked the server for its tools,
// and an accepted operation of an MCP Connection stayed `awaiting_discovery`.

describe("the discovery of an MCP Connection", () => {
  const servers: McpTestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("discovers MCP reads and confirms calls from marked conversations", async () => {
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
    const env = { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), OUTSIDE_MCP_KEY: key };
    const instance = await createTestInstance({
      config,
      env,
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

      // A genuine MCP-discovered reading operation still sends arguments to its host.
      const clientInstanceId = asClientInstanceId(config.clientInstance.id);
      const me = await instance.call("me.get");
      const actor: AuthenticatedUser = {
        id: me.json<{ id: string }>().id,
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["superadmin"],
        permissionRefs: [],
        authSource: "test",
        clientInstanceId
      };
      const workspace = await instance.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(actor.id)
      });
      const chat = await instance.stores.conversations.createConversation({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        createdByUserId: actor.id,
        createdByExternalUserId: actor.externalUserId,
        visibility: "private",
        title: "MCP privacy",
        retainedUntil: "2099-01-01T00:00:00.000Z"
      });
      const worker = await createTestInstance({
        execution: {
          config,
          env,
          tools: []
        }
      });
      const calls = getTestExecution(worker).operationCalls;
      const operation = "connection.outside.revenue_by_month";
      let settings: CentralPolicySetting[] = [{ operation, value: "allow" }];
      const runId = asAgentRunId("mcp-personal-data-check");
      const call = () =>
        runOperation(
          {
            operation,
            effect: "reading",
            input: { month: "private-canary" },
            actor,
            origin: {
              kind: "agent",
              agentName: "test_agent",
              agentRunId: runId,
              conversationId: chat.id,
              toolCallId: asToolCallId(randomUUID()),
              toolName: operation
            },
            correlationId: randomUUID()
          },
          {
            ...calls.deps,
            agentToolNames: () => [operation],
            policy: { ...calls.deps.policy, centralSettings: () => settings }
          },
          {
            runFence: {
              runId,
              lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
            }
          }
        );
      const publishedConfig = {
        manifest: {
          actions: [
            {
              kind: "connection",
              name: "load",
              file: "actions/load.action.yaml",
              description: "Read",
              effect: "reading",
              connection: "outside",
              operation: "revenue_by_month",
              input: {
                schema: { type: "object", properties: { month: { type: "string" } } },
                mapping: { month: "{{month}}" }
              }
            }
          ]
        }
      };
      const app: ConfigAssetRecord = {
        id: "privacy",
        clientInstanceId,
        kind: "app",
        name: "privacy",
        scope: { kind: "workspace", workspaceId: workspace.id },
        status: "active",
        activeRevisionId: "published",
        publishedRevisionId: "published",
        revision: 1,
        config: publishedConfig,
        publishedConfig,
        createdAt: chat.createdAt,
        updatedAt: chat.createdAt
      };
      const action = required(
        await createAppActionOperationSource({
          ...calls.deps,
          modules: { isEnabled: () => true },
          clientInstanceId,
          store: { getConfigAsset: async () => app, listPublishedConfigAssets: async () => [] }
        }).resolve("app.privacy.load")
      );
      const actionOrigin = {
        kind: "agent" as const,
        agentName: "test_agent",
        agentRunId: runId,
        conversationId: chat.id,
        toolCallId: asToolCallId("action"),
        toolName: "app.privacy.load"
      };
      expect(
        await action.policyFloorOf?.(actionOrigin, { month: "private-canary" })
      ).toBeUndefined();
      expect((await call()).result.status).toBe("done");
      const before = server.rpc("tools/call").length;
      expect(before).toBe(1);
      await instance.stores.conversations.markPersonalData({
        clientInstanceId,
        conversationId: chat.id,
        userId: actor.id,
        at: new Date().toISOString()
      });
      expect(
        await worker.stores.conversations.getConversation(clientInstanceId, chat.id)
      ).toMatchObject({ personalDataAt: expect.any(String) });
      const resolved = required(await calls.registry.resolve(operation));
      expect(resolved.policyFloorOf).toBeTypeOf("function");
      expect(
        await resolved.policyFloorOf?.(
          {
            kind: "agent",
            agentName: "test_agent",
            agentRunId: runId,
            conversationId: chat.id,
            toolCallId: asToolCallId("check"),
            toolName: operation
          },
          {}
        )
      ).toBe("confirm");
      expect(await action.policyFloorOf?.(actionOrigin, { month: "private-canary" })).toBe(
        "confirm"
      );
      expect((await call()).result.status).toBe("pending_confirmation");
      settings = [{ operation, value: "deny" }];
      expect((await call()).result.status).toBe("denied");
      expect(server.rpc("tools/call")).toHaveLength(before);
      await worker.close();
    } finally {
      await instance.close();
    }
  });
});
