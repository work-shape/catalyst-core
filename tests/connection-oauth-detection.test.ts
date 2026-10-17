import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEgressChecker, createMcpConnectorType } from "@work-shape/catalyst-connections";
import type { ConnectorContext } from "@work-shape/catalyst-core";

// CS-4b2, Flow 1 and 2 of the shared OAuth sign-in and check 51 of connections-and-secrets.md:
// `connections.test` of an `mcp` Connection answers `oauth_required` when the server refuses
// with a Bearer challenge and describes its sign-in, by the challenge's `resource_metadata` or
// at the path well-known place of RFC 9728. A refusal that describes no sign-in for this
// server stays `unauthorized`: the key was refused. (The first case is the verifier's probe.)

interface Answer {
  challenge?: string;
  /** Protected Resource Metadata at the path well-known place, or nothing there. */
  metadata?: { resource: string; authorization_servers?: string[] };
}

let answer: Answer = {};
const asked: string[] = [];
let base = "";
let close: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push(path);
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      if (answer.metadata !== undefined && path === "/.well-known/oauth-protected-resource/mcp") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(answer.metadata));
      } else {
        response.writeHead(404).end();
      }
      return;
    }
    response
      .writeHead(
        401,
        answer.challenge === undefined ? {} : { "www-authenticate": answer.challenge }
      )
      .end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(() => close());

beforeEach(() => {
  asked.length = 0;
});

async function tested(next: Answer): Promise<string> {
  answer = next;
  const url = `${base}/mcp`;
  const egress = createEgressChecker({
    allow: [
      {
        protocol: "http",
        host: "127.0.0.1",
        port: Number(new URL(base).port),
        network: "private",
        cidrs: ["127.0.0.1/32"]
      }
    ]
  });
  const type = createMcpConnectorType();
  const target = await egress.check(type.target({ url }));
  const context: ConnectorContext = {
    connection: {
      id: "c",
      name: "sample",
      revision: 1,
      settings: { url },
      authScheme: "none",
      operations: []
    },
    target,
    checkEgress: (asked) => egress.check(asked),
    credentialFor: () => undefined,
    signal: AbortSignal.timeout(5000)
  };
  return (await type.test(context)).status;
}

const signIn = (resource: string) => ({
  resource,
  authorization_servers: ["https://auth.example.test"]
});

describe("an mcp Connection's test", () => {
  it("asks for a sign-in on a bare Bearer challenge when the path well-known metadata describes one", async () => {
    expect(await tested({ challenge: "Bearer", metadata: signIn(`${base}/mcp`) })).toBe(
      "oauth_required"
    );
    expect(
      await tested({ challenge: 'Bearer error="invalid_token"', metadata: signIn(base) })
    ).toBe("oauth_required");
  });

  it("asks for a sign-in where the challenge names the metadata", async () => {
    expect(
      await tested({
        challenge: `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
      })
    ).toBe("oauth_required");
  });

  it("keeps a refused key a refused key", async () => {
    // No challenge at all: no metadata is asked for.
    expect(await tested({ metadata: signIn(`${base}/mcp`) })).toBe("unauthorized");
    expect(asked.filter((path) => path.startsWith("/.well-known/"))).toEqual([]);
    // A Bearer challenge, but nothing describes a sign-in.
    expect(await tested({ challenge: 'Bearer realm="api"' })).toBe("unauthorized");
    // Metadata of another resource, or without an authorization server.
    expect(
      await tested({ challenge: "Bearer", metadata: signIn("https://other.example.test/mcp") })
    ).toBe("unauthorized");
    expect(await tested({ challenge: "Bearer", metadata: { resource: `${base}/mcp` } })).toBe(
      "unauthorized"
    );
  });
});
