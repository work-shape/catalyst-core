import { describe, expect, it, vi } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createInstanceConnections, resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  egressTargetOfUrl,
  pinnedLookup,
  platformStoreTargetsOf
} from "@vivd-catalyst/connections";
import { AppError, asClientInstanceId, type Logger } from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import { checkerOf, denied, https } from "./support/egress";
import { createTestConfig } from "./support/fixtures";
import { generateTestSecret } from "./support/test-connector";
import { createTestInstance } from "./support/test-instance";

// How addresses are read for the egress checker: the Platform Store's own, and one a
// connector was handed.

describe("the Platform Store's address", () => {
  // Each test fails without the change: an address that could not be read gave an empty
  // deny list, silently.
  it("is read as host and port, and as nothing where host and port cannot be read", () => {
    const password = generateTestSecret();
    const none = {};
    expect(
      platformStoreTargetsOf(`postgres://user:${password}@db.internal:6432/app`, none)
    ).toEqual([{ host: "db.internal", port: 6432 }]);
    expect(platformStoreTargetsOf("postgresql://DB.internal/app?sslmode=require", none)).toEqual([
      { host: "db.internal", port: 5432 }
    ]);
    expect(platformStoreTargetsOf("postgres://user@[fd00::2]:5433/app", none)).toEqual([
      { host: "fd00::2", port: 5433 }
    ]);
    // Fails without the change: a second host without a port was read as port 5432, where
    // the driver gives it the first host's port, and `PGPORT` was not looked at.
    for (const address of [
      `postgres://u:${password}@a.internal:6432,b.internal/app`,
      "postgres://a.internal:5432,b.internal:5433/app",
      "postgres://a.internal,b.internal/app"
    ]) {
      expect(platformStoreTargetsOf(address, none), address).toBeUndefined();
    }
    const elsewhere = { PGPORT: "6432" };
    expect(platformStoreTargetsOf("postgres://db.internal/app", elsewhere)).toBeUndefined();
    expect(platformStoreTargetsOf("postgres://db.internal:5432/app", elsewhere)).toEqual([
      { host: "db.internal", port: 5432 }
    ]);
    expect(platformStoreTargetsOf("postgres://db.internal/app", { PGPORT: "" })).toEqual([
      { host: "db.internal", port: 5432 }
    ]);
    for (const address of [
      "postgres:///app?host=/var/run/postgresql",
      "postgres://%2Fvar%2Frun%2Fpostgresql/app",
      `postgres://user:${password}@db.internal/app?host=other.internal`,
      "postgres://db.internal/app?port=6432",
      "postgres://db.internal:99999/app",
      "postgres://a.internal,/app",
      "host=db.internal port=5432 dbname=app",
      "mysql://db.internal/app",
      ""
    ]) {
      expect(platformStoreTargetsOf(address, none), address).toBeUndefined();
    }
  });

  it("refuses every postgres target while it is unknown, and leaves other protocols to the list", async () => {
    const inside = { network: "private" as const, cidrs: ["172.28.0.0/16"] };
    const { checker, asked } = checkerOf(
      [
        { protocol: "postgres", host: "warehouse", port: 5432, ...inside },
        { protocol: "postgres", host: "172.28.0.9", port: 6432, ...inside },
        { host: "api.example.com" }
      ],
      { warehouse: ["172.28.0.9"], "api.example.com": ["93.184.216.34"] },
      { platformStoreUnknown: true }
    );
    await denied(checker.check({ protocol: "postgres", host: "warehouse", port: 5432 }));
    await denied(checker.check({ protocol: "postgres", host: "172.28.0.9", port: 6432 }));
    expect(asked).toEqual([]);
    expect((await checker.check(https("api.example.com"))).address).toBe("93.184.216.34");
  });

  it("is warned about once at start when it cannot be read, without the address", async () => {
    const password = generateTestSecret();
    const start = async (databaseUrl: string) => {
      const warnings: string[] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (input, message) => warnings.push(JSON.stringify([input, message])),
        error: () => undefined,
        child: () => logger
      };
      const config = parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { connections: { enabled: true } },
        egress: {
          allow: [
            {
              protocol: "postgres",
              host: "172.28.0.9",
              port: 5432,
              network: "private",
              cidrs: ["172.28.0.0/16"]
            }
          ]
        }
      });
      const connections = required(
        await createInstanceConnections({
          config,
          modules: resolveInstanceModules(config).snapshot,
          clientInstanceId: asClientInstanceId(config.clientInstance.id),
          secrets: { resolve: () => Promise.resolve(databaseUrl) },
          stores: (await createTestInstance({ postgres: {} })).stores,
          logger
        })
      );
      const granted = await connections.egress
        .check({ protocol: "postgres", host: "172.28.0.9", port: 5432 })
        .then(
          () => true,
          () => false
        );
      return { warnings, granted };
    };
    const unknown = await start(`postgres://user:${password}@/app?host=/var/run/postgresql`);
    expect(unknown.granted).toBe(false);
    expect(unknown.warnings).toHaveLength(1);
    expect(unknown.warnings[0]).toContain("could not be read as host and port");
    expect(unknown.warnings[0]).not.toContain(password);
    expect(unknown.warnings[0]).not.toContain("/var/run");

    // Fails without the change: there was no warning, and the second host was read with
    // port 5432 where the driver connects to it on 6432.
    const several = await start(`postgres://user:${password}@172.28.0.2:6432,172.28.0.9/app`);
    expect(several.granted).toBe(false);
    expect(several.warnings).toHaveLength(1);
    expect(several.warnings[0]).not.toContain("172.28.0.2");

    // An address without a port is exact only while the process sets no PGPORT.
    vi.stubEnv("PGPORT", "6432");
    try {
      const moved = await start(`postgres://user:${password}@172.28.0.2/app`);
      expect(moved.granted).toBe(false);
      expect(moved.warnings).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }

    // A Store at a literal address needs no resolver to be told apart from the target.
    const known = await start(`postgres://user:${password}@172.28.0.2:5432/app`);
    expect(known.warnings).toEqual([]);
    expect(known.granted).toBe(true);
  });
});

