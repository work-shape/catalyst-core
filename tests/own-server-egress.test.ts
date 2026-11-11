import { describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  createMcpConnectorType,
  egressOfConnection,
  openConnectorContext,
  pinnedLookup
} from "@work-shape/catalyst-connections";
import {
  createConnectorTypeRegistry,
  egressRuleOf,
  type ConnectorContext
} from "@work-shape/catalyst-core";
import { createConnectionAssetKind } from "@work-shape/catalyst-server";
import { checkerOf, denied, https, type Dns } from "./support/egress";
import { connection } from "./support/connections";

// The egress rule of a server a person adds for themselves (PMCP-3, connections acceptance
// check 79). It is `https` to public addresses only: a `private` entry of the operator's list
// never admits it, the instance's own host and the Platform Store are refused by name and by
// address, and the operator narrows it to the `public` entries with `ownServers.publicHttps`.

const PUBLIC = "93.184.216.34";
const INSTANCE_ADDRESS = "198.51.100.7";
const INSTANCE_URL = "https://chat.instance.example.com";

/** Every non-public answer the rule refuses, each in the form an attacker would pick. */
const NOT_PUBLIC: Record<string, string> = {
  loopback: "127.0.0.1",
  "loopback, other": "127.8.9.1",
  "private 10/8": "10.0.0.5",
  "private 172.16/12": "172.20.1.1",
  "private 192.168/16": "192.168.1.10",
  "carrier-grade NAT": "100.64.0.1",
  metadata: "169.254.169.254",
  "IPv6 loopback": "::1",
  "IPv6 unique local": "fd00::1",
  "IPv6 link-local": "fe80::1",
  "IPv4-mapped private": "::ffff:10.0.0.5",
  "IPv4-mapped metadata": "::ffff:169.254.169.254",
  "NAT64 of loopback": "64:ff9b::7f00:1",
  "6to4 of private": "2002:0a00:0005::1",
  unspecified: "0.0.0.0",
  multicast: "224.0.0.1"
};

/** A checker whose operator opened everything they could for the tests' private hosts. */
function ownWorld(further: Parameters<typeof checkerOf>[2] = {}, dns: Dns = {}) {
  const hosts = Object.keys(NOT_PUBLIC).map((_, index) => `inside-${index}.example.com`);
  const answers: Dns = {
    "notes.example.com": [PUBLIC],
    "chat.instance.example.com": [INSTANCE_ADDRESS],
    "db.example.com": ["192.0.2.80"],
    ...Object.fromEntries(
      Object.values(NOT_PUBLIC).map((address, index) => [hosts[index] ?? "", [address]])
    ),
    ...dns
  };
  const world = checkerOf(
    // Each host is listed as private with its own address as the range, where a range may
    // hold it: no entry may cover link-local addresses.
    Object.values(NOT_PUBLIC).flatMap((address, index) =>
      /^(?:169\.254\.|::ffff:169\.254\.|fe80:)/u.test(address)
        ? []
        : [
            {
              host: hosts[index] ?? "",
              network: "private" as const,
              cidrs: [`${address}/${address.includes(":") ? 128 : 32}`]
            }
          ]
    ),
    answers,
    {
      instanceUrl: INSTANCE_URL,
      platformStore: [{ host: "db.example.com", port: 5432 }],
      ...further
    }
  );
  return { ...world, hosts };
}

