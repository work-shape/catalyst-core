import { afterEach, describe, expect, it } from "vitest";
import { createHttpApiConnectorType } from "@work-shape/catalyst-connections";
import {
  type ConnectionOperationConfig,
  type ConnectorContext,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";

// Exercise the connector boundary over real HTTP without a store: the context stands for
// an already authorized call with no credential, pinned to this test's own server.
const connector = createHttpApiConnectorType();
/** Ends a broken test request without leaving a socket open. */
const TEST_CALL_TIMEOUT_MS = 5_000;
const operation: ConnectionOperationConfig = {
  name: "list_postings",
  description: "Reads postings matching every filter, in pages.",
  method: "GET",
  path: "/accounting/postings",
  effect: "reading",
  exposure: ["workflow"],
  enabled: true,
  query: {
    filter: { schema: { type: "array", items: { type: "string" } } },
    page: { schema: { type: "integer" } },
    page_size: { schema: { type: "integer" } }
  }
};

const servers: RestTestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(schema?: JsonObject) {
  const server = await startRestTestServer(json([]));
  servers.push(server);
  const declared = schema ? { ...operation, query: { filter: { schema } } } : operation;
  const baseUrl = `http://127.0.0.1:${server.port}/rest`;
  const context: ConnectorContext = {
    connection: {
      id: "array-query",
      name: "array-query",
      revision: 1,
      settings: { baseUrl },
      authScheme: "none",
      operations: [declared]
    },
    target: {
      protocol: "http",
      host: "127.0.0.1",
      port: server.port,
      address: "127.0.0.1",
      family: 4,
      network: "private"
    },
    checkEgress: () => Promise.reject(new Error("No further target is expected")),
    credentialFor: () => undefined,
    signal: AbortSignal.timeout(TEST_CALL_TIMEOUT_MS)
  };
  return {
    server,
    baseUrl,
    execute: (input: JsonValue) => connector.execute(declared.name, input, context)
  };
}

describe("http_api array query parameters", () => {
  it("sends repeated filters in input order beside scalar paging parameters", async () => {
    const w = await setup();
    expect(
      await w.execute({
        filter: ["client_id eq 1234", "fiscal_year gte 20260101"],
        page: 1,
        page_size: 100
      })
    ).toEqual({ items: [] });
    expect(w.server.requests.map(({ url }) => url)).toEqual([
      "/rest/accounting/postings?filter=client_id+eq+1234&filter=fiscal_year+gte+20260101&page=1&page_size=100"
    ]);
  });

  it("encodes delimiters and preserves duplicates and empty strings", async () => {
    const w = await setup();
    await w.execute({ filter: ["a&b=c#d", "", "a&b=c#d"] });
    expect(w.server.requests.map(({ url }) => url)).toEqual([
      "/rest/accounting/postings?filter=a%26b%3Dc%23d&filter=&filter=a%26b%3Dc%23d"
    ]);
  });

  it("omits absent, null and empty arrays, and accepts more than 32 short values", async () => {
    const w = await setup();
    const omitted: JsonValue[] = [{}, { filter: null }, { filter: [] }];
    for (const input of omitted) await w.execute(input);
    await w.execute({ filter: Array.from({ length: 100 }, (_, i) => String(i)) });
    expect(w.server.requests.slice(0, 3).map(({ url }) => url)).toEqual(
      Array.from({ length: 3 }, () => "/rest/accounting/postings")
    );
    expect(
      new URL(w.server.requests[3]?.url ?? "", "http://test").searchParams.getAll("filter")
    ).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  });

  it.each(["array", "scalar"])(
    "bounds the final encoded URL at 8000 bytes for %s values before sending",
    async (kind) => {
      const w = await setup(
        kind === "array" ? { type: "array", items: { type: "string" } } : { type: "string" }
      );
      const preceding = kind === "array" ? Array.from({ length: 40 }, () => "é&") : [];
      const url = new URL(`${w.baseUrl}${operation.path}`);
      for (const value of [...preceding, "é&"]) url.searchParams.append("filter", value);
      const value = "é&" + "x".repeat(8_000 - Buffer.byteLength(url.href, "utf8"));
      const input = (last: string) => ({ filter: kind === "array" ? [...preceding, last] : last });

      expect(await w.execute(input(value))).toEqual({ items: [] });
      expect(w.server.requests).toHaveLength(1);
      const sentUrl = new URL(w.server.requests[0]?.url ?? "", w.baseUrl);
      expect(Buffer.byteLength(sentUrl.href, "utf8")).toBe(8_000);
      await expect(w.execute(input(value + "x"))).rejects.toMatchObject({
        message: expect.stringContaining("HTTP_API_REQUEST_URL_MAX_BYTES (8000 bytes)"),
        details: { reason: "input_invalid" }
      });
      expect(w.server.requests).toHaveLength(1);
    }
  );

  it.each(["integer", "number", "boolean"])(
    "serializes %s items as repeated values",
    async (type) => {
      const w = await setup({ type: "array", items: { type } });
      const values =
        type === "boolean" ? [true, false] : type === "number" ? [0, -2, 3.5] : [0, -2, 3];
      await w.execute({ filter: values });
      expect(
        new URL(w.server.requests[0]?.url ?? "", "http://test").searchParams.getAll("filter")
      ).toEqual(values.map(String));
    }
  );

  it("refuses objects, nested arrays, null items and non-finite items before sending", async () => {
    const w = await setup();
    const invalid: JsonValue[] = [
      {},
      [{}],
      [["nested"]],
      [null],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      "scalar"
    ];
    for (const filter of invalid) {
      await expect(w.execute({ filter })).rejects.toMatchObject({
        details: { reason: "input_invalid" }
      });
    }
    expect(w.server.requests).toEqual([]);
  });

  it("refuses an array for a scalar declaration", async () => {
    const w = await setup({ type: "string" });
    await expect(w.execute({ filter: ["a", "b"] })).rejects.toMatchObject({
      details: { reason: "input_invalid" }
    });
    expect(w.server.requests).toEqual([]);
  });

  it("accepts scalar item declarations without adding a cap to the input schema", () => {
    const declared = connector.declared;
    if (!declared) throw new Error("http_api declares its operations");
    for (const type of ["string", "integer", "number", "boolean"]) {
      const candidate = {
        ...operation,
        query: { filter: { schema: { type: "array", items: { type } } } }
      };
      expect(declared.issues(candidate)).toEqual([]);
      expect(declared.describe(candidate).inputSchema.properties).toEqual({
        filter: { type: "array", items: { type } }
      });
    }
    for (const maxItems of [2, 64]) {
      expect(
        declared.describe({
          ...operation,
          query: { filter: { schema: { type: "array", items: { type: "string" }, maxItems } } }
        }).inputSchema
      ).toMatchObject({ properties: { filter: { maxItems } } });
    }
  });

  it("refuses non-scalar or missing items at save and keeps arrays out of path parameters", () => {
    const declared = connector.declared;
    if (!declared) throw new Error("http_api declares its operations");
    const invalidItems: JsonValue[] = [
      { type: "object" },
      { type: "array", items: { type: "string" } },
      {},
      true,
      [{ type: "string" }],
      { type: ["string", "null"] }
    ];
    for (const items of invalidItems) {
      expect(
        declared.issues({ ...operation, query: { filter: { schema: { type: "array", items } } } })
      ).toContainEqual(expect.objectContaining({ path: ["query", "filter", "schema", "items"] }));
    }
    expect(
      declared.issues({ ...operation, query: { filter: { schema: { type: "array" } } } })
    ).toContainEqual(expect.objectContaining({ path: ["query", "filter", "schema", "items"] }));
    expect(
      declared.issues({
        ...operation,
        path: "/{id}",
        pathParams: { id: { schema: { type: "array", items: { type: "string" } } } }
      })
    ).toContainEqual(expect.objectContaining({ path: ["pathParams", "id", "schema", "type"] }));
  });
});