describe("an address a connector was handed", () => {
  it("is read as protocol, host and port, with the default port of its scheme", () => {
    expect(egressTargetOfUrl("https://API.example.com/mcp?x=1")).toEqual(https("api.example.com"));
    expect(egressTargetOfUrl("http://mcp-demo:8080/mcp")).toEqual({
      protocol: "http",
      host: "mcp-demo",
      port: 8080
    });
    expect(egressTargetOfUrl("postgresql://db.example.com/sales")).toEqual({
      protocol: "postgres",
      host: "db.example.com",
      port: 5432
    });
    expect(egressTargetOfUrl("https://[::ffff:127.0.0.1]/")).toMatchObject({ port: 443 });
  });

  it("is refused with a user name or a password, an unknown scheme or no host, without repeating it", () => {
    const password = generateTestSecret();
    for (const address of [
      `https://user:${password}@api.example.com/`,
      `https://${password}@api.example.com/`,
      "ftp://api.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "//api.example.com/",
      "not a url",
      ""
    ]) {
      let error: unknown;
      try {
        egressTargetOfUrl(address);
      } catch (caught) {
        error = caught;
      }
      if (!(error instanceof AppError)) throw new Error(`Expected a refusal of '${address}'`);
      expect(error.details).toMatchObject({ reason: "egress_denied" });
      expect(JSON.stringify([error.message, error.details])).not.toContain(password);
    }
  });

  it("pins a socket to the checked address and resolves no other name", async () => {
    const { checker } = checkerOf([{ host: "api.example.com" }], {
      "api.example.com": ["93.184.216.34"]
    });
    const lookup = pinnedLookup(await checker.check(https("api.example.com")));
    const one = await new Promise<unknown[]>((resolve) =>
      lookup("api.example.com", {}, (...answer) => resolve(answer))
    );
    expect(one).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup("API.example.com.", { all: true }, (...answer) => resolve(answer))
    );
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
    const other = await new Promise<unknown[]>((resolve) =>
      lookup("evil.example.com", {}, (...answer) => resolve(answer))
    );
    expect(other[0]).toMatchObject({ code: "ENOTFOUND" });
  });
});