describe("the egress rule of a self-added server (check 79)", () => {
  it("is the rule of every ownerOnly Connection, and of no other", () => {
    expect(egressRuleOf({ ownerOnly: true })).toBe("own_server");
    expect(egressRuleOf({})).toBe("operator");
    expect(egressRuleOf({ ownerOnly: false })).toBe("operator");
  });

  it("reaches a public https host on 443 with allowPublicHttps off, which the operator's rule refuses", async () => {
    const { checker } = ownWorld();
    expect(await checker.check(https("notes.example.com"), "own_server")).toMatchObject({
      host: "notes.example.com",
      address: PUBLIC,
      network: "public"
    });
    await denied(checker.check(https("notes.example.com")));
  });

  it("refuses every non-public answer, also where a private entry lists the host", async () => {
    const { checker, hosts } = ownWorld();
    for (const [index, [label, address]] of Object.entries(NOT_PUBLIC).entries()) {
      const host = hosts[index] ?? "";
      const error = await denied(checker.check(https(host), "own_server"));
      expect(error.message, `${label}: ${address}`).toContain(host);
      expect(error.message).toMatch(/No setting/u);
    }
    // The operator's rule still reaches the ones its private entries list.
    expect(await checker.check(https(hosts[0] ?? ""))).toMatchObject({ network: "private" });
  });

  it("refuses an address written as the host, before anything is resolved", async () => {
    const { checker, asked } = ownWorld();
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "[::1]",
      "[fd00::1]",
      "[::ffff:10.0.0.5]"
    ]) {
      const target = https(address);
      expect(checker.admits(target, "own_server"), address).toBe(false);
      await denied(checker.check(target, "own_server"));
    }
    expect(checker.admits(https("localhost"), "own_server")).toBe(false);
    expect(checker.admits(https("api.localhost"), "own_server")).toBe(false);
    expect(asked).toEqual([]);
  });

  it("refuses the instance's own host by name, and any host that resolves to its address", async () => {
    const { checker } = ownWorld({}, { "behind.example.com": [PUBLIC, INSTANCE_ADDRESS] });
    expect(checker.admits(https("chat.instance.example.com"), "own_server")).toBe(false);
    expect(checker.admits(https("chat.instance.example.com", 8443), "own_server")).toBe(false);
    const byName = await denied(checker.check(https("chat.instance.example.com"), "own_server"));
    expect(byName.message).toContain("this instance's own address");
    const byAddress = await denied(checker.check(https("behind.example.com"), "own_server"));
    expect(byAddress.message).toContain("this instance's own address");
  });

  it("refuses every target while the instance's own host gives no address", async () => {
    const { checker } = checkerOf(
      [],
      { "notes.example.com": [PUBLIC] },
      { instanceUrl: INSTANCE_URL }
    );
    const error = await denied(checker.check(https("notes.example.com"), "own_server"));
    expect(error.message).toContain("cannot be told apart");
  });

  it("refuses the Platform Store by name on every port and by address", async () => {
    const { checker } = ownWorld({}, { "store-alias.example.com": ["192.0.2.80"] });
    expect(checker.admits(https("db.example.com"), "own_server")).toBe(false);
    await denied(checker.check(https("db.example.com"), "own_server"));
    await denied(checker.check(https("store-alias.example.com"), "own_server"));
  });

  it("speaks https only: http, postgres and imaps are refused whatever is listed", async () => {
    const { checker } = checkerOf(
      [
        {
          protocol: "http",
          host: "notes.example.com",
          port: 80,
          network: "private",
          cidrs: ["93.184.216.0/24"]
        }
      ],
      { "notes.example.com": [PUBLIC] }
    );
    for (const target of [
      { protocol: "http" as const, host: "notes.example.com", port: 80 },
      { protocol: "postgres" as const, host: "notes.example.com", port: 5432 },
      { protocol: "imaps" as const, host: "notes.example.com", port: 993 }
    ]) {
      expect(checker.admits(target, "own_server")).toBe(false);
      const error = await denied(checker.check(target, "own_server"));
      expect(error.message).toContain("https only");
    }
    expect(
      await checker.check({ protocol: "http", host: "notes.example.com", port: 80 })
    ).toBeTruthy();
  });

  it("reaches another port only through a public entry that names it exactly", async () => {
    const dns = { "notes.example.com": [PUBLIC] };
    const unlisted = checkerOf([], dns);
    expect(unlisted.checker.admits(https("notes.example.com", 8443), "own_server")).toBe(false);
    const error = await denied(
      unlisted.checker.check(https("notes.example.com", 8443), "own_server")
    );
    expect(error.message).toContain("notes.example.com:8443");
    expect(error.message).toContain("'network: public'");

    const listed = checkerOf([{ host: "notes.example.com", port: 8443 }], dns);
    expect(
      await listed.checker.check(https("notes.example.com", 8443), "own_server")
    ).toMatchObject({
      address: PUBLIC
    });

    // A private entry on that port is not looked at, though its range holds the address.
    const inside = checkerOf(
      [{ host: "notes.example.com", port: 8443, network: "private", cidrs: ["93.184.216.0/24"] }],
      dns
    );
    await denied(inside.checker.check(https("notes.example.com", 8443), "own_server"));
  });

  it("with ownServers.publicHttps off, reaches only the hosts a public entry names", async () => {
    const dns = { "notes.example.com": [PUBLIC], "other.example.com": [PUBLIC] };
    const { checker } = checkerOf([{ host: "notes.example.com" }], dns, {
      ownServersPublicHttps: false
    });
    expect(await checker.check(https("notes.example.com"), "own_server")).toMatchObject({
      address: PUBLIC
    });
    expect(checker.admits(https("other.example.com"), "own_server")).toBe(false);
    const error = await denied(checker.check(https("other.example.com"), "own_server"));
    expect(error.message).toContain("'network: public'");
    // A public entry whose host resolves to a private address is still refused.
    const rebound = checkerOf(
      [{ host: "notes.example.com" }],
      { "notes.example.com": ["10.0.0.5"] },
      {
        ownServersPublicHttps: false
      }
    );
    await denied(rebound.checker.check(https("notes.example.com"), "own_server"));
  });

  it("judges a host apart under each rule: a grant of the operator's rule is never the own server's", async () => {
    const { checker, hosts } = ownWorld();
    const host = hosts[2] ?? "";
    expect(await checker.check(https(host))).toMatchObject({ network: "private" });
    await denied(checker.check(https(host), "own_server"));
    expect(await checker.check(https(host))).toMatchObject({ network: "private" });
  });

  it("connects to the checked address when the host rebinds, and refuses it once the answer is new", async () => {
    let now = 0;
    const dns: Dns = { "notes.example.com": [PUBLIC] };
    const { checker } = checkerOf([], dns, { now: () => now });
    const grant = await checker.check(https("notes.example.com"), "own_server");
    dns["notes.example.com"] = ["127.0.0.1"];
    // The socket asks the pinned lookup, which answers the checked address and no other.
    const looked = await new Promise<string>((resolve, reject) => {
      pinnedLookup(grant)("notes.example.com", {}, (error, address) =>
        error ? reject(error) : resolve(String(address))
      );
    });
    expect(looked).toBe(PUBLIC);
    now += 60_000;
    await denied(checker.check(https("notes.example.com"), "own_server"));
  });
});

