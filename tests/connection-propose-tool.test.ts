import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES, platformModules } from "@work-shape/catalyst-client-assembly";
import {
  createHttpApiConnectorType,
  createMcpConnectorType
} from "@work-shape/catalyst-connections";
import {
  asClientInstanceId,
  createConnectorTypeRegistry,
  createModuleRegistry,
  isJsonObject,
  type ConnectorTypeDefinition,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  CONNECTION_PROPOSE_TOOL_NAME,
  createConnectionProposeTool,
  ToolRegistry
} from "@work-shape/catalyst-tool-execution";

// The agent's proposal of a new Connection (CHAT-CONN-1): the tool checks the type, the id, the
// name and the address as a save would, and answers the proposal the card shows, or every issue
// and no card. A proposal has no field for a key, and an address that could carry one is
// refused; the audit record names the id and the type, never the address.

/** A text that stands for a key. No answer or audit record below may repeat it. */
const SECRET = "sk-live-9f8e7d6c5b4a";

/** A type with a form of its own, as a deployment's Connector type would be. */
const typedConnector: ConnectorTypeDefinition = {
  ...createHttpApiConnectorType(),
  type: "e2e_typed"
};

const tool = createConnectionProposeTool({
  connectorTypes: createConnectorTypeRegistry([
    createMcpConnectorType(),
    createHttpApiConnectorType(),
    typedConnector
  ])
});

function context(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("connection-propose-client");
  return {
    clientInstanceId,
    correlationId: "corr_connection_propose",
    user: {
      id: "user-connection-propose",
      externalUserId: "user-connection-propose",
      displayLabel: "Propose User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectorType: "mcp",
    connection: "brain",
    title: "Brain",
    url: "https://brain.example.test/mcp",
    ...overrides
  };
}

/** Runs the tool as the runtime does: the input through its schema, the answer through its. */
async function run(input: Record<string, unknown>) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" as const, issues: parsed.error.issues };
  const result = await tool.execute(parsed.data, context());
  if (result.status === "success" && tool.outputSchema) {
    return { ...result, output: tool.outputSchema.parse(result.output) };
  }
  return result;
}

/** The issues of a refused proposal, as `path` or `path:code`. */
async function refusals(input: Record<string, unknown>): Promise<string[]> {
  const result = await run(input);
  if (result.status !== "failed") throw new Error(`Expected a refusal, got ${result.status}`);
  expect(result.error.code).toBe("validation_failed");
  expect(JSON.stringify(result)).not.toContain(SECRET);
  const details = result.error.details;
  const issues = isJsonObject(details) ? details.issues : undefined;
  if (!Array.isArray(issues)) throw new Error("A refusal names its issues");
  return issues.map((issue) => {
    if (!isJsonObject(issue)) return "";
    const code = typeof issue.code === "string" ? `:${issue.code}` : "";
    return `${String(issue.path)}${code}`;
  });
}

describe("the agent's proposal of a new Connection", () => {
  it("answers an MCP server's proposal with the key header's name, and audits no address", async () => {
    const result = await run(proposal({ keyHeader: "x-brain-key" }));
    if (result.status !== "success") throw new Error(`Expected a proposal, got ${result.status}`);
    expect(result.output).toEqual({
      connection: {
        connectorType: "mcp",
        name: "brain",
        title: "Brain",
        url: "https://brain.example.test/mcp",
        keyHeader: "x-brain-key",
        headerNames: []
      }
    });
    expect(result.auditSummary).toEqual({
      action: CONNECTION_PROPOSE_TOOL_NAME,
      subject: "brain",
      metadata: { connectorType: "mcp" }
    });
    expect(JSON.stringify(result.auditSummary)).not.toContain("example.test");
  });

  it("answers a REST API's proposal with its header names and test path", async () => {
    const result = await run(
      proposal({
        connectorType: "http_api",
        connection: "exampledata",
        title: "Exampledata",
        url: "https://api.exampledata.example.test",
        headerNames: ["x-client-instance-id"],
        testPath: "/me"
      })
    );
    if (result.status !== "success") throw new Error(`Expected a proposal, got ${result.status}`);
    expect(result.output).toMatchObject({
      connection: {
        connectorType: "http_api",
        headerNames: ["x-client-instance-id"],
        testPath: "/me"
      }
    });
  });

  it("answers another type with its id and name only: its form asks the rest", async () => {
    const result = await run({ connectorType: "e2e_typed", connection: "typed", title: "Typed" });
    if (result.status !== "success") throw new Error(`Expected a proposal, got ${result.status}`);
    expect(result.output).toEqual({
      connection: { connectorType: "e2e_typed", name: "typed", title: "Typed", headerNames: [] }
    });
    expect(
      await refusals({
        connectorType: "e2e_typed",
        connection: "typed",
        title: "Typed",
        url: "https://typed.example.test",
        keyHeader: "x-key"
      })
    ).toEqual(["url", "keyHeader"]);
  });

  it("refuses an address that could carry a key, or one that is not https", async () => {
    expect(
      await refusals(proposal({ url: `https://user:${SECRET}@brain.example.test/mcp` }))
    ).toContain("url:credential_in_url");
    expect(
      await refusals(proposal({ url: `https://brain.example.test/mcp?key=${SECRET}` }))
    ).toContain("url:credential_in_url");
    expect(await refusals(proposal({ url: `https://brain.example.test/mcp#${SECRET}` }))).toContain(
      "url:credential_in_url"
    );
    expect(await refusals(proposal({ url: "http://brain.example.test/mcp" }))).toContain("url");
    expect(await refusals(proposal({ url: "brain" }))).toEqual(["url"]);
    expect(await refusals(proposal({ url: undefined }))).toEqual(["url"]);
  });

  it("refuses a type the instance has not, a header that carries a key, and REST fields on MCP", async () => {
    expect(await refusals(proposal({ connectorType: "smtp" }))).toEqual(["connectorType"]);
    expect(
      await refusals(
        proposal({
          connectorType: "http_api",
          url: "https://api.example.test",
          headerNames: ["Authorization"]
        })
      )
    ).toContain("headerNames");
    expect(await refusals(proposal({ headerNames: ["x-tenant"], testPath: "/me" }))).toEqual([
      "headerNames",
      "testPath"
    ]);
    expect(await refusals(proposal({ keyHeader: "x key" }))).toContain("keyHeader");
    expect(await refusals(proposal({ connection: "Not An Id" }))).toContain("connection");
  });

  it("has no field for a key: one the agent adds is no part of the answer", async () => {
    const result = await run(proposal({ apiKey: SECRET, secret: SECRET }));
    expect(result.status).toBe("success");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("where the propose tool is offered", () => {
  const registryWith = (connections: boolean) =>
    new ToolRegistry({
      tools: [tool],
      enabledToolNames: new Set([CONNECTION_PROPOSE_TOOL_NAME]),
      modules: createModuleRegistry(platformModules).snapshot(
        Object.fromEntries(
          platformModules.map((module) => [
            module.name,
            { enabled: module.name !== "connections" || connections }
          ])
        )
      )
    });

  it("is a tool of the module connections: off with it, on with it", () => {
    expect(registryWith(false).has(CONNECTION_PROPOSE_TOOL_NAME)).toBe(false);
    expect(registryWith(true).has(CONNECTION_PROPOSE_TOOL_NAME)).toBe(true);
  });

  it("is no tool every agent may hold whatever the modules: an agent lists it by name", () => {
    expect(PLATFORM_TOOL_NAMES).not.toContain(CONNECTION_PROPOSE_TOOL_NAME);
  });
});
