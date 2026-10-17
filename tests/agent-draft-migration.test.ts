import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { PostgresFixtures } from "./support/postgres-fixtures";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));

describe("agent draft collapse (Platform Access 65)", () => {
  it("keeps the newest pending head, its author and every agent's highest counter, including settled proposals", async () => {
    const url = await fixtures.database(`agent_draft_${globalThis.crypto.randomUUID()}`, false);
    const sql = postgres(url, { max: 1 });
    try {
      // The populated TRY-1a1 tables, including settled counter rows. No runtime server writes here.
      await sql.unsafe(`
        CREATE TABLE agent_try_conversations (client_instance_id text, agent_id text, conversation_id text);
        CREATE TABLE config_assets (id text PRIMARY KEY);
        CREATE TABLE conversations (id text PRIMARY KEY, created_by_user_id text);
        CREATE TABLE agent_change_proposals (
          id text PRIMARY KEY, client_instance_id text NOT NULL, agent_id text NOT NULL REFERENCES config_assets(id),
          source_kind text NOT NULL, source_id text NOT NULL, base_revision integer NOT NULL, revision integer NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        );
        CREATE TABLE agent_change_proposal_revisions (
          proposal_id text REFERENCES agent_change_proposals(id) ON DELETE CASCADE,
          revision integer, config jsonb NOT NULL, created_at timestamptz NOT NULL,
          PRIMARY KEY(proposal_id, revision)
        );
        CREATE UNIQUE INDEX agent_change_proposals_source_idx ON agent_change_proposals(agent_id, source_kind, source_id);
        CREATE INDEX agent_change_proposals_of_source_idx ON agent_change_proposals(client_instance_id, source_kind, source_id);
        INSERT INTO config_assets VALUES ('a'), ('b'), ('c'), ('d');
        INSERT INTO conversations VALUES ('build_new', 'user_new'), ('build_old', 'user_old');
        INSERT INTO agent_change_proposals VALUES
          ('old', 'instance', 'a', 'conversation', 'build_old', 4, 3, now(), '2026-10-16'),
          ('new', 'instance', 'a', 'conversation', 'build_new', 4, 7, now(), '2026-10-17'),
          ('settled', 'instance', 'a', 'person', 'settled_user', 4, 12, now(), '2026-10-18'),
          ('person', 'instance', 'b', 'person', 'user_b', 2, 4, now(), '2026-10-17'),
          ('counter_low', 'instance', 'c', 'person', 'user_c1', 1, 2, now(), '2026-10-16'),
          ('counter_high', 'instance', 'c', 'person', 'user_c2', 1, 8, now(), '2026-10-17'),
          ('tie_a', 'instance', 'd', 'person', 'user_da', 1, 9, now(), '2026-10-17'),
          ('tie_z', 'instance', 'd', 'person', 'user_dz', 1, 2, now(), '2026-10-17');
        INSERT INTO agent_change_proposal_revisions VALUES
          ('old', 3, '{"instructions":"old"}', now()),
          ('new', 7, '{"instructions":"new"}', now()),
          ('person', 4, '{"instructions":"single"}', now()),
          ('tie_a', 9, '{"instructions":"tie a"}', now()),
          ('tie_z', 2, '{"instructions":"tie z"}', now());
      `);
      const source = (
        await Promise.all(
          ["0103_agent_draft", "0104_agent_draft_index"].map((name) =>
            readFile(`packages/postgres-store/migrations/${name}.sql`, "utf8")
          )
        )
      ).join("\n--> statement-breakpoint\n");
      for (const statement of source.split("--> statement-breakpoint"))
        if (statement.trim()) await sql.unsafe(statement);
      const rows =
        await sql`SELECT p.agent_id, p.revision, p.last_author_user_id, p.last_build_conversation_id, r.config
        FROM agent_change_proposals p LEFT JOIN agent_change_proposal_revisions r ON r.proposal_id=p.id AND r.revision=p.revision ORDER BY p.agent_id`;
      expect(rows).toEqual([
        {
          agent_id: "a",
          revision: 12,
          last_author_user_id: "user_new",
          last_build_conversation_id: "build_new",
          config: { instructions: "new" }
        },
        {
          agent_id: "b",
          revision: 4,
          last_author_user_id: "user_b",
          last_build_conversation_id: null,
          config: { instructions: "single" }
        },
        {
          agent_id: "c",
          revision: 8,
          last_author_user_id: "user_c2",
          last_build_conversation_id: null,
          config: null
        },
        {
          agent_id: "d",
          revision: 9,
          last_author_user_id: "user_dz",
          last_build_conversation_id: null,
          config: { instructions: "tie z" }
        }
      ]);
      expect(
        await sql`SELECT * FROM agent_change_proposal_revisions WHERE proposal_id IN ('old', 'settled', 'counter_low', 'tie_a')`
      ).toEqual([]);
    } finally {
      await sql.end();
      await fixtures.drop(url);
    }
  });
});
