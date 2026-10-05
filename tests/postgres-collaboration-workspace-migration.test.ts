import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const migrationsDirectory = resolve("packages/postgres-store/migrations");
const preflightScript = resolve("scripts/preflight-collaboration-workspaces.mjs");
const createdDatabases: string[] = [];
const runFile = promisify(execFile);

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

  it("passes the read-only preflight when conversation owners map to users", async () => {
    const { sql, databaseUrl: testDatabaseUrl } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedProductUser(sql, "mapped_user", "active");
      await seedConversation(sql, "mapped_conversation", "mapped_user");

      const { stdout } = await runFile(process.execPath, [preflightScript], {
        env: { ...process.env, DATABASE_URL: testDatabaseUrl }
      });

      expect(stdout).toContain("Product users: 1");
      expect(stdout).toContain("Active conversations: 1");
      expect(stdout).toContain("Unmapped conversations: 0");
      expect(stdout).toContain("Unmapped active conversations: 0");
      expect(stdout).toContain("Unmapped non-active conversations: 0");
      expect(stdout).toContain("Preflight passed");
    } finally {
      await sql.end();
    }
  });

  it("fails the read-only preflight when conversation owners are unmapped in any status", async () => {
    const { sql, databaseUrl: testDatabaseUrl } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedConversation(sql, "active_orphaned_conversation", "missing_active_user");
      await seedConversation(sql, "deleted_orphaned_conversation", "missing_deleted_user");
      await sql`
        update conversations
        set status = 'deleted'
        where id = 'deleted_orphaned_conversation'
      `;

      const failure = await runFile(process.execPath, [preflightScript], {
        env: { ...process.env, DATABASE_URL: testDatabaseUrl }
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 1 });
      expect((failure as { stdout: string }).stdout).toContain("Unmapped conversations: 2");
      expect((failure as { stdout: string }).stdout).toContain("Unmapped active conversations: 1");
      expect((failure as { stdout: string }).stdout).toContain(
        "Unmapped non-active conversations: 1"
      );
      expect((failure as { stderr: string }).stderr).toContain("Do not deploy migration 0020");
    } finally {
      await sql.end();
    }
  });

  it("renames Conversation creator columns in 0021 without changing stored values", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedProductUser(sql, "creator_user", "active");
      await sql`
        insert into conversations (
          id, client_instance_id, owner_user_id, owner_external_user_id, title, status,
          created_at, updated_at, retained_until
        ) values (
          'conv_creator', 'migration-test-client', 'creator_user', 'external_creator',
          'Creator rename', 'active', now(), now(), now() + interval '1 year'
        )
      `;
      await applyMigration(sql, "0020_collaboration_workspaces");
      await applyMigration(sql, "0021_conversation_creator_attribution");

      const [conversation] = await sql<
        Array<{ created_by_user_id: string; created_by_external_user_id: string }>
      >`
        select created_by_user_id, created_by_external_user_id
        from conversations
        where id = 'conv_creator'
      `;
      expect(conversation).toEqual({
        created_by_user_id: "creator_user",
        created_by_external_user_id: "external_creator"
      });
      const oldColumns = await sql<Array<{ column_name: string }>>`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'conversations'
          and column_name in ('owner_user_id', 'owner_external_user_id')
      `;
      expect(oldColumns).toEqual([]);
      const ownerIndexes = await sql<Array<{ indexname: string }>>`
        select indexname
        from pg_indexes
        where schemaname = 'public'
          and indexname in ('conversations_owner_idx', 'conversations_owner_user_idx')
      `;
      expect(ownerIndexes).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("backfills the latest provider continuations without removing legacy metadata in 0022", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedProductUser(sql, "continuation_user", "active");
      await seedConversation(sql, "conv_continuation", "continuation_user");
      await applyMigration(sql, "0020_collaboration_workspaces");
      await applyMigration(sql, "0021_conversation_creator_attribution");

      for (const [id, providerId, state, createdAt] of [
        ["msg_provider_a_old", "provider-a", { value: "old" }, "2026-01-01T10:00:00Z"],
        ["msg_provider_b", "provider-b", { value: "other" }, "2026-01-01T10:01:00Z"],
        ["msg_provider_a_new", "provider-a", { value: "new" }, "2026-01-01T10:02:00Z"]
      ] as const) {
        await sql`
          insert into messages (
            id, client_instance_id, conversation_id, role, text, created_at, metadata
          ) values (
            ${id}, 'migration-test-client', 'conv_continuation', 'assistant', ${id},
            ${createdAt},
            ${sql.json({
              agentRuntime: {
                version: 1,
                kind: "assistant_final",
                runId: `run_${id}`,
                finishStatus: "completed",
                providerContinuation: { providerId, state }
              }
            })}
          )
        `;
      }

      await applyMigration(sql, "0022_lethal_titania");

      const continuations = await sql<
        Array<{ provider_id: string; state: unknown; source_message_id: string }>
      >`
        select provider_id, state, source_message_id
        from model_provider_continuations
        order by provider_id
      `;
      expect(continuations).toEqual([
        {
          provider_id: "provider-a",
          state: { value: "new" },
          source_message_id: "msg_provider_a_new"
        },
        {
          provider_id: "provider-b",
          state: { value: "other" },
          source_message_id: "msg_provider_b"
        }
      ]);
      const [legacyMetadata] = await sql<Array<{ count: string }>>`
        select count(*)::text as count
        from messages
        where (metadata -> 'agentRuntime') ? 'providerContinuation'
      `;
      expect(legacyMetadata?.count).toBe("3");
    } finally {
      await sql.end();
    }
  });

  it("backfills existing conversations and workspaces to workspace visibility in 0027", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 19);
      await seedProductUser(sql, "visibility_user", "active");
      await seedConversation(sql, "conv_personal", "visibility_user");
      await applyMigrationsThrough26From20(sql);
      await sql`
        insert into collaboration_workspaces (
          id, client_instance_id, kind, name, visibility, created_at, updated_at
        ) values (
          'cws_shared', 'migration-test-client', 'shared', 'Shared', 'discoverable', now(), now()
        )
      `;
      await sql`
        insert into conversations (
          id, client_instance_id, collaboration_workspace_id, created_by_user_id,
          created_by_external_user_id, title, status, created_at, updated_at, retained_until
        ) values (
          'conv_shared', 'migration-test-client', 'cws_shared', 'visibility_user',
          'visibility_user', 'Shared', 'active', now(), now(), now() + interval '1 year'
        )
      `;

      await applyMigration(sql, "0027_conversation_visibility");

      await expect(sql`select id, visibility from conversations order by id`).resolves.toEqual([
        { id: "conv_personal", visibility: "workspace" },
        { id: "conv_shared", visibility: "workspace" }
      ]);
      await expect(
        sql`select kind, default_conversation_visibility from collaboration_workspaces order by kind`
      ).resolves.toEqual([
        { kind: "personal", default_conversation_visibility: "workspace" },
        { kind: "shared", default_conversation_visibility: "workspace" }
      ]);

      // The backfill default is gone: an insert that forgets visibility must fail.
      await expect(
        sql`
          insert into conversations (
            id, client_instance_id, collaboration_workspace_id, created_by_user_id,
            created_by_external_user_id, title, status, created_at, updated_at, retained_until
          ) values (
            'conv_unstamped', 'migration-test-client', 'cws_shared', 'visibility_user',
            'visibility_user', 'Unstamped', 'active', now(), now(), now() + interval '1 year'
          )
        `
      ).rejects.toMatchObject({ code: "23502" });
      await expect(
        sql`
          update collaboration_workspaces
          set default_conversation_visibility = 'private'
          where kind = 'personal'
        `
      ).rejects.toMatchObject({
        constraint_name: "collaboration_workspaces_personal_conversation_visibility_check"
      });
      await sql`
        update collaboration_workspaces
        set default_conversation_visibility = 'private'
        where id = 'cws_shared'
      `;
      await expect(
        sql`
          select indexname from pg_indexes
          where schemaname = 'public' and indexname = 'conversations_workspace_visibility_idx'
        `
      ).resolves.toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("marks existing usage events as not fast in 0029 without touching their settlement", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 28);
      await sql`
        insert into model_usage_events (
          id, client_instance_id, conversation_id, agent_run_id, agent_name, provider_id, model,
          input_tokens, output_tokens, total_tokens, source, customer_billable_cost,
          correlation_id, created_at
        ) values (
          'usage_before', 'migration-test-client', 'conv_1', 'run_1', 'agent', 'azure-eu', 'gpt',
          10, 5, 15, 'provider_reported', ${sql.json({ status: "settled", totalCostMicros: 42 })},
          'corr_1', now()
        )
      `;

      await applyMigration(sql, "0029_usage_fast_mode");

      await expect(
        sql`
          select fast_mode, provider_service_tier, customer_billable_cost
          from model_usage_events
        `
      ).resolves.toEqual([
        {
          fast_mode: false,
          provider_service_tier: null,
          customer_billable_cost: { status: "settled", totalCostMicros: 42 }
        }
      ]);
      await sql`
        update model_usage_events set fast_mode = true, provider_service_tier = 'priority'
      `;
      await expect(
        sql`select count(*)::int as fast from model_usage_events where fast_mode`
      ).resolves.toEqual([{ fast: 1 }]);
    } finally {
      await sql.end();
    }
  });

  it("backfills every active agent to availability 'all' in 0028", async () => {
    const { sql } = await createFreshDatabase();
    try {
      await applyMigrationsThrough(sql, 27);
      for (const [id, kind, status] of [
        ["cfga_active", "agent", "active"],
        ["cfga_deleted", "agent", "deleted"],
        ["cfga_skill", "skill", "active"]
      ] as const) {
        await sql`
          insert into config_assets (
            id, client_instance_id, kind, name, status, active_revision_id, created_at, updated_at
          ) values (
            ${id}, 'migration-test-client', ${kind}, ${id}, ${status}, ${`${id}_rev`}, now(), now()
          )
        `;
      }

      await applyMigration(sql, "0028_agent_availability");

      await expect(
        sql`
          select asset_id, client_instance_id, mode, personal_workspaces
          from config_asset_availability
        `
      ).resolves.toEqual([
        {
          asset_id: "cfga_active",
          client_instance_id: "migration-test-client",
          mode: "all",
          personal_workspaces: false
        }
      ]);
      await expect(
        sql`update config_asset_availability set mode = 'some' where asset_id = 'cfga_active'`
      ).rejects.toMatchObject({ constraint_name: "config_asset_availability_mode_check" });
      await expect(sql`select * from config_asset_workspace_availability`).resolves.toEqual([]);
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

async function applyMigrationsThrough26From20(sql: Sql): Promise<void> {
  const journal = JSON.parse(
    await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8")
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of journal.entries.filter(
    (candidate) => candidate.idx >= 20 && candidate.idx <= 26
  )) {
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

async function createFreshDatabase(): Promise<{ sql: Sql; databaseUrl: string }> {
  const name = `catalyst_migration_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl!, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  createdDatabases.push(name);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return { sql: postgres(url.toString(), { max: 1 }), databaseUrl: url.toString() };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(databaseUrl!, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}
