import { format, inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@vivd-catalyst/client-assembly";
import { connectionConfigSchema, egressConfigSchema } from "@vivd-catalyst/config-schema";
import {
  EGRESS_RESOLUTION_FAILURE_TTL_MS,
  EGRESS_RESOLUTION_TTL_MS,
  createEgressChecker,
  egressTargetOfUrl,
  openConnectorContext,
  type EgressAllowEntry
} from "@vivd-catalyst/connections";
import {
  LOG_REDACTION,
  connectionCallReasonOf,
  type ConnectionConfig,
  type ConnectionCredentialResolver,
  type EgressChecker,
  type EgressTarget
} from "@vivd-catalyst/core";
import { checkerOf, denied, https, unresolved, type Dns } from "./support/egress";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import { createTestConnector, findLeak, generateTestSecret } from "./support/test-connector";

// The egress checker, and the order the auth component keeps around it. Each test fails
// without the checker: before it nothing judged a Connection's target.

describe("the egress checker", () => {
  it("refuses everything on an empty list", async () => {
    const { checker, asked } = checkerOf([], { "api.example.com": ["93.184.216.34"] });
    await denied(checker.check(https("api.example.com")));
    await denied(checker.check(https("93.184.216.34")));
    // A host nothing lists is not even resolved.
    expect(asked).toEqual([]);
  });

  it("allows the listed protocol, host and port, and answers the address to pin", async () => {
    const { checker } = checkerOf([{ host: "api.example.com" }], {
      "api.example.com": ["2606:2800:220:1::1", "93.184.216.34"]
    });
    expect(await checker.check(https("API.Example.com."))).toEqual({
      protocol: "https",
      host: "api.example.com",
      port: 443,
      address: "93.184.216.34",
      family: 4,
      network: "public"
    });
  });

  it("refuses another host, another port, another protocol and a look-alike name", async () => {
    const { checker, asked } = checkerOf([{ host: "api.example.com" }], {
      "api.example.com": ["93.184.216.34"],
      "evil.example.com": ["93.184.216.34"]
    });
    for (const target of [
      https("evil.example.com"),
      https("api.example.com", 8443),
      { protocol: "http", host: "api.example.com", port: 443 },
      { protocol: "postgres", host: "api.example.com", port: 443 },
      https("sub.api.example.com"),
      https("api.example.com.evil.example.com"),
      https("api.example.com@evil.example.com"),
      https("api.example.com/"),
      https(""),
      https("api.example.com", 0),
      https("api.example.com", 70_000)
    ] satisfies EgressTarget[]) {
      await denied(checker.check(target));
    }
    expect(asked).toEqual([]);
  });

  it("refuses a listed host that resolves to a metadata, loopback, link-local or private address", async () => {
    const blocked = [
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.10",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:10.0.0.1",
      // An IPv4 address carried in another IPv6 form: IPv4-compatible, NAT64, 6to4, Teredo.
      "::169.254.169.254",
      "::a00:5",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::7f00:1",
      "2002:a9fe:a9fe::1",
      "2002:c0a8:101::1",
      "2001:0:5db8:d822:0:0:f5ff:fffa",
      "not an address"
    ];
    for (const address of blocked) {
      const { checker } = checkerOf([{ host: "api.example.com" }], {
        "api.example.com": [address]
      });
      const error = await denied(checker.check(https("api.example.com")));
      expect(error.details, address).toEqual({
        reason: "egress_denied",
        host: "api.example.com",
        port: 443
      });
    }
  });

  it("grants a public IPv4 address carried in an IPv6 form, and pins it as answered", async () => {
    const { checker } = checkerOf([{ host: "api.example.com" }], {
      "api.example.com": ["64:ff9b::5db8:d822"]
    });
    expect(await checker.check(https("api.example.com"))).toMatchObject({
      address: "64:ff9b::5db8:d822",
      family: 6
    });
  });

  it("refuses a host with one blocked answer among public ones, wherever it stands", async () => {
    for (const answers of [
      ["93.184.216.34", "10.0.0.5"],
      ["10.0.0.5", "93.184.216.34"],
      ["93.184.216.34", "::ffff:127.0.0.1"],
      ["2606:2800:220:1::1", "169.254.169.254", "93.184.216.34"]
    ]) {
      const { checker } = checkerOf([{ host: "api.example.com" }], {
        "api.example.com": answers
      });
      await denied(checker.check(https("api.example.com")));
    }
  });

  it("refuses a literal address that is blocked, in every spelling, even when listed as public", async () => {
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "0:0:0:0:0:ffff:a9fe:a9fe"
    ]) {
      // Past the schema on purpose: the checker holds this line by itself.
      const checker = createEgressChecker({
        allow: [{ protocol: "https", host, port: 443, network: "public", cidrs: [] }],
        resolve: () => Promise.reject(new Error("A literal address is not resolved"))
      });
      await denied(checker.check(https(host)));
    }
  });

  it("refuses a listed host that does not resolve with a reason of its own, and contacts nothing", async () => {
    // Fails without the change: both answered `egress_denied: ... is not allowed`, which
    // sent an operator to the list for a stopped service.
    const { checker, asked } = checkerOf(
      [{ host: "gone.example.com" }, { host: "empty.example.com" }],
      { "empty.example.com": [] }
    );
    const gone = await unresolved(checker.check(https("gone.example.com")));
    expect(gone.message).toBe(
      "egress_unresolved: gone.example.com:443 is on the egress list, but the host did not resolve to an address"
    );
    expect(gone.details).toEqual({
      reason: "egress_unresolved",
      host: "gone.example.com",
      port: 443
    });
    expect(connectionCallReasonOf(gone)).toBe("connection_unavailable");
    await unresolved(checker.check(https("empty.example.com")));
    expect(asked).toEqual(["gone.example.com", "empty.example.com"]);
  });

  it("refuses a host outside the list as egress_denied before anything is resolved", async () => {
    // The answer for an unlisted target does not depend on DNS: with and without an address
    // it is the same refusal, and the resolver is never asked.
    const cases: Dns[] = [{}, { "other.example.com": ["93.184.216.34"] }];
    for (const dns of cases) {
      const { checker, asked } = checkerOf([{ host: "api.example.com" }], dns);
      const error = await denied(checker.check(https("other.example.com")));
      expect(error.message).toBe("egress_denied: other.example.com:443 is not allowed");
      // Another port and another protocol of a listed host are outside the list as well.
      await denied(checker.check(https("api.example.com", 8443)));
      await denied(checker.check({ protocol: "http", host: "api.example.com", port: 443 }));
      expect(asked).toEqual([]);
    }
  });

  it("keeps egress_denied for a listed host that resolves to a private address without cidrs", async () => {
    // No check is loosened: an address the rules refuse is `egress_denied` as before.
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::ffff:10.0.0.5"]) {
      const { checker } = checkerOf([{ host: "api.example.com" }], {
        "api.example.com": [address]
      });
      const error = await denied(checker.check(https("api.example.com")));
      expect(error.message, address).toBe("egress_denied: api.example.com:443 is not allowed");
    }
    // A Store whose name gives no address refuses the target on its port as `egress_denied`.
    const { checker } = checkerOf(
      [
        {
          protocol: "postgres",
          host: "warehouse",
          port: 5432,
          network: "private",
          cidrs: ["172.28.0.0/16"]
        }
      ],
      { warehouse: ["172.28.0.9"] },
      { platformStore: [{ host: "postgres", port: 5432 }] }
    );
    await denied(checker.check({ protocol: "postgres", host: "warehouse", port: 5432 }));
  });

  it("reaches a private target only where the operator's entry names its ranges", async () => {
    const entry = {
      protocol: "http" as const,
      host: "mcp-demo",
      port: 8080,
      network: "private" as const,
      cidrs: ["172.28.0.0/16", "fd00:28::/64"]
    };
    const target: EgressTarget = { protocol: "http", host: "mcp-demo", port: 8080 };
    const inside = checkerOf([entry], { "mcp-demo": ["172.28.0.7"] });
    expect(await inside.checker.check(target)).toMatchObject({
      address: "172.28.0.7",
      network: "private"
    });
    const insideV6 = checkerOf([entry], { "mcp-demo": ["fd00:28::7", "::ffff:172.28.0.7"] });
    expect(await insideV6.checker.check(target)).toMatchObject({ address: "172.28.0.7" });

    // Outside the named ranges: another private address, loopback, metadata, and a public
    // one, which a private entry was never meant for. One such answer refuses the target.
    for (const answers of [
      ["172.29.0.7"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["93.184.216.34"],
      ["172.28.0.7", "10.0.0.5"]
    ]) {
      const outside = checkerOf([entry], { "mcp-demo": answers });
      await denied(outside.checker.check(target));
    }
  });

  it("lets no private entry reach a link-local address, and stops startup on such a range", async () => {
    // Fails without the change: a private entry whose range named 169.254.0.0/16 was
    // granted the metadata address.
    const entryWith = (cidrs: string[]): EgressAllowEntry => ({
      protocol: "http",
      host: "inside",
      port: 80,
      network: "private",
      cidrs
    });
    for (const cidr of [
      "169.254.0.0/16",
      "169.254.169.254/32",
      "169.254.169.0/24",
      "169.0.0.0/8",
      "0.0.0.0/0",
      "fe80::/10",
      "fe80::1/128",
      "fe00::/7",
      "::/0"
    ]) {
      expect(() => createEgressChecker({ allow: [entryWith(["10.0.0.0/8", cidr])] }), cidr).toThrow(
        `egress.allow: the range '${cidr}' of 'inside' covers link-local addresses`
      );
    }
    // Loopback and the private ranges stay the operator's to name.
    const checker = createEgressChecker({
      allow: [
        entryWith([
          "127.0.0.0/8",
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "fd00::/8",
          "::1/128"
        ])
      ],
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }])
    });
    expect(await checker.check({ protocol: "http", host: "inside", port: 80 })).toMatchObject({
      address: "127.0.0.1"
    });
  });

  it("lets no private entry reach a link-local address an IPv6 address carries", async () => {
    // Fails without the change: a private entry for 64:ff9b::/96 was granted
    // 64:ff9b::a9fe:a9fe, which a NAT64 translator delivers to 169.254.169.254.
    const entry = {
      protocol: "http" as const,
      host: "inside",
      port: 80,
      network: "private" as const,
      cidrs: ["64:ff9b::/96", "2002::/16", "2001::/32", "::ffff:0:0/96", "::/96"]
    };
    const target = { protocol: "http" as const, host: "inside", port: 80 };
    for (const address of [
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "2002:a9fe:a9fe::1",
      "2001:0:a9fe:a9fe::1",
      "2001:0:a00:1::5601:5601",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::a9fe:a9fe"
    ]) {
      const { checker } = checkerOf([entry], { inside: [address] });
      await denied(checker.check(target));
      // One such answer among good ones refuses the target as well.
      const mixed = checkerOf([entry], { inside: ["64:ff9b::a00:1", address] });
      await denied(mixed.checker.check(target));
    }
    // What the operator named and is not link-local stays reachable.
    for (const address of ["64:ff9b::a00:1", "2002:a00:1::1"]) {
      const { checker } = checkerOf([entry], { inside: [address] });
      expect((await checker.check(target)).address, address).toBe(address);
    }
  });

  it("takes plain http for a private entry only, and private ranges for no public entry", () => {
    const parse = (entry: Record<string, unknown>) =>
      egressConfigSchema.safeParse({ allow: [entry] }).success;
    expect(parse({ protocol: "https", host: "api.example.com", port: 443 })).toBe(true);
    expect(parse({ protocol: "http", host: "api.example.com", port: 80 })).toBe(false);
    expect(
      parse({ protocol: "http", host: "mcp", port: 80, network: "private", cidrs: ["10.1.0.0/16"] })
    ).toBe(true);
    expect(parse({ protocol: "http", host: "mcp", port: 80, network: "private" })).toBe(false);
    expect(
      parse({ protocol: "https", host: "api.example.com", port: 443, cidrs: ["10.0.0.0/8"] })
    ).toBe(false);
    expect(
      parse({ protocol: "https", host: "m", port: 443, network: "private", cidrs: ["10.0.0/8"] })
    ).toBe(false);
    expect(parse({ protocol: "https", host: "*.example.com", port: 443 })).toBe(false);
    expect(parse({ protocol: "https", host: "api.example.com" })).toBe(false);
    expect(egressConfigSchema.parse({}).allow).toEqual([]);
    // The checker holds the same line for a list that did not pass the schema.
    expect(() =>
      createEgressChecker({
        allow: [{ protocol: "http", host: "a.example.com", port: 80, network: "public", cidrs: [] }]
      })
    ).toThrow(/plain http/u);
  });

  it("refuses the Platform Store, by name and by address, whatever the list says", async () => {
    const store = { host: "postgres", port: 5432 };
    const entries = [
      {
        protocol: "postgres" as const,
        host: "postgres",
        port: 5432,
        network: "private" as const,
        cidrs: ["172.28.0.0/16"]
      },
      {
        protocol: "postgres" as const,
        host: "db-alias",
        port: 5432,
        network: "private" as const,
        cidrs: ["172.28.0.0/16"]
      },
      {
        protocol: "postgres" as const,
        host: "warehouse",
        port: 5432,
        network: "private" as const,
        cidrs: ["172.28.0.0/16"]
      },
      {
        protocol: "https" as const,
        host: "db-alias",
        port: 8443,
        network: "private" as const,
        cidrs: ["172.28.0.0/16"]
      }
    ];
    const { checker } = checkerOf(
      entries,
      { postgres: ["172.28.0.2"], "db-alias": ["172.28.0.2"], warehouse: ["172.28.0.9"] },
      { platformStore: [store] }
    );
    await denied(checker.check({ protocol: "postgres", host: "postgres", port: 5432 }));
    await denied(checker.check({ protocol: "postgres", host: "db-alias", port: 5432 }));
    // Another database, and another port of the store's host, are the operator's to list.
    expect(
      await checker.check({ protocol: "postgres", host: "warehouse", port: 5432 })
    ).toMatchObject({ address: "172.28.0.9" });
    expect(await checker.check({ protocol: "https", host: "db-alias", port: 8443 })).toMatchObject({
      address: "172.28.0.2"
    });
  });

  it("refuses a target on the Store's port while the Store's address cannot be resolved", async () => {
    // Fails without the change: a Store host that did not resolve left an empty deny list,
    // and the alias below was granted.
    let time = 1_000;
    const private_ = { network: "private" as const, cidrs: ["172.28.0.0/16"] };
    const dns: Dns = { "db-alias": ["172.28.0.2"], api: ["172.28.0.9"] };
    const { checker } = checkerOf(
      [
        { protocol: "postgres", host: "db-alias", port: 5432, ...private_ },
        { protocol: "postgres", host: "172.28.0.2", port: 5432, ...private_ },
        { protocol: "https", host: "api", port: 443, ...private_ }
      ],
      dns,
      { platformStore: [{ host: "postgres", port: 5432 }], now: () => time }
    );
    await denied(checker.check({ protocol: "postgres", host: "db-alias", port: 5432 }));
    await denied(checker.check({ protocol: "postgres", host: "172.28.0.2", port: 5432 }));
    // Another port is not the Store's: it needs no Store address to be judged.
    expect(await checker.check(https("api"))).toMatchObject({ address: "172.28.0.9" });

    // The Store resolves again, elsewhere: the alias is another database and is granted.
    dns.postgres = ["172.28.0.3"];
    time += EGRESS_RESOLUTION_TTL_MS;
    expect(
      await checker.check({ protocol: "postgres", host: "db-alias", port: 5432 })
    ).toMatchObject({ address: "172.28.0.2" });
    // The Store moves onto the alias's address. No held Store address stands in the way: it
    // is resolved again with the target, and the target is refused.
    dns.postgres = ["172.28.0.2"];
    time += EGRESS_RESOLUTION_TTL_MS;
    await denied(checker.check({ protocol: "postgres", host: "db-alias", port: 5432 }));
    // A Store host with no address at all refuses as one that fails.
    dns.postgres = [];
    time += EGRESS_RESOLUTION_TTL_MS;
    await denied(checker.check({ protocol: "postgres", host: "db-alias", port: 5432 }));
  });

  it("resolves once per target within EGRESS_RESOLUTION_TTL_MS, and again after it", async () => {
    let time = 1_000;
    const dns: Dns = { "api.example.com": ["93.184.216.34"] };
    const { checker, asked } = checkerOf([{ host: "api.example.com" }], dns, {
      now: () => time
    });
    for (let index = 0; index < 500; index += 1) {
      await checker.check(https("api.example.com"));
    }
    expect(asked).toHaveLength(1);

    // The name moves to a blocked address. The held answer is used until it runs out, and
    // the connection it is used for goes to the address that was checked.
    dns["api.example.com"] = ["169.254.169.254"];
    time += EGRESS_RESOLUTION_TTL_MS - 1;
    expect((await checker.check(https("api.example.com"))).address).toBe("93.184.216.34");
    time += 1;
    await denied(checker.check(https("api.example.com")));
    expect(asked).toHaveLength(2);
  });

  it("holds a refusal of the resolver for EGRESS_RESOLUTION_FAILURE_TTL_MS, one by rule for the full time", async () => {
    // Fails without the change: a lookup that failed once kept the target refused for
    // EGRESS_RESOLUTION_TTL_MS.
    expect(EGRESS_RESOLUTION_FAILURE_TTL_MS).toBe(5_000);
    let time = 1_000;
    const dns: Dns = { "blocked.example.com": ["10.0.0.5"], "empty.example.com": [] };
    const { checker, asked } = checkerOf(
      [
        { host: "api.example.com" },
        { host: "empty.example.com" },
        { host: "blocked.example.com" },
        {
          protocol: "postgres",
          host: "warehouse",
          port: 5432,
          network: "private",
          cidrs: ["172.28.0.0/16"]
        }
      ],
      dns,
      { now: () => time, platformStore: [{ host: "postgres", port: 5432 }] }
    );
    const warehouse: EgressTarget = { protocol: "postgres", host: "warehouse", port: 5432 };
    // A failed lookup, no answer, and a Store that does not resolve.
    await unresolved(checker.check(https("api.example.com")));
    await unresolved(checker.check(https("empty.example.com")));
    dns.warehouse = ["172.28.0.9"];
    await denied(checker.check(warehouse));
    await denied(checker.check(https("blocked.example.com")));
    expect(asked).toHaveLength(5);

    // Within the short time nothing is asked again.
    dns["api.example.com"] = ["93.184.216.34"];
    dns["empty.example.com"] = ["93.184.216.35"];
    dns.postgres = ["172.28.0.2"];
    dns["blocked.example.com"] = ["93.184.216.36"];
    time += EGRESS_RESOLUTION_FAILURE_TTL_MS - 1;
    await unresolved(checker.check(https("api.example.com")));
    expect(asked).toHaveLength(5);

    // After it the three resolver refusals are asked again and granted. The refusal by rule
    // stands for the full time.
    time += 1;
    expect((await checker.check(https("api.example.com"))).address).toBe("93.184.216.34");
    expect((await checker.check(https("empty.example.com"))).address).toBe("93.184.216.35");
    expect((await checker.check(warehouse)).address).toBe("172.28.0.9");
    await denied(checker.check(https("blocked.example.com")));
    time += EGRESS_RESOLUTION_TTL_MS - EGRESS_RESOLUTION_FAILURE_TTL_MS - 1;
    await denied(checker.check(https("blocked.example.com")));
    time += 1;
    expect((await checker.check(https("blocked.example.com"))).address).toBe("93.184.216.36");
  });

  it("names host and port in a refusal, and nothing else of the target", async () => {
    const { checker } = checkerOf([]);
    const error = await denied(checker.check(https("api.example.com")));
    expect(error.message).toBe("egress_denied: api.example.com:443 is not allowed");
    const odd = await denied(checker.check(https("api.example.com/path?key=abc def")));
    expect(odd.message).toBe("egress_denied: (unreadable host):443 is not allowed");
  });
});

