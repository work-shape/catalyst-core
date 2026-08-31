import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const migrationsDirectory = resolve("packages/postgres-store/migrations");
const createdDatabases: string[] = [];

describePostgres("Collaboration Workspace migration 0020", () => {
  afterEach(async () => {
    while (createdDatabases.length > 0) {
      await dropDatabase(createdDatabases.pop()!);
    }
  });

  it("backfills every user and maps every existing conversation privately", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedProductUser(sql, "user_active", "active");
      await seedProductUser(sql, "user_inactive", "disabled");
      await seedConversation(sql, "conv_active", "user_active");
      await seedConversation(sql, "conv_inactive", "user_inactive");

      await applyMigration(sql, "0020_collaboration_workspaces");

      const workspaces = await sql<
        Array<{
          id: string;
          kind: string;
          visibility: string;
          personal_user_id: string;
        }>
      >`select id, kind, visibility, personal_user_id from collaboration_workspaces order by personal_user_id`;
      expect(workspaces).toHaveLength(2);
      expect(workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "personal",
            visibility: "private",
            personal_user_id: "user_active"
          }),
          expect.objectContaining({
            kind: "personal",
            visibility: "private",
            personal_user_id: "user_inactive"
          })
        ])
      );
      expect(workspaces.every((workspace) => /^cws_[0-9a-f-]{36}$/.test(workspace.id))).toBe(true);

      const memberships = await sql<
        Array<{ user_id: string; role: string; personal_user_id: string }>
      >`
        select membership.user_id, membership.role, workspace.personal_user_id
        from collaboration_workspace_memberships membership
        join collaboration_workspaces workspace
          on workspace.id = membership.collaboration_workspace_id
        order by membership.user_id
      `;
      expect(memberships).toEqual([
        { user_id: "user_active", role: "owner", personal_user_id: "user_active" },
        { user_id: "user_inactive", role: "owner", personal_user_id: "user_inactive" }
      ]);

      const conversations = await sql<
        Array<{ id: string; owner_user_id: string; personal_user_id: string }>
      >`
        select conversation.id, conversation.owner_user_id, workspace.personal_user_id
        from conversations conversation
        join collaboration_workspaces workspace
          on workspace.id = conversation.collaboration_workspace_id
        order by conversation.id
      `;
      expect(conversations).toEqual([
        { id: "conv_active", owner_user_id: "user_active", personal_user_id: "user_active" },
        {
          id: "conv_inactive",
          owner_user_id: "user_inactive",
          personal_user_id: "user_inactive"
        }
      ]);

      const [column] = await sql<Array<{ is_nullable: string }>>`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'conversations'
          and column_name = 'collaboration_workspace_id'
      `;
      expect(column?.is_nullable).toBe("NO");
      const [foreignKey] = await sql<Array<{ delete_action: string }>>`
        select confdeltype as delete_action
        from pg_constraint
        where conname = 'conversations_collaboration_workspace_fk'
      `;
      expect(foreignKey?.delete_action).toBe("r");
      const [index] = await sql<Array<{ indexname: string }>>`
        select indexname
        from pg_indexes
        where schemaname = 'public'
          and indexname = 'conversations_collaboration_workspace_idx'
      `;
      expect(index?.indexname).toBe("conversations_collaboration_workspace_idx");
      const [nonPrivate] = await sql<Array<{ count: string }>>`
        select count(*)::text as count
        from collaboration_workspaces
        where kind <> 'personal' or visibility <> 'private'
      `;
      expect(nonPrivate?.count).toBe("0");
    } finally {
      await sql.end();
    }
  });

  it("aborts when a conversation owner has no product user", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      // No foreign key exists from conversations.owner_user_id to product_users before 0020,
      // so this is a valid representation of the inconsistent legacy data guarded by the migration.
      await seedConversation(sql, "conv_orphan", "missing_user");

      await expect(applyMigration(sql, "0020_collaboration_workspaces")).rejects.toThrow(
        /left 1 conversation\(s\) unmapped/
      );
      const [column] = await sql<Array<{ count: string }>>`
        select count(*)::text as count
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'conversations'
          and column_name = 'collaboration_workspace_id'
      `;
      expect(column?.count).toBe("0");
    } finally {
      await sql.end();
    }
  });
});

async function applyMigrationsThrough(sql: Sql, finalIndex: number): Promise<void> {
  const journal = JSON.parse(
    await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8")
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= finalIndex)) {
    await applyMigration(sql, entry.tag);
  }
}

async function applyMigration(sql: Sql, tag: string): Promise<void> {
  const source = await readFile(resolve(migrationsDirectory, `${tag}.sql`), "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await sql.begin(async (transaction) => {
    for (const statement of statements) {
      await transaction.unsafe(statement);
    }
  });
}

async function seedProductUser(sql: Sql, id: string, status: "active" | "disabled"): Promise<void> {
  await sql`
    insert into product_users (
      id, client_instance_id, display_label, email, roles, permission_refs, permissions,
      status, created_at, updated_at
    ) values (
      ${id}, 'migration-test-client', ${id}, ${`${id}@example.test`}, ${sql.json(["user"])},
      ${sql.json([])}, ${sql.json([])}, ${status}, now(), now()
    )
  `;
}

async function seedConversation(sql: Sql, id: string, ownerUserId: string): Promise<void> {
  await sql`
    insert into conversations (
      id, client_instance_id, owner_user_id, owner_external_user_id, title, status,
      created_at, updated_at, retained_until
    ) values (
      ${id}, 'migration-test-client', ${ownerUserId}, ${ownerUserId}, ${id}, 'active',
      now(), now(), now() + interval '1 year'
    )
  `;
}

async function createFreshDatabase(): Promise<{ sql: Sql }> {
  const name = `catalyst_migration_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl!, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  createdDatabases.push(name);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return { sql: postgres(url.toString(), { max: 1 }) };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(databaseUrl!, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}
