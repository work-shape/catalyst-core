import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createClientInstanceApp, createToolDefinitions } from "@vivd-catalyst/client-assembly";
import { defineConfiguredTool, defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";

describe("client assembly configured tools", () => {
  it("creates executable tools from release-config parameters", () => {
    const tools = createToolDefinitions({
      config: createTestConfig({
        tools: [
          {
            name: "demo.configured",
            enabled: true,
            config: {
              permissionRef: "configured-tools",
              descriptionSuffix: "from config"
            }
          }
        ]
      }),
      tools: [configuredToolFactory]
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "demo.configured",
      description: "Configured demo tool from config",
      permission: {
        mode: "allow",
        requiredPermissionRefs: ["configured-tools"]
      }
    });
  });

  it("rejects invalid configured tool parameters", () => {
    expect(() =>
      createToolDefinitions({
        config: createTestConfig({
          tools: [
            {
              name: "demo.configured",
              enabled: true,
              config: {
                permissionRef: ""
              }
            }
          ]
        }),
        tools: [configuredToolFactory]
      })
    ).toThrow(/Config for tool 'demo.configured' is invalid/u);
  });

  it("rejects capability config without a registered implementation", async () => {
    await expect(
      createClientInstanceApp({
        config: createTestConfig({
          tools: [],
          capabilities: {
            misspelledCapability: { enabled: true }
          }
        }),
        tools: [],
        capabilities: [],
        storeMode: "memory",
        env: {}
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Capability config has no registered implementation: misspelledCapability"
    });
  });
});

const configuredToolFactory = defineConfiguredTool({
  name: "demo.configured",
  configSchema: z.object({
    permissionRef: z.string().min(1).default("demo-tools"),
    descriptionSuffix: z.string().min(1).default("default")
  }),
  create(config) {
    return defineTool({
      name: "demo.configured",
      description: `Configured demo tool ${config.descriptionSuffix}`,
      inputSchema: z.object({ text: z.string() }),
      permission: {
        mode: "allow",
        requiredPermissionRefs: [config.permissionRef]
      },
      execute(input) {
        return toolSuccess({ text: input.text });
      }
    });
  }
});

function createTestConfig(input: {
  tools: Array<{
    name: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
  capabilities?: Record<string, unknown>;
}) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "demo-local",
      displayName: "Demo",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    capabilities: input.capabilities,
    tools: input.tools
  });
}