describe("the order around a call", () => {
  const stored = (overrides: Parameters<typeof connection>[1] = {}): ConnectionConfig =>
    connectionConfigSchema.parse(
      connection("outside", {
        connectorType: "test",
        settings: { url: "https://api.example.com/mcp" },
        ...overrides
      })
    );

  function setup(dns: Dns, allow: Parameters<typeof checkerOf>[0] = [{ host: "api.example.com" }]) {
    const connector = createTestConnector();
    const secret = generateTestSecret();
    const resolved: string[] = [];
    const credentials: ConnectionCredentialResolver = {
      resolve({ handle }) {
        resolved.push(handle);
        return Promise.resolve(secret);
      }
    };
    const { checker, asked } = checkerOf(allow, dns);
    const open = (config: ConnectionConfig, egress: EgressChecker = checker) =>
      openConnectorContext({
        type: connector.type,
        connection: { id: "asset-1", revision: 1, config },
        egress,
        credentials,
        signal: new AbortController().signal
      });
    /** One call as S3-38 will make it: open the context, then the type's `execute`. */
    const call = async (config: ConnectionConfig) =>
      connector.type.execute("echo", { q: 1 }, await open(config));
    return { connector, secret, resolved, asked, checker, open, call };
  }

  it("refuses each bad target before the credential is resolved and before execute runs", async () => {
    const cases: Array<[name: string, dns: Dns, url: string]> = [
      [
        "a host outside the list",
        { "other.example.com": ["93.184.216.34"] },
        "https://other.example.com/mcp"
      ],
      [
        "a listed host that resolves to 169.254.169.254",
        { "api.example.com": ["169.254.169.254"] },
        "https://api.example.com/mcp"
      ],
      [
        "mixed public and private answers",
        { "api.example.com": ["93.184.216.34", "10.0.0.5"] },
        "https://api.example.com/mcp"
      ],
      [
        "an IPv4-mapped IPv6 loopback",
        { "api.example.com": ["::ffff:127.0.0.1"] },
        "https://api.example.com/mcp"
      ],
      [
        "another port of the listed host",
        { "api.example.com": ["93.184.216.34"] },
        "https://api.example.com:8443/mcp"
      ],
      [
        "plain http to the listed host",
        { "api.example.com": ["93.184.216.34"] },
        "http://api.example.com:443/mcp"
      ]
    ];
    for (const [name, dns, url] of cases) {
      const t = setup(dns);
      const error = await denied(t.call(stored({ settings: { url } })));
      expect(error.details, name).toMatchObject({ reason: "egress_denied" });
      expect(t.resolved, name).toEqual([]);
      expect(t.connector.calls, name).toEqual([]);
    }
  });

  it("checks, then resolves the credential for the one binding, then runs execute", async () => {
    const t = setup({ "api.example.com": ["93.184.216.34"] });
    expect(await t.call(stored())).toEqual({ q: 1 });
    expect(t.resolved).toEqual([required(stored().secretHandle)]);
    const made = required(t.connector.calls[0]);
    expect(made.context.target).toMatchObject({
      host: "api.example.com",
      address: "93.184.216.34"
    });
    const credential = required(made.credential);
    expect(credential.scheme).toBe("bearer");
    expect(credential.secret).toBe(t.secret);
    expect({ ...credential.headers }).toEqual({ authorization: `Bearer ${t.secret}` });
    // The settings of the call hold no credential: it is the context's alone.
    expect(JSON.stringify(made.context.connection)).not.toContain(t.secret);
  });

  it("hands out a credential that no serializer and no print writes out", async () => {
    // Fails without the change: the credential was a plain object, and each of these texts
    // held the secret.
    for (const authScheme of ["bearer", "header"]) {
      const t = setup({ "api.example.com": ["93.184.216.34"] });
      await t.call(
        stored({
          authScheme,
          settings: { url: "https://api.example.com/mcp", headerName: "X-Api-Key" }
        })
      );
      const made = required(t.connector.calls[0]);
      const credential = required(made.credential);
      // `console.log` writes what `format` answers.
      const printed = [
        format(credential, credential.headers, made),
        format("%o %j %s", credential, credential.headers, credential),
        format({ nested: { credential }, list: [credential.headers] })
      ].join("\n");
      const texts = [
        JSON.stringify(credential),
        JSON.stringify(credential.headers),
        JSON.stringify({ made, list: [credential], headers: credential.headers }),
        inspect(credential, { showHidden: false, depth: 10 }),
        inspect({ made, headers: credential.headers }, { depth: 10 }),
        String(credential),
        `${JSON.stringify(Object.entries(credential))}${JSON.stringify({ ...credential })}`,
        format("%o %O %j", credential, made, credential.headers),
        printed
      ];
      for (const text of texts) {
        expect(findLeak(text, t.secret), text.slice(0, 200)).toBeUndefined();
      }
      expect(JSON.stringify(credential)).toBe('"[credential]"');
      expect(JSON.stringify(credential.headers)).toBe('"[credential]"');
      expect(printed).toContain("[credential]");
      expect(Object.keys(credential)).toEqual(["scheme"]);
      // A connector still reads what it needs, member by member.
      expect(credential.secret).toBe(t.secret);
      expect(Object.values(credential.headers)).toHaveLength(1);
      expect(Object.isFrozen(credential) && Object.isFrozen(credential.headers)).toBe(true);
    }
  });

  it("is written by the process logger as its redaction, also inside an error cause", async () => {
    // Fails without the change: the logger walked the entries of the headers and of an
    // error's cause, and every line below held the secret under `x-auth`.
    const t = setup({ "api.example.com": ["93.184.216.34"] });
    await t.call(
      stored({
        authScheme: "header",
        settings: { url: "https://api.example.com/mcp", headerName: "X-Auth" }
      })
    );
    const credential = required(required(t.connector.calls[0]).credential);
    const { headers } = credential;
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const logger = createLogger();
      const failed = Object.assign(new Error("The request failed", { cause: { headers } }), {
        config: { headers, attempts: [credential, headers] }
      });
      logger.info({ headers }, "as a field");
      logger.info({ request: { headers, sent: [headers, credential] }, value: credential }, "deep");
      logger.warn({ error: failed }, "inside an error and its cause");
      logger.error(new Error("outer", { cause: new Error("inner", { cause: headers }) }));
      logger.error({ err: new Error("as the cause itself", { cause: credential }) }, "err");
      logger.info(headers, "as the record itself");
      logger.info(credential, "as the record itself");
      logger.child({ headers, request: { headers } }).info("as a binding");
      logger.child(headers).info("as the bindings themselves");
    } finally {
      spy.mockRestore();
    }
    const written = chunks.join("");
    expect(chunks).toHaveLength(9);
    expect(findLeak(written, t.secret)).toBeUndefined();
    expect(written).not.toContain("x-auth");
    expect(written.split("[credential]").length).toBeGreaterThan(12);
    // The headers a request takes are a plain copy, without the mark.
    expect({ ...headers }).toEqual({ "x-auth": t.secret });
    expect(LOG_REDACTION in { ...headers }).toBe(false);
  });

  it("puts the secret into the header the type names, under the scheme header", async () => {
    const t = setup({ "api.example.com": ["93.184.216.34"] });
    await t.call(
      stored({
        authScheme: "header",
        settings: { url: "https://api.example.com/mcp", headerName: "X-Api-Key" }
      })
    );
    const credential = required(required(t.connector.calls[0]).credential);
    expect(credential.scheme).toBe("header");
    expect({ ...credential.headers }).toEqual({ "x-api-key": t.secret });
    // Without a name for the header there is no call.
    const error: unknown = await t.call(stored({ authScheme: "header" })).catch((e: unknown) => e);
    expect(error).toMatchObject({ details: { reason: "connection_not_configured" } });
    expect(t.connector.calls).toHaveLength(1);
  });

  it("resolves nothing for the scheme none, and refuses a Connection without a handle", async () => {
    const t = setup({ "api.example.com": ["93.184.216.34"] });
    await t.call(stored({ authScheme: "none", secretHandle: undefined }));
    expect(t.resolved).toEqual([]);
    expect(required(t.connector.calls[0]).credential).toBeUndefined();
    const error: unknown = await t
      .call(stored({ secretHandle: undefined }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { reason: "connection_not_configured" } });
    expect(t.connector.calls).toHaveLength(1);
  });

  it("checks a redirect again and never hands the credential to another origin", async () => {
    const t = setup(
      {
        "api.example.com": ["93.184.216.34"],
        "files.example.com": ["93.184.216.40"],
        "inside.example.com": ["10.0.0.5"]
      },
      [{ host: "api.example.com" }, { host: "files.example.com" }, { host: "inside.example.com" }]
    );
    const context = await t.open(stored());
    // A redirect to a host outside the list, and to a listed name that resolves inside.
    await denied(context.checkEgress(egressTargetOfUrl("https://evil.example.com/steal")));
    await denied(context.checkEgress(egressTargetOfUrl("https://inside.example.com/")));
    await denied(context.checkEgress(egressTargetOfUrl("https://169.254.169.254/latest")));
    // A listed download host may be reached, and it gets no credential.
    const download = await context.checkEgress(egressTargetOfUrl("https://files.example.com/a"));
    expect(download.address).toBe("93.184.216.40");
    expect(() => context.credentialFor(download)).toThrow(/origin it was configured for/u);
    // Nor does the same name on another port, or a grant somebody made up for the origin.
    expect(() => context.credentialFor({ ...context.target, port: 8443 })).toThrow();
    expect(() => context.credentialFor({ ...context.target, address: "10.0.0.5" })).toThrow();
    // The same origin, checked again, does.
    const again = await context.checkEgress(egressTargetOfUrl("https://api.example.com/next"));
    expect(context.credentialFor(again)?.headers.authorization).toBe(`Bearer ${t.secret}`);
  });

  it("refuses settings that do not fit the type before anything is checked", async () => {
    const t = setup({ "api.example.com": ["93.184.216.34"] });
    const config = { ...stored(), settings: { url: "https://api.example.com/mcp", extra: "x" } };
    const error: unknown = await t.call(config).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { reason: "connection_not_configured" } });
    expect(t.asked).toEqual([]);
    expect(t.resolved).toEqual([]);
    expect(t.connector.calls).toEqual([]);
  });
});
