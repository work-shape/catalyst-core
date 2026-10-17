import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressChecker,
  createOAuthFetch,
  issuersMatch,
  parseBearerChallenge,
  resourceAllowed,
  revokeToken,
  type OAuthServerMetadata
} from "@work-shape/catalyst-connections";
import { connectionCallReasonOf } from "@work-shape/catalyst-core";

// The parts of the OAuth port that need no instance (CS-4b2): the reading of a challenge, the
// comparisons of issuer and resource, the checked fetch every request of the flow goes
// through, and the revocation written by hand (RFC 7009).

describe("the Bearer challenge of WWW-Authenticate", () => {
  it("reads resource_metadata, the scopes and the error, beside other challenges", () => {
    expect(
      parseBearerChallenge(
        'Basic realm="x", Bearer error="invalid_token", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="files.read  files.read profile"'
      )
    ).toEqual({
      resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      scopes: ["files.read", "profile"],
      error: "invalid_token"
    });
    expect(parseBearerChallenge("Bearer")).toEqual({});
    expect(parseBearerChallenge('bearer resource_metadata="http://127.0.0.1:1/m"')).toEqual({
      resourceMetadataUrl: "http://127.0.0.1:1/m"
    });
  });

  it("reads nothing it should not trust", () => {
    expect(parseBearerChallenge(undefined)).toBeUndefined();
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    // A parameter twice makes the challenge unreadable.
    expect(parseBearerChallenge('Bearer scope="a", scope="b"')).toEqual({});
    // An address that is no web address, or carries credentials, is left out.
    expect(parseBearerChallenge('Bearer resource_metadata="file:///etc/passwd"')).toEqual({});
    expect(parseBearerChallenge('Bearer resource_metadata="https://u:p@x.test/m"')).toEqual({});
    expect(parseBearerChallenge(`Bearer scope="${"a".repeat(9000)}"`)).toBeUndefined();
    const many = Array.from({ length: 100 }, (_, index) => `s${index}`).join(" ");
    expect(parseBearerChallenge(`Bearer scope="${many}"`)?.scopes).toHaveLength(64);
    expect(parseBearerChallenge('Bearer scope="ok bad\\"quote"')?.scopes).toEqual(["ok"]);
  });
});

describe("the comparisons of the flow", () => {
  it("matches the issuer asked, with one trailing slash tolerated and nothing else", () => {
    expect(issuersMatch("https://api.box.com/", "https://api.box.com")).toBe(true);
    expect(issuersMatch("https://auth.example.test/t1", "https://auth.example.test/t1/")).toBe(
      true
    );
    expect(issuersMatch("https://auth.example.test/t1", "https://auth.example.test/t2")).toBe(
      false
    );
    expect(issuersMatch("https://auth.example.test//", "https://auth.example.test")).toBe(false);
    expect(issuersMatch("http://auth.example.test", "https://auth.example.test")).toBe(false);
    expect(issuersMatch("https://auth.example.test?x=1", "https://auth.example.test")).toBe(false);
    expect(issuersMatch("not an address", "https://auth.example.test")).toBe(false);
  });

  it("allows the resource of the Connection's own server and nothing beside it", () => {
    expect(resourceAllowed("https://mcp.example.test/mcp", "https://mcp.example.test/mcp")).toBe(
      true
    );
    expect(resourceAllowed("https://mcp.example.test", "https://mcp.example.test/v1/mcp")).toBe(
      true
    );
    expect(resourceAllowed("https://mcp.example.test/v1", "https://mcp.example.test/v1/mcp")).toBe(
      true
    );
    expect(resourceAllowed("https://mcp.example.test/v", "https://mcp.example.test/v1/mcp")).toBe(
      false
    );
    expect(resourceAllowed("https://other.example.test/mcp", "https://mcp.example.test/mcp")).toBe(
      false
    );
  });
});

describe("the checked fetch and the revocation", () => {
  const received: { path: string; authorization?: string; body: string }[] = [];
  let base = "";
  let close: () => Promise<void> = () => Promise.resolve();

  function read(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  beforeAll(async () => {
    const server = createServer((request, response) => {
      read(request)
        .then((body) => {
          received.push({
            path: request.url ?? "",
            ...(request.headers.authorization === undefined
              ? {}
              : { authorization: request.headers.authorization }),
            body
          });
          if (request.url === "/large") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ padding: "x".repeat(100_000) }));
          } else if (request.url === "/moved") {
            response.writeHead(302, { location: "http://169.254.169.254/" }).end();
          } else {
            response.writeHead(request.url === "/revoke" ? 200 : 503).end();
          }
        })
        .catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No address");
    base = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterAll(() => close());

  const egressFor = (port: number) =>
    createEgressChecker({
      allow: [
        { protocol: "http", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
      ]
    });
  const portOf = () => Number(new URL(base).port);

  it("sends nothing to a host off the egress list, follows no redirect and caps an answer", async () => {
    const before = received.length;
    const refused = await createOAuthFetch({
      egress: egressFor(portOf() + 1),
      signal: AbortSignal.timeout(5000)
    })(`${base}/token`, { method: "POST", body: "code=secret-code" }).catch(
      (error: unknown) => error
    );
    expect(connectionCallReasonOf(refused)).toBe("egress_denied");
    expect(received.length).toBe(before);

    const ok = createOAuthFetch({ egress: egressFor(portOf()), signal: AbortSignal.timeout(5000) });
    const moved = await ok(`${base}/moved`);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBeNull();
    const large = await ok(`${base}/large`);
    await expect(large.text()).rejects.toSatisfy(
      (error: unknown) => connectionCallReasonOf(error) === "output_invalid"
    );
  });

  it("revokes with the client's credential, and asks nothing of a server without an endpoint", async () => {
    const server: OAuthServerMetadata = {
      issuer: base,
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      revocationEndpoint: `${base}/revoke`,
      responseTypesSupported: ["code"],
      codeChallengeMethodsSupported: ["S256"],
      tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
      revocationEndpointAuthMethodsSupported: [],
      authorizationResponseIssParameterSupported: false
    };
    const fetch = createOAuthFetch({
      egress: egressFor(portOf()),
      signal: AbortSignal.timeout(5000)
    });
    const revoked = await revokeToken({
      server,
      client: { clientId: "client one", clientSecret: "s:cret" },
      token: "refresh-token-value",
      tokenTypeHint: "refresh_token",
      fetch
    });
    expect(revoked).toBe("confirmed");
    const sent = received.at(-1);
    expect(sent?.path).toBe("/revoke");
    expect(sent?.authorization).toBe(
      `Basic ${Buffer.from("client+one:s%3Acret").toString("base64")}`
    );
    expect(new URLSearchParams(sent?.body)).toEqual(
      new URLSearchParams({ token: "refresh-token-value", token_type_hint: "refresh_token" })
    );

    const before = received.length;
    const { revocationEndpoint: _left, ...withoutEndpoint } = server;
    expect(
      await revokeToken({
        server: withoutEndpoint,
        client: { clientId: "c" },
        token: "t",
        tokenTypeHint: "access_token",
        fetch
      })
    ).toBe("not_offered");
    expect(
      await revokeToken({
        server: { ...server, revocationEndpoint: `${base}/failing` },
        client: { clientId: "c" },
        token: "t",
        tokenTypeHint: "access_token",
        fetch
      })
    ).toBe("failed");
    expect(received.length).toBe(before + 1);
  });
});
