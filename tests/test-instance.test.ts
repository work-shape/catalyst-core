import { orderedStoreCalls } from "./support/postgres-concurrency-harness";
import { required } from "./support/assertions";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PostgresFixtures, requiredTestDatabaseUrl } from "./support/postgres-fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { createTestConfig, seedConversationMessage } from "./support/fixtures";

const identities = ["owner", "other"].map((id) => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles: ["user"],
  permissionRefs: []
}));
const config = () =>
  createTestConfig({
    developmentAuth: { enabled: true, users: identities, defaultUserId: "owner" }
  });

describe("test instance", () => {
  it("exposes four capabilities and isolates identities and stores between files", async () => {
    const first = await createTestInstance({
      config: config(),
      tools: [],
      fixtureFile: "first-file"
    });
    const second = await createTestInstance({
      config: config(),
      tools: [],
      fixtureFile: "second-file"
    });
    expect(Object.keys(first).sort()).toEqual(["call", "close", "signIn", "stores"]);
    const owner = first.signIn("owner");
    const other = first.signIn("other");
    const created = await first.call(
      "createConversation",
      { payload: { title: "Owner's conversation" } },
      owner
    );
    expect(created.statusCode).toBe(200);
    const { id } = created.json<{ id: string }>();
    await seedConversationMessage(first.stores.conversations, id);
    expect(
      (await first.call("getConversationThread", { params: { conversationId: id } }, other))
        .statusCode
    ).toBe(404);
    expect(
      (await first.call("getConversationThread", { params: { conversationId: id } }, owner))
        .statusCode
    ).toBe(200);
    expect(
      (
        await second.call(
          "getConversationThread",
          { params: { conversationId: id } },
          second.signIn("owner")
        )
      ).statusCode
    ).toBe(404);
    expect((await first.call("listConversations", {}, owner)).json().items).toHaveLength(1);
    expect((await first.call("listConversations", {}, other)).json().items).toHaveLength(0);
    await first.close();
    expect((await second.call("getCurrentUser")).statusCode).toBe(200);
    await second.close();
  });

  it("preserves malformed input, statuses, headers and raw response bytes", async () => {
    const instance = await createTestInstance({
      config: config(),
      tools: [],
      allowedOrigins: "https://ui.example.test"
    });
    const malformed = await instance.call("createConversation", {
      payload: "{",
      headers: { "content-type": "application/json" }
    });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json()).toMatchObject({ error: { code: "INTERNAL" } });
    const response = await instance.call("getCurrentUser", {
      headers: { origin: "https://ui.example.test" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://ui.example.test");
    expect(response.rawPayload.toString()).toBe(response.body);
    const head = await instance.call("getCurrentUser", { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    await instance.close();
  });

  it.each([false, true])(
    "cleans resources after a successful or failed call (failure: %s)",
    async (failure) => {
      const cleanup = vi.fn(async () => {});
      const instance = await createTestInstance({
        config: config(),
        tools: [],
        capabilities: [
          {
            name: "cleanup-test",
            create() {
              return { close: cleanup };
            }
          }
        ]
      });
      try {
        if (failure)
          await expect(instance.call("getConversationThread")).rejects.toThrow(
            "Missing path parameter"
          );
        else expect((await instance.call("getCurrentUser")).statusCode).toBe(200);
      } finally {
        await instance.close();
      }
      await instance.close();
      expect(cleanup).toHaveBeenCalledTimes(1);
      await expect(instance.call("getCurrentUser")).rejects.toThrow("Test instance is closed");
      expect(() => instance.signIn("owner")).toThrow("Test instance is closed");
    }
  );

  it("gives different file fixtures independent state and safe repeated cleanup", async () => {
    const first = await createTestInstance({ postgres: { fixtureFile: "store-first-file" } });
    const second = await createTestInstance({ postgres: { fixtureFile: "store-second-file" } });
    const clientInstanceId = asClientInstanceId("store-only");
    await first.stores.users.createUser({ clientInstanceId, displayLabel: "Only in first" });
    expect(await first.stores.users.listUsers({ clientInstanceId })).toHaveLength(1);
    expect(await second.stores.users.listUsers({ clientInstanceId })).toEqual([]);
    await first.close();
    await first.close();
    await second.close();
  });
});

describe("Postgres fixture lifecycle", () => {
  it("drains an ordered race when BEGIN fails before the transaction callback", async () => {
    const instance = await createTestInstance();
    const failure = new Error("Simulated BEGIN failure");
    const transaction = vi.spyOn(instance.stores, "transaction").mockRejectedValueOnce(failure);
    const second = vi.fn(async () => undefined);
    const observer = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await expect(
        orderedStoreCalls(
          observer,
          { first: instance.stores, firstName: "failed-first", secondName: "unused-second" },
          async () => undefined,
          second
        )
      ).rejects.toBe(failure);
      expect(second).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
      await observer.end();
    }
  });

  it("shares the file database between pools and clones an already migrated template", async () => {
    const first = await createTestInstance();
    const second = await createTestInstance();
    const clientInstanceId = asClientInstanceId("same-file");
    const user = await first.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Shared by pools"
    });
    expect(await second.stores.users.listUsers({ clientInstanceId })).toEqual([user]);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const migrations = await sql`select hash from drizzle.__drizzle_migrations`;
      expect(migrations.length).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  });

  it.each([false, true])(
    "drops file databases and the template after success or failure (%s)",
    async (failure) => {
      const fixtures = new PostgresFixtures();
      const urls: string[] = [];
      try {
        urls.push(await fixtures.database("first.test.ts"));
        urls.push(await fixtures.database("second.test.ts"));
        expect(urls[0]).not.toBe(urls[1]);
        expect(await fixtures.database("first.test.ts")).toBe(urls[0]);
        const sql = postgres(required(urls[0]), { max: 1 });
        const second = postgres(required(urls[1]), { max: 1 });
        try {
          await sql`insert into product_users (id, client_instance_id, display_label, roles, permission_refs, permissions, status, created_at, updated_at) values ('fixture-user', 'fixture-client', 'Synthetic', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'active', now(), now())`;
          expect(await second`select id from product_users`).toEqual([]);
          if (failure)
            await expect(sql`select * from missing_fixture_table`).rejects.toMatchObject({
              code: "42P01"
            });
        } finally {
          await Promise.all([sql.end(), second.end()]);
        }
      } finally {
        await fixtures.close();
      }
      await fixtures.close();
      const admin = postgres(requiredTestDatabaseUrl(), { max: 1 });
      try {
        const databases = await admin<{ datname: string }[]>`select datname from pg_database`;
        expect(databases.filter(({ datname }) => datname.startsWith(fixtures.prefix))).toEqual([]);
      } finally {
        await admin.end();
      }
    }
  );

  it("refuses to drop a whole run through fixtures that only joined it", async () => {
    const owner = new PostgresFixtures();
    await expect(new PostgresFixtures(owner.prefix).close()).rejects.toThrow(
      "Only the owner of a test run drops all of its databases"
    );
  });

  it("uses CATALYST_TEST_MIGRATIONS_DIRECTORY for the template and all clones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "catalyst-test-migrations-"));
    let fixtures: PostgresFixtures | undefined;
    try {
      await mkdir(join(directory, "meta"));
      await writeFile(
        join(directory, "meta/_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [{ idx: 0, version: "7", when: 1, tag: "0000_probe", breakpoints: true }]
        })
      );
      await writeFile(
        join(directory, "0000_probe.sql"),
        "create table alternate_migrations_probe (id text primary key);"
      );
      vi.stubEnv("CATALYST_TEST_MIGRATIONS_DIRECTORY", directory);
      fixtures = new PostgresFixtures();
      for (const file of ["alternate-first.test.ts", "alternate-second.test.ts"]) {
        const sql = postgres(await fixtures.database(file), { max: 1 });
        try {
          expect(
            await sql`select to_regclass('alternate_migrations_probe')::text as marker, to_regclass('conversations')::text as conversations`
          ).toEqual([{ marker: "alternate_migrations_probe", conversations: null }]);
          expect(await sql`select * from drizzle.__drizzle_migrations`).toHaveLength(1);
        } finally {
          await sql.end();
        }
      }
    } finally {
      vi.unstubAllEnvs();
      await fixtures?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans up a template whose migrations fail", async () => {
    vi.stubEnv("CATALYST_TEST_MIGRATIONS_DIRECTORY", "/missing-catalyst-test-migrations");
    const fixtures = new PostgresFixtures();
    try {
      await expect(fixtures.database("failed.test.ts")).rejects.toThrow(
        "Postgres test fixture setup failed"
      );
    } finally {
      vi.unstubAllEnvs();
      await fixtures.close();
    }
    const admin = postgres(requiredTestDatabaseUrl(), { max: 1 });
    try {
      const databases = await admin<{ datname: string }[]>`select datname from pg_database`;
      expect(databases.filter(({ datname }) => datname.startsWith(fixtures.prefix))).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});
