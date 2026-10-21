import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAgentYaml } from "@work-shape/catalyst-cli";
import {
  loadClientInstanceConfigFromFile,
  releaseConnectionConfigSchema
} from "@work-shape/catalyst-config-schema";
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
    const connection = releaseConnectionConfigSchema.parse(config.connections[CONNECTION]);
    expect(connection).toMatchObject({
      connectorType: "mcp",
      displayName: "Sample business",
      authScheme: "bearer",
      secret: "DEMO_SAMPLE_MCP_KEY",
      settings: { url: "http://sample-mcp:8787/mcp" }
    });
    // The accepted list is the list of tools the sample server registers, no more and no less.
    expect(connection.operations.map(({ name }) => name).sort()).toEqual(
      Object.keys(outputSchemas).sort()
    );
    for (const operation of connection.operations) {
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

// ACCEPT-2e C-2: the demo's agent was told to call a skill an "instruction" or "rule" and to say
// every change waits for approval, against the platform's orientation and the skill page. It
// now calls a skill a Skill and says what a save does from the read's saveApproval.
describe("the demo's agent on what a skill change does", () => {
  const { instructions, toolNames } = parseAgentYaml(
    readFileSync(resolve(root, "clients/demo/agents/workflow-assistant.agent.yaml"), "utf8")
  );
  const learning = instructions.slice(instructions.indexOf("## Learning"));

  it("calls a skill a skill, never an instruction or a rule", () => {
    expect(instructions).toContain("## Learning");
    expect(learning).toContain("Call a skill a skill");
    expect(learning).not.toMatch(/Say “instruction”|rather than “skill”/u);
    expect(learning).not.toMatch(/shared instructions?\b|affected instruction|new instruction/u);
  });

  it("says what a save does from saveApproval, read first, never assumed", () => {
    expect(toolNames).toEqual(expect.arrayContaining(["read_skill", "platform.assets.get"]));
    expect(learning).toContain("saveApproval.approverNames");
    expect(learning).toContain(
      "without saveApproval, a save the user may make takes effect immediately"
    );
    expect(learning).not.toContain("that approval is still needed");
  });

  // PR-382 L3: read_skill reads only the agent's own skills; the agent was sent to it for every
  // skill and failed on one it does not hold.
  it("reads a skill it does not hold with the asset read, not with read_skill", () => {
    expect(learning).toContain("Read your skill with read_skill first.");
    expect(learning).toContain(
      "Read any other skill with platform.assets.get, naming kind skill and its name"
    );
    expect(learning).not.toContain("Read the affected skill with read_skill first.");
  });
});
