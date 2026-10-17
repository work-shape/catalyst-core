import { describe, expect, it } from "vitest";
import { connectionConfigSchema, egressConfigSchema } from "@work-shape/catalyst-config-schema";
import { egressTargetOfUrl, openConnectorContext } from "@work-shape/catalyst-connections";
import type { ConnectionCredentialResolver } from "@work-shape/catalyst-core";
import { connection } from "./support/connections";
import { checkerOf, denied, https } from "./support/egress";
import { createTestConnector, generateTestSecret } from "./support/test-connector";

// Release config `egress.allowPublicHttps`: the operator opening every public HTTPS host on
// port 443 beside the list. Each test of a grant fails without the setting; each refusal
// shows that no check of the public judgement, the Platform Store, other ports or protocols
// and redirects was loosened by it.

describe("the egress checker with egress.allowPublicHttps", () => {
  const PUBLIC_HINT =
    "An operator adds it under 'egress.allow' in release config, or allows every public HTTPS host on port 443 with 'egress.allowPublicHttps: true'";
  const NOT_PUBLIC_HINT =
    "It resolves to an address that is not public. Only an entry under 'egress.allow' with 'network: private' and the 'cidrs' it lies in reaches it";

  it("is off unless set: an unknown host stays refused, and the refusal names the setting", async () => {
    expect(egressConfigSchema.parse({}).allowPublicHttps).toBeUndefined();
    expect(egressConfigSchema.safeParse({ allowPublicHttps: "yes" }).success).toBe(false);
    for (const further of [{}, { allowPublicHttps: false }]) {
      const { checker, asked } = checkerOf([], { "api.example.com": ["93.184.216.34"] }, further);
      expect(checker.admits(https("api.example.com"))).toBe(false);
      const error = await denied(checker.check(https("api.example.com")));
      expect(error.message).toBe(
        `egress_denied: api.example.com:443 is not allowed. ${PUBLIC_HINT}`
      );
      expect(error.details).toEqual({
        reason: "egress_denied",
        host: "api.example.com",
        port: 443
      });
      expect(asked).toEqual([]);
    }
  });

  it("grants a host no entry names over https on 443 when every address is public", async () => {
    const { checker } = checkerOf(
      [],
      { "api.example.com": ["2606:2800:220:1::1", "93.184.216.34"] },
      { allowPublicHttps: true }
    );
    expect(checker.admits(https("API.Example.com."))).toBe(true);
    expect(await checker.check(https("API.Example.com."))).toEqual({
      protocol: "https",
      host: "api.example.com",
      port: 443,
      address: "93.184.216.34",
      family: 4,
      network: "public"
    });
  });

  it("refuses loopback, private, link-local, metadata and IPv4-mapped private answers as before", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.10",
      "100.64.0.1",
      "169.254.169.254",
      "fd00:ec2::254",
      "fe80::1",
      "::1",
      "::ffff:10.0.0.5",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "0.0.0.0"
    ]) {
      const { checker } = checkerOf(
        [],
        { "inside.example.com": [address] },
        { allowPublicHttps: true }
      );
      const error = await denied(checker.check(https("inside.example.com")));
      expect(error.details, address).toEqual({
        reason: "egress_denied",
        host: "inside.example.com",
        port: 443
      });
      // A literal address is judged the same way.
      await denied(checker.check(https(address)));
    }
    // One blocked answer among public ones refuses the target.
    const { checker } = checkerOf(
      [],
      { "mixed.example.com": ["93.184.216.34", "10.0.0.5"] },
      { allowPublicHttps: true }
    );
    const error = await denied(checker.check(https("mixed.example.com")));
    expect(error.message).toBe(
      `egress_denied: mixed.example.com:443 is not allowed. ${NOT_PUBLIC_HINT}`
    );
    // Link-local is reached by no setting, and the refusal says so.
    const metadata = await denied(checker.check(https("169.254.169.254")));
    expect(metadata.message).toBe(
      "egress_denied: 169.254.169.254:443 is not allowed. No setting allows it"
    );
  });

  it("refuses the database host on every port, by name and by address", async () => {
    const { checker } = checkerOf(
      [],
      { "db.example.com": ["93.184.216.50"], "alias.example.com": ["93.184.216.50"] },
      { allowPublicHttps: true, platformStore: [{ host: "db.example.com", port: 5432 }] }
    );
    expect(checker.admits(https("db.example.com"))).toBe(false);
    const byName = await denied(checker.check(https("db.example.com")));
    expect(byName.message).toBe(
      "egress_denied: db.example.com:443 is not allowed. No setting allows it"
    );
    await denied(checker.check(https("alias.example.com")));
  });

  it("opens https on 443 only: another port, plain http and postgres still need an entry", async () => {
    const { checker, asked } = checkerOf(
      [],
      { "api.example.com": ["93.184.216.34"] },
      { allowPublicHttps: true }
    );
    const port = await denied(checker.check(https("api.example.com", 8443)));
    expect(port.message).toBe(
      "egress_denied: api.example.com:8443 is not allowed. An operator adds it under 'egress.allow' in release config"
    );
    const http = await denied(
      checker.check({ protocol: "http", host: "api.example.com", port: 80 })
    );
    expect(http.message).toBe(
      "egress_denied: api.example.com:80 is not allowed. An operator adds it under 'egress.allow' in release config, with 'network: private' and its 'cidrs'"
    );
    await denied(checker.check({ protocol: "http", host: "api.example.com", port: 443 }));
    await denied(checker.check({ protocol: "postgres", host: "api.example.com", port: 5432 }));
    expect(checker.admits(https("api.example.com", 8443))).toBe(false);
    expect(asked).toEqual([]);
  });

  it("keeps explicit entries working beside it", async () => {
    const { checker } = checkerOf(
      [
        {
          protocol: "http",
          host: "mcp-internal",
          port: 8080,
          network: "private",
          cidrs: ["172.28.0.0/16"]
        },
        { host: "api.example.com", port: 8443 }
      ],
      { "mcp-internal": ["172.28.0.4"], "api.example.com": ["93.184.216.34"] },
      { allowPublicHttps: true }
    );
    expect(
      await checker.check({ protocol: "http", host: "mcp-internal", port: 8080 })
    ).toMatchObject({ address: "172.28.0.4", network: "private" });
    expect(await checker.check(https("api.example.com", 8443))).toMatchObject({
      address: "93.184.216.34"
    });
    // The opt-in does not reach a private name over https.
    await denied(checker.check(https("mcp-internal")));
  });

  it("checks a redirect again under egress.allowPublicHttps, and refuses one to a private address", async () => {
    const { checker } = checkerOf(
      [],
      {
        "api.example.com": ["93.184.216.34"],
        "files.example.com": ["93.184.216.40"],
        "inside.example.com": ["10.0.0.5"],
        "mapped.example.com": ["::ffff:192.168.1.10"]
      },
      { allowPublicHttps: true }
    );
    const secret = generateTestSecret();
    const credentials: ConnectionCredentialResolver = {
      resolve: () => Promise.resolve(secret),
      resolveSignIn: () => Promise.reject(new Error("The test Connection has no sign-in"))
    };
    const context = await openConnectorContext({
      type: createTestConnector().type,
      connection: {
        id: "asset-1",
        revision: 1,
        config: connectionConfigSchema.parse(
          connection("outside", {
            connectorType: "test",
            settings: { url: "https://api.example.com/mcp" }
          })
        )
      },
      egress: checker,
      credentials,
      signal: new AbortController().signal
    });
    await denied(context.checkEgress(egressTargetOfUrl("https://inside.example.com/")));
    await denied(context.checkEgress(egressTargetOfUrl("https://mapped.example.com/")));
    await denied(context.checkEgress(egressTargetOfUrl("https://10.0.0.5/")));
    await denied(context.checkEgress(egressTargetOfUrl("https://169.254.169.254/latest")));
    await denied(context.checkEgress(egressTargetOfUrl("http://files.example.com/a")));
    await denied(context.checkEgress(egressTargetOfUrl("https://files.example.com:8443/a")));
    // A public download host is reached, and it gets no credential.
    const download = await context.checkEgress(egressTargetOfUrl("https://files.example.com/a"));
    expect(download.address).toBe("93.184.216.40");
    expect(() => context.credentialFor(download)).toThrow(/origin it was configured for/u);
    const again = await context.checkEgress(egressTargetOfUrl("https://api.example.com/next"));
    expect(context.credentialFor(again)?.headers.authorization).toBe(`Bearer ${secret}`);
  });
});
