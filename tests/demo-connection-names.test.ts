import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadClientInstanceConfigFromFile } from "@work-shape/catalyst-config-schema";
import { connectionOperationName, isDataToolName } from "@work-shape/catalyst-core";
import { outputSchemas } from "@work-shape/catalyst-demo/sample-mcp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTION = "sample-business";

/** The tool names of the demo's agent, as its working copy lists them. */
function agentToolNames(): string[] {
  const text = readFileSync(
    resolve(root, "clients/demo/agents/workflow-assistant.agent.yaml"),
    "utf8"
  );
  const list = /^toolNames:\n((?: {2}- \S+\n)+)/mu.exec(text)?.[1] ?? "";
  return Array.from(list.matchAll(/^ {2}- (\S+)$/gmu), (match) => match[1] ?? "");
}

describe("the demo's Connection and the names its agent carries", () => {
  it("accepts the six tools of the sample server, reading, for agents and Pages", async () => {
    const config = await loadClientInstanceConfigFromFile(
      resolve(root, "clients/demo/config/app.yaml")
    );
    expect(config.modules.connections?.enabled).toBe(true);
    const connection = config.connections[CONNECTION];
    expect(connection).toMatchObject({
      connectorType: "mcp",
      displayName: "Sample business",
      authScheme: "bearer",
      secret: "DEMO_SAMPLE_MCP_KEY",
      settings: { url: "http://sample-mcp:8787/mcp" }
    });
    // The accepted list is the list of tools the sample server registers, no more and no less.
    expect(connection?.operations.map(({ name }) => name).sort()).toEqual(
      Object.keys(outputSchemas).sort()
    );
    for (const operation of connection?.operations ?? []) {
      expect(operation).toMatchObject({ effect: "reading", exposure: ["agent", "bridge"] });
      expect(operation.schemaFingerprint).toBeUndefined();
    }
    expect(config.secretStore.keys).toEqual([{ id: "local", ref: "DEMO_SECRET_STORE_KEY" }]);
    // One target, by its exact service name and port, and private.
    expect(config.egress.allow).toHaveLength(1);
    expect(config.egress.allow[0]).toMatchObject({
      protocol: "http",
      host: "sample-mcp",
      port: 8787,
      network: "private"
    });
  });

  it("gives the agent exactly the accepted operations, under the names the platform builds", () => {
    const carried = agentToolNames().filter(isDataToolName);
    expect(carried.sort()).toEqual(
      Object.keys(outputSchemas)
        .map((operation) => connectionOperationName(CONNECTION, operation))
        .sort()
    );
  });
});
