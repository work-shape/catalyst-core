import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { PostgresFixtures } from "./support/postgres-fixtures";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));

describe("Try rekey migration (AD-2)", () => {
  it("keeps the newest per person and agent, retains replaced rows and detaches Build", async () => {
    const url = await fixtures.database(`try_rekey_${globalThis.crypto.randomUUID()}`, false);
    const sql = postgres(url, { max: 1 });
    try {
      await sql.unsafe(`
        CREATE TABLE conversations (id text PRIMARY KEY, created_by_user_id text NOT NULL);
        CREATE TABLE model_usage_events (id text);
        INSERT INTO conversations VALUES ('build1','person'), ('build2','person'), ('build3','other'),
          ('old','person'), ('new','person'), ('other','other'), ('second_agent','person');
      `);
      for (const name of ["0093_agent_try_conversations"]) {
        const source = await readFile(`packages/postgres-store/migrations/${name}.sql`, "utf8");
        for (const statement of source.split("--> statement-breakpoint"))
          if (statement.trim()) await sql.unsafe(statement);
      }
      await sql.unsafe(`INSERT INTO agent_try_conversations VALUES
        ('old','instance','build1','agent','2026-10-17',NULL),
        ('new','instance','build2','agent','2026-10-18',NULL),
        ('other','instance','build3','agent','2026-10-17',NULL),
        ('second_agent','instance','build1','agent2','2026-10-17',NULL)`);
      for (const name of ["0134_agent_try_per_person", "0135_agent_try_person_index"]) {
        const source = await readFile(`packages/postgres-store/migrations/${name}.sql`, "utf8");
        for (const statement of source.split("--> statement-breakpoint"))
          if (statement.trim()) await sql.unsafe(statement);
      }
      expect(
        await sql`SELECT conversation_id FROM agent_try_conversations WHERE replaced_at IS NULL ORDER BY conversation_id`
      ).toEqual([
        { conversation_id: "new" },
        { conversation_id: "other" },
        { conversation_id: "second_agent" }
      ]);
      expect(
        await sql`SELECT conversation_id FROM agent_try_conversations WHERE replaced_at IS NOT NULL`
      ).toEqual([{ conversation_id: "old" }]);
      await sql`DELETE FROM conversations WHERE id LIKE 'build%'`;
      expect(await sql`SELECT count(*)::int AS count FROM agent_try_conversations`).toEqual([
        { count: 4 }
      ]);
      await expect(
        sql`INSERT INTO agent_try_conversations (conversation_id, client_instance_id, agent_id, created_by_user_id, created_at) VALUES ('buildless','instance','agent','person',now())`
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await sql.end();
      await fixtures.drop(url);
    }
  });
});
