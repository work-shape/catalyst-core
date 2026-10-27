import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { PostgresFixtures } from "./support/postgres-fixtures";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));

describe("publications backfill (APPVER-1)", () => {
  it("gives each published asset version 1 of its live revision, credited from the newest retained publish event", async () => {
    const url = await fixtures.database(`publications_${globalThis.crypto.randomUUID()}`, false);
    const sql = postgres(url, { max: 1, onnotice() {} });
    try {
      // The tables the backfill reads, as the release before it leaves them.
      await sql.unsafe(`
        CREATE TABLE config_assets (
          id text PRIMARY KEY, client_instance_id text NOT NULL, kind text NOT NULL, name text NOT NULL,
          published_revision_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        );
        CREATE TABLE config_asset_revisions (
          id text PRIMARY KEY, asset_id text NOT NULL REFERENCES config_assets(id), revision integer NOT NULL
        );
        CREATE TABLE audit_events (
          id text PRIMARY KEY, client_instance_id text NOT NULL, type text NOT NULL, status text NOT NULL,
          actor jsonb, created_at timestamptz NOT NULL, metadata jsonb NOT NULL
        );
        INSERT INTO config_assets VALUES
          ('credited', 'instance', 'app', 'credited', 'credited_3', '2026-10-01', '2026-10-20'),
          ('pruned', 'instance', 'workflow', 'pruned', 'pruned_2', '2026-10-01', '2026-10-21'),
          ('recreated', 'instance', 'app', 'recreated', 'recreated_1', '2026-10-10', '2026-10-22'),
          ('draft', 'instance', 'app', 'draft', NULL, '2026-10-01', '2026-10-23');
        INSERT INTO config_asset_revisions VALUES
          ('credited_2', 'credited', 2), ('credited_3', 'credited', 3),
          ('pruned_2', 'pruned', 2), ('recreated_1', 'recreated', 1), ('draft_1', 'draft', 1);
        INSERT INTO audit_events VALUES
          ('e1', 'instance', 'app.published', 'success', '{"displayLabel":"Old","roles":[]}', '2026-10-05',
            '{"kind":"app","name":"credited","revision":3}'),
          ('e2', 'instance', 'app.published', 'success', '{"displayLabel":"Root","userId":"usr_root","roles":[]}', '2026-10-06',
            '{"kind":"app","name":"credited","revision":3}'),
          ('e3', 'instance', 'app.published', 'success', '{"displayLabel":"Later","roles":[]}', '2026-10-07',
            '{"kind":"app","name":"credited","revision":2}'),
          ('e4', 'instance', 'app.published', 'failure', '{"displayLabel":"Refused","roles":[]}', '2026-10-08',
            '{"kind":"app","name":"credited","revision":3}'),
          ('e5', 'other', 'app.published', 'success', '{"displayLabel":"Elsewhere","roles":[]}', '2026-10-09',
            '{"kind":"app","name":"credited","revision":3}'),
          ('e6', 'instance', 'app.published', 'success', '{"displayLabel":"Before","roles":[]}', '2026-10-02',
            '{"kind":"app","name":"recreated","revision":1}');
      `);
      const source = await readFile(
        "packages/postgres-store/migrations/0158_config_asset_publications.sql",
        "utf8"
      );
      for (const statement of source.split("--> statement-breakpoint"))
        if (statement.trim()) await sql.unsafe(statement);
      const rows = await sql<
        { asset_id: string; revision: number; number: number; by: string | null; at: Date }[]
      >`SELECT asset_id, revision, number, actor->>'displayLabel' AS by, published_at AS at
        FROM config_asset_publications ORDER BY asset_id`;
      expect(rows.map((row) => ({ ...row, at: row.at.toISOString() }))).toEqual([
        // The newest successful event of this instance for the live revision.
        {
          asset_id: "credited",
          revision: 3,
          number: 1,
          by: "Root",
          at: new Date("2026-10-06").toISOString()
        },
        // No retained event: the asset's last change, and nobody named.
        {
          asset_id: "pruned",
          revision: 2,
          number: 1,
          by: null,
          at: new Date("2026-10-21").toISOString()
        },
        // An event from before the asset was created is of an earlier asset of the name.
        {
          asset_id: "recreated",
          revision: 1,
          number: 1,
          by: null,
          at: new Date("2026-10-22").toISOString()
        }
      ]);
      expect(
        (await sql`SELECT id FROM config_asset_publications`).every(({ id }) =>
          String(id).startsWith("publication_")
        )
      ).toBe(true);
      // A second publish of an asset takes the next number; the same number twice is refused.
      await expect(
        sql`INSERT INTO config_asset_publications (id, client_instance_id, asset_id, revision, number, published_at)
          VALUES ('again', 'instance', 'credited', 3, 1, now())`
      ).rejects.toThrow(/config_asset_publications_asset_number_idx/u);
      // The publications go with their asset.
      await sql`DELETE FROM config_asset_revisions WHERE asset_id = 'pruned'`;
      await sql`DELETE FROM config_assets WHERE id = 'pruned'`;
      expect(
        await sql`SELECT count(*)::int AS n FROM config_asset_publications WHERE asset_id = 'pruned'`
      ).toEqual([{ n: 0 }]);
    } finally {
      await sql.end();
    }
  });
});
