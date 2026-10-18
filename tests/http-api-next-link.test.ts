import { afterEach, expect, it } from "vitest";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import { createHttpApiConnectorType, openConnectorContext } from "@work-shape/catalyst-connections";
import { loopbackEgress } from "./support/mcp-test-server";
import { startRestTestServer, json, type RestTestServer } from "./support/rest-test-server";
import { connection } from "./support/connections";

let server: RestTestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
it("keeps next links on the checked origin and base path, including encoded path variants", async () => {
  server = await startRestTestServer(json({ items: [] }));
  const type = createHttpApiConnectorType();
  const host = "paging.example.test";
  const base = `http://${host}:${server.port}/rest`;
  const config = connectionConfigSchema.parse(
    connection("paging", {
      connectorType: "http_api",
      settings: { baseUrl: base },
      authScheme: "none",
      operations: [
        {
          name: "read",
          effect: "reading",
          method: "GET",
          path: "/items",
          description: "Read",
          exposure: ["workflow"]
        }
      ]
    })
  );
  const context = await openConnectorContext({
    type,
    connection: { id: "test", revision: 1, config },
    egress: loopbackEgress([{ host, port: server.port }]).checker,
    credentials: {
      resolveSignIn: async () => {
        throw new Error("No sign-in expected");
      },
      resolve: async () => {
        throw new Error("No credential expected");
      }
    },
    signal: new AbortController().signal
  });
  await type.execute("read", {}, { ...context, pageAddress: `${base}/items?page=2` });
  expect(server.requests.map((request) => request.url)).toEqual(["/rest/items?page=2"]);
  for (const pageAddress of [
    "http://other.example/rest/items",
    `${base}/../outside`,
    `${base}-other/items`,
    `${base}/%252e%252e/outside`,
    `${base}/%2f..%2foutside`,
    `${base}/items#fragment`,
    "https://["
  ]) {
    await expect(type.execute("read", {}, { ...context, pageAddress })).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
  }
  expect(server.requests).toHaveLength(1);
});

it("resolves RFC 3986 continuations against the current nested page, reporting its checked address", async () => {
  server = await startRestTestServer(json({ items: [] }));
  const type = createHttpApiConnectorType();
  const host = "relative-paging.example.test";
  const base = `http://${host}:${server.port}/rest`;
  const config = connectionConfigSchema.parse(
    connection("paging", {
      connectorType: "http_api",
      settings: { baseUrl: base },
      authScheme: "none",
      operations: [
        {
          name: "read",
          effect: "reading",
          method: "GET",
          path: "/nested/items",
          description: "Read",
          exposure: ["workflow"]
        }
      ]
    })
  );
  const context = await openConnectorContext({
    type,
    connection: { id: "test", revision: 1, config },
    egress: loopbackEgress([{ host, port: server.port }]).checker,
    credentials: {
      resolveSignIn: async () => {
        throw new Error("No sign-in expected");
      },
      resolve: async () => {
        throw new Error("No credential expected");
      }
    },
    signal: new AbortController().signal
  });
  let current: string | undefined;
  const notePageAddress = (address: string) => {
    current = address;
  };
  await type.execute("read", {}, { ...context, notePageAddress });
  expect(current).toBe(`${base}/nested/items`);
  for (const [pageAddress, expected] of [
    ["?page=2", "/rest/nested/items?page=2"],
    ["pages/3", "/rest/nested/pages/3"],
    ["4", "/rest/nested/pages/4"],
    ["../items?page=5", "/rest/nested/items?page=5"]
  ]) {
    await type.execute(
      "read",
      {},
      { ...context, pageAddress, previousPageAddress: current, notePageAddress }
    );
    expect(server.requests.at(-1)?.url).toBe(expected);
    expect(current).toBe(`http://${host}:${server.port}${expected}`);
  }
  for (const pageAddress of [
    "../../../outside",
    "//other.example/rest/items",
    "%252e%252e/outside"
  ]) {
    await expect(
      type.execute("read", {}, { ...context, pageAddress, previousPageAddress: current })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  expect(server.requests).toHaveLength(5);
});
