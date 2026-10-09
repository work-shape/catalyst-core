import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "@vivd-catalyst/api-contract";
import type { Logger } from "@vivd-catalyst/core";
import { READINESS_DATABASE_TIMEOUT_MS } from "@vivd-catalyst/postgres-store";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, type TestInstance } from "./support/test-instance";

const journal: { entries: { tag: string }[] } = JSON.parse(
  readFileSync(resolve("packages/postgres-store/migrations/meta/_journal.json"), "utf8")
);
const newestMigration = journal.entries.at(-1)?.tag;

/** Everything of the connection string an answer must not repeat. */
async function connectionParts(): Promise<string[]> {
  const url = new URL(await fileTestDatabaseUrl());
  return [url.hostname, url.port, url.username, url.password, url.pathname.slice(1)].filter(
    (part) => part.length > 0
  );
}

async function ready(instance: TestInstance) {
  const response = await instance.call("ready.get");
  for (const part of await connectionParts()) expect(response.body).not.toContain(part);
  const body: unknown = response.json();
  return { status: response.statusCode, body };
}

async function withDatabase<Result>(
  use: (sql: ReturnType<typeof postgres>) => Promise<Result>
): Promise<Result> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
  try {
    return await use(sql);
  } finally {
    await sql.end();
  }
}

describe("GET /ready", () => {
  it("answers 200 with the newest migration on a migrated database, without a credential", async () => {
    const instance = await createTestInstance();
    expect(newestMigration).toBeDefined();
    expect(await ready(instance)).toEqual({
      status: 200,
      body: { status: "ready", migration: newestMigration }
    });
  });

  it("answers 503 database_behind and names the migration the database lacks", async () => {
    const instance = await createTestInstance();
    await instance.call("health.get");
    await withDatabase(async (sql) => {
      const [removed] = await sql<{ hash: string; created_at: string }[]>`
        delete from drizzle.__drizzle_migrations
        where created_at = (select max(created_at) from drizzle.__drizzle_migrations)
        returning hash, created_at
      `;
      if (!removed) throw new Error("The test database holds no migration");
      try {
        expect(await ready(instance)).toEqual({
          status: 503,
          body: { status: "not_ready", reason: "database_behind", missing: [newestMigration] }
        });
      } finally {
        await sql`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${removed.hash}, ${removed.created_at})
        `;
      }
    });
    expect((await ready(instance)).status).toBe(200);
  });

  it("answers 503 database_unreachable within the timeout once the pool is closed", async () => {
    const instance = await createTestInstance();
    await instance.call("health.get");
    await instance.stores.close();
    const started = Date.now();
    expect(await ready(instance)).toEqual({
      status: 503,
      body: { status: "not_ready", reason: "database_unreachable" }
    });
    expect(Date.now() - started).toBeLessThan(READINESS_DATABASE_TIMEOUT_MS);
    // The process is up all the same.
    expect((await instance.call("health.get")).statusCode).toBe(200);
  });

  it("answers 503 database_unreachable at the timeout when the database does not answer", async () => {
    const instance = await createTestInstance();
    await instance.call("health.get");
    await withDatabase(async (sql) => {
      const session = await sql.reserve();
      try {
        // The lock keeps the migration read waiting, as a database that hangs would.
        await session`begin`;
        await session`lock table drizzle.__drizzle_migrations in access exclusive mode`;
        const started = Date.now();
        expect(await ready(instance)).toEqual({
          status: 503,
          body: { status: "not_ready", reason: "database_unreachable" }
        });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(READINESS_DATABASE_TIMEOUT_MS - 50);
        expect(elapsed).toBeLessThan(READINESS_DATABASE_TIMEOUT_MS + 1_500);

        // Ten more probes, after one already gave up: all wait on the one read under way.
        const again = Date.now();
        const answers = await Promise.all(Array.from({ length: 10 }, () => ready(instance)));
        expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(503));
        expect(Date.now() - again).toBeLessThan(READINESS_DATABASE_TIMEOUT_MS + 1_500);
        const [waiting] = await session<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `;
        expect(waiting?.count).toBe(1);
      } finally {
        await session`rollback`;
        session.release();
      }
    });
    expect((await ready(instance)).status).toBe(200);
  });

  it("logs the class and code of a failed read, and nothing of the connection", async () => {
    const logged: unknown[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (input, message) => void logged.push({ input, message }),
      error() {},
      child: () => logger
    };
    const { stores } = await createTestInstance({ postgres: { logger } });
    await stores.close();
    expect(await stores.readiness()).toEqual({
      status: "not_ready",
      reason: "database_unreachable"
    });
    expect(logged).toEqual([
      {
        input: { errorClass: "Error", code: "CONNECTION_ENDED" },
        message: "Readiness check could not read the database"
      }
    ]);
  });

  it("is listed in the document unversioned, without security, with both answers", () => {
    const operation = createOpenApiDocument().paths["/ready"]?.get;
    expect(operation).toMatchObject({
      operationId: "ready.get",
      security: [],
      responses: {
        "200": {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Ready" } } }
        },
        "503": {
          content: { "application/json": { schema: { $ref: "#/components/schemas/NotReady" } } }
        }
      }
    });
  });
});