describe("a self-added Connection's context", () => {
  const type = createMcpConnectorType();
  const dns: Dns = {
    "notes.example.com": [PUBLIC],
    "inside.example.com": ["10.0.0.5"]
  };
  const allow = [
    { host: "inside.example.com", network: "private" as const, cidrs: ["10.0.0.0/8"] }
  ];

  function openFor(url: string, ownerOnly: boolean) {
    const { checker } = checkerOf(allow, dns);
    const signIns: string[] = [];
    const config = connectionConfigSchema.parse(
      connection("notes", {
        connectorType: "mcp",
        credentialMode: ownerOnly ? "user" : "shared",
        authScheme: "oauth",
        settings: { url },
        ownerPrincipalId: "user:carol",
        ...(ownerOnly ? { ownerOnly: true } : {})
      })
    );
    const open = (): Promise<ConnectorContext> =>
      openConnectorContext({
        type,
        connection: { id: "asset-1", revision: 1, config },
        egress: checker,
        credentials: {
          resolve: () => Promise.reject(new Error("no static secret here")),
          resolveSignIn: (input) => {
            signIns.push(input.origin);
            return Promise.resolve("access-token");
          }
        },
        ...(ownerOnly ? { personalDiscovery: { userId: "carol" } } : {}),
        signal: new AbortController().signal
      });
    return { open, signIns };
  }

  it("is refused for a private host the operator lists, before its sign-in is read", async () => {
    const own = openFor("https://inside.example.com/mcp", true);
    await denied(own.open());
    expect(own.signIns).toEqual([]);
    // An admin's Connection to the same host is reached through the private entry.
    const shared = openFor("https://inside.example.com/mcp", false);
    expect((await shared.open()).target).toMatchObject({ network: "private" });
  });

  it("checks every further target, a redirect's, by the own rule", async () => {
    const own = await openFor("https://notes.example.com/mcp", true).open();
    expect(own.target.address).toBe(PUBLIC);
    await denied(own.checkEgress(https("inside.example.com")));
    await denied(own.checkEgress({ protocol: "http", host: "notes.example.com", port: 80 }));
    const shared = await openFor("https://notes.example.com/mcp", false)
      .open()
      .catch(() => undefined);
    // An admin's Connection to an unlisted public host is refused: allowPublicHttps is off.
    expect(shared).toBeUndefined();
  });

  it("binds a checker to the Connection's rule, whatever a caller asks", async () => {
    const { checker } = checkerOf(allow, dns);
    const bound = egressOfConnection(checker, { ownerOnly: true });
    // A name is judged by its answers, so the save-time check admits it and the check does not.
    expect(bound.admits(https("inside.example.com"))).toBe(true);
    expect(bound.admits({ protocol: "http", host: "notes.example.com", port: 80 })).toBe(false);
    await denied(bound.check(https("inside.example.com"), "operator"));
    expect(bound.refusal(https("notes.example.com", 8443))?.message).toContain("'network: public'");
    const plain = egressOfConnection(checker, {});
    expect(await plain.check(https("inside.example.com"))).toMatchObject({ network: "private" });
  });
});

