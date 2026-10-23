import { describe, expect, it, vi } from "vitest";
import { useDataStoreWorld } from "./support/data-store-world";

const lookup = vi.hoisted(() =>
  vi.fn<(host: string, options: { all: true }) => Promise<{ address: string; family: number }[]>>()
);
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup
}));

describe("Data Store database addresses", () => {
  const { db, published, call } = useDataStoreWorld("data_store_addresses");

  it("resolves all addresses and reaches IPv4 after IPv6 refuses", async () => {
    // The normal test Postgres is published on IPv4 only. Its initial IPv6 answer must
    // not prevent provisioning and querying a store through the platform-owned server.
    lookup.mockResolvedValue([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 }
    ]);
    const world = await published("ipv4-only");
    const result = await call(world, "query", { sql: "select 1 as one" });

    expect(result).toMatchObject({ rows: [{ one: 1 }] });
    expect(lookup).toHaveBeenCalledWith(new URL(db.databaseUrl).hostname, { all: true });
  });
});
