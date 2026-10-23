import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpApiConnectorType,
  createMcpConnectorType
} from "@work-shape/catalyst-connections";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  createConnectorTypeRegistry,
  findConnectorTypeIssues,
  type ConnectionOperationConfig,
  type ConnectorContext,
  type JsonValue,
  type ResultShaper
} from "@work-shape/catalyst-core";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";

const servers: RestTestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
const operation: ConnectionOperationConfig = {
  name: "read",
  method: "GET",
  path: "/items",
  description: "Read sample items.",
  effect: "reading",
  enabled: true,
  exposure: ["agent"],
  query: { top: { schema: { type: "integer" }, sendAs: "$top" } }
};

async function world(result: JsonValue, registry: Record<string, ResultShaper> = {}) {
  const server = await startRestTestServer(json(result));
  servers.push(server);
  const type = createHttpApiConnectorType(registry);
  const context: ConnectorContext = {
    connection: {
      id: "test",
      name: "test",
      revision: 1,
      authScheme: "none",
      settings: { baseUrl: `http://127.0.0.1:${server.port}` },
      operations: []
    },
    target: {
      protocol: "http",
      host: "127.0.0.1",
      port: server.port,
      address: "127.0.0.1",
      family: 4,
      network: "private"
    },
    checkEgress: () => Promise.reject(new Error("No additional target")),
    credentialFor: () => undefined,
    signal: AbortSignal.timeout(5000)
  };
  return {
    server,
    execute(shaper?: string, input: JsonValue = {}) {
      const declared = { ...operation, ...(shaper === undefined ? {} : { shaper }) };
      return type.execute("read", input, {
        ...context,
        connection: { ...context.connection, operations: [declared] }
      });
    }
  };
}

describe("HTTP result shapers and query wire names", () => {
  it("gives a shaper exactly the parsed answer, and leaves a custom operation's JSON raw", async () => {
    const received: JsonValue[] = [];
    const w = await world([{ id: 1 }], {
      simplify: (...args) => {
        expect(args).toHaveLength(1);
        received.push(args[0]);
        return { count: Array.isArray(args[0]) ? args[0].length : 0 };
      }
    });
    expect(await w.execute("simplify")).toEqual({ count: 1 });
    expect(received).toEqual([[{ id: 1 }]]);
    expect(await w.execute()).toEqual({ items: [{ id: 1 }] });
    const object = await world({ envelope: { count: 2 } });
    expect(await object.execute()).toEqual({ envelope: { count: 2 } });
  });

  it("maps a throwing or missing shaper to output_invalid without leaking exception text", async () => {
    const w = await world(
      {},
      {
        fail: () => {
          throw new Error("private response data");
        }
      }
    );
    for (const name of ["fail", "absent", "toString"]) {
      await expect(w.execute(name)).rejects.toMatchObject({
        details: { reason: "output_invalid" }
      });
      await expect(w.execute(name)).rejects.not.toThrow("private response data");
    }
  });

  it("sends $top on the wire while the model sees only top", async () => {
    const w = await world({ items: [] });
    expect(await w.execute(undefined, { top: 3 })).toEqual({ items: [] });
    const url = new URL(w.server.requests[0]?.url ?? "", "http://sample");
    expect([...url.searchParams]).toEqual([["$top", "3"]]);
    expect(createHttpApiConnectorType().declared?.describe(operation).inputSchema).toMatchObject({
      properties: { top: { type: "integer" } }
    });
    expect(
      createHttpApiConnectorType().declared?.describe(operation).inputSchema.properties
    ).not.toHaveProperty("$top");
    await expect(w.execute(undefined, { $top: 3 })).rejects.toMatchObject({
      details: { reason: "input_invalid" }
    });
  });

  it("refuses an unregistered shaper at save and refuses sendAs on path parameters or duplicate wire names", () => {
    const type = createHttpApiConnectorType({ known: (result) => result });
    const registry = createConnectorTypeRegistry([type, createMcpConnectorType()]);
    const issues = (value: Partial<ConnectionOperationConfig>) =>
      findConnectorTypeIssues(registry, {
        connectorType: "http_api",
        authScheme: "none",
        settings: { baseUrl: "https://sample.example.test" },
        operations: [{ ...operation, ...value }]
      });
    expect(issues({ shaper: "known" })).toEqual([]);
    expect(issues({ shaper: "absent" })).toContainEqual(
      expect.objectContaining({ path: ["operations", 0, "shaper"] })
    );
    expect(
      issues({
        path: "/items/{id}",
        pathParams: { id: { schema: { type: "string" }, sendAs: "$id" } }
      })
    ).toContainEqual(
      expect.objectContaining({ message: "Only a query parameter may name sendAs" })
    );
    expect(
      issues({
        query: {
          top: { schema: { type: "integer" }, sendAs: "$top" },
          limit: { schema: { type: "integer" }, sendAs: "$top" }
        }
      })
    ).toContainEqual(expect.objectContaining({ message: "Query wire names must be unique" }));
    const config = {
      name: "sample",
      displayName: "Sample",
      connectorType: "http_api",
      ownerPrincipalId: "user-1",
      authScheme: "none",
      settings: { baseUrl: "https://sample.example.test" },
      operations: [{ ...operation, query: { $top: { schema: { type: "integer" } } } }],
      origin: "runtime"
    };
    expect(connectionConfigSchema.safeParse(config).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ ...config, operations: [operation] }).success).toBe(
      true
    );
  });
});