describe("the save of a self-added Connection", () => {
  const { checker } = checkerOf(
    [
      {
        protocol: "http",
        host: "127.0.0.1",
        port: 8080,
        network: "private",
        cidrs: ["127.0.0.1/32"]
      }
    ],
    {},
    { instanceUrl: INSTANCE_URL }
  );
  const kind = createConnectionAssetKind({
    connectorTypes: createConnectorTypeRegistry([createMcpConnectorType()]),
    egress: checker
  });

  function save(url: string, ownerOnly = true) {
    const definition = connection("notes", {
      connectorType: "mcp",
      credentialMode: "user",
      authScheme: "oauth",
      settings: { url },
      origin: "runtime",
      ownerPrincipalId: "user:carol",
      ...(ownerOnly ? { ownerOnly: true } : {})
    });
    const reading = kind.read([definition]);
    if (reading.refused.length > 0) {
      return reading.refused.flatMap((refused) => refused.issues.map((issue) => issue.message));
    }
    return reading
      .validateWrite({ definitions: () => reading.accepted, changes: () => true })
      .map((issue) => `${issue.code ?? ""} ${issue.message}`);
  }

  it("admits a public https address on 443", () => {
    expect(save("https://notes.example.com/mcp")).toEqual([]);
  });

  it("refuses http, another port, the instance and a private address, each with its sentence", () => {
    const [http] = save("http://127.0.0.1:8080/mcp");
    expect(http).toContain("egress_denied");
    expect(http).toContain("127.0.0.1:8080");
    expect(http).toContain("No setting allows another protocol");
    // The same address is admitted for an admin's Connection by the private entry.
    expect(save("http://127.0.0.1:8080/mcp", false)).toEqual([]);

    const [port] = save("https://notes.example.com:8443/mcp");
    expect(port).toContain("notes.example.com:8443");
    expect(port).toContain(
      "An operator adds another port under 'egress.allow' with 'network: public'"
    );

    const [instance] = save(`${INSTANCE_URL}/mcp`);
    expect(instance).toContain("this instance's own address");

    const [inside] = save("https://10.0.0.5/mcp");
    expect(inside).toContain("No setting lets a server a person adds for themselves reach it");
  });

  it("refuses a user name, a password, a query and a fragment", () => {
    for (const url of [
      "https://carol@notes.example.com/mcp",
      "https://carol:secret@notes.example.com/mcp",
      "https://notes.example.com/mcp?key=1",
      "https://notes.example.com/mcp#tools"
    ]) {
      expect(save(url), url).not.toEqual([]);
    }
  });
});
