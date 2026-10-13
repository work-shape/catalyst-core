import { describe, expect, it } from "vitest";
import { safeConfigSchema } from "@vivd-catalyst/api-contract";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig,
  type SafeConfigConnection
} from "@vivd-catalyst/config-schema";

// An agent list tells each agent's Connections, so that a conversation can say what a tool
// call touched: the name people read, the icon and the tools of it the agent holds. Nothing
// else of a Connection travels, and nothing of a Connection the agent holds no tool of.

const connections: SafeConfigConnection[] = [
  {
    name: "books",
    title: "Books",
    service: "ledger",
    connectorType: "mcp",
    tools: [
      { toolName: "connection.books.list_invoices", effect: "reading" },
      { toolName: "connection.books.book_invoice", effect: "changing" }
    ]
  },
  {
    name: "store",
    title: "Store",
    connectorType: "postgres",
    tools: [{ toolName: "connection.store.orders", effect: "reading" }]
  }
];

function view(toolNames: string[], given?: SafeConfigConnection[]) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: { id: "connections-test", displayName: "Test", environment: "development" },
    auth: { development: { enabled: true, user: { permissionRefs: [] } } },
    localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
  });
  const assets = {
    version: 1,
    defaultAgentName: "agent",
    agents: [
      agentConfigSchema.parse({
        name: "agent",
        displayName: "Agent",
        instructions: "Help.",
        toolNames
      })
    ],
    skills: []
  };
  return createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
    requestedLocale: "en",
    ...(given === undefined ? {} : { connections: given })
  });
}

describe("the Connections an agent list names", () => {
  it("names a Connection for an agent with the tools of it the agent holds", () => {
    const safe = view(["connection.books.list_invoices", "workspace.read_file"], connections);
    expect(safe.agents[0]?.connections).toEqual([
      {
        name: "books",
        title: "Books",
        service: "ledger",
        connectorType: "mcp",
        tools: [{ toolName: "connection.books.list_invoices", effect: "reading" }]
      }
    ]);
    expect(safeConfigSchema.safeParse(safe).success).toBe(true);
  });

  it("names none for an agent that holds no tool of a Connection, and none unasked", () => {
    expect(view(["workspace.read_file"], connections).agents[0]?.connections).toEqual([]);
    expect(view(["connection.books.list_invoices"]).agents[0]?.connections).toEqual([]);
  });
});
