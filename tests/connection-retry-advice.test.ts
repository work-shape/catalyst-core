import { afterEach, describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  createHttpApiConnectorType,
  createMcpConnectorType,
  openConnectorContext
} from "@work-shape/catalyst-connections";
import { JobDeferredError } from "@work-shape/catalyst-core";
import { loopbackEgress } from "./support/mcp-test-server";
import { startRestTestServer, status, type RestTestServer } from "./support/rest-test-server";

const servers: RestTestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function call(header: string, connectorType = "http_api") {
  const server = await startRestTestServer(status(429, { "retry-after": header }));
  servers.push(server);
  const type = connectorType === "mcp" ? createMcpConnectorType() : createHttpApiConnectorType();
  const context = await openConnectorContext({
    type,
    connection: {
      id: "retry-advice",
      revision: 1,
      config: connectionConfigSchema.parse({
        name: "retry-advice",
        displayName: "Retry advice",
        ownerPrincipalId: "system",
        origin: "release",
        connectorType,
        enabled: true,
        authScheme: "none",
        settings:
          connectorType === "mcp"
            ? { url: `http://rest.example.test:${server.port}` }
            : { baseUrl: `http://rest.example.test:${server.port}` },
        operations: [
          {
            name: "read",
            effect: "reading",
            exposure: ["workflow"],
            enabled: true,
            method: "GET",
            path: "/items",
            description: "Read items"
          }
        ]
      })
    },
    egress: loopbackEgress([{ host: "rest.example.test", port: server.port }]).checker,
    credentials: {
      resolve: async () => {
        throw new Error("An unauthenticated call needs no credential");
      },
      resolveSignIn: async () => {
        throw new Error("An unauthenticated call needs no sign-in");
      }
    },
    signal: new AbortController().signal
  });
  return type.execute("read", {}, context);
}

describe("source retry advice at the connector boundary", () => {
  it.each(["http_api", "mcp"])(
    "retains numeric advice from %s without the source header",
    async (connectorType) => {
      await expect(call("7", connectorType)).rejects.toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "upstream_rate_limited", retryAfterSeconds: 7 }
      });
    }
  );
  it("accepts an HTTP date", async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    try {
      await call(date);
      throw new Error("The call should fail");
    } catch (error) {
      expect(error).toMatchObject({ details: { retryAfterSeconds: expect.any(Number) } });
    }
  });
  it.each(["garbage", "-1", "1.5", "1".repeat(129)])(
    "discards malformed advice %s",
    async (header) => {
      await expect(call(header)).rejects.toMatchObject({
        details: { reason: "upstream_rate_limited" }
      });
      await expect(call(header)).rejects.not.toHaveProperty("details.retryAfterSeconds");
    }
  );
  it.each([-1, Infinity, NaN])("refuses an invalid deferred job delay %s", (delay) => {
    expect(() => new JobDeferredError(delay)).toThrow(RangeError);
  });
});
