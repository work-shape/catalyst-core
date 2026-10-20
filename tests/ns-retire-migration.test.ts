import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import {
  asClientInstanceId,
  createAuthorizer,
  type AccessResource
} from "@work-shape/catalyst-core";
import { migrateDatabase } from "@work-shape/catalyst-postgres-store";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { storesOn } from "./support/upgrade-database";

// NS-RETIRE in one step: a database is filled at the migration before, with the rows a release
// before wrote, then migrated. Every right that is left covers what it covered before, and
// nothing more.

const MIGRATION = "retire_namespaces";
const instance = "ns-retire";
const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function databaseBeforeMigration() {
  const databaseUrl = await fixtures.database(`ns-retire:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: MIGRATION, including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  await seedUser(sql, "usr_admin", ["admin"]);
  await seedUser(sql, "usr_kai", ["user"]);
  await sql`
    insert into collaboration_workspaces (
      id, client_instance_id, kind, name, visibility, created_at, updated_at
    ) values
      ('cws_kai', ${instance}, 'shared', 'Kai Spezis', 'internal', now(), now()),
      ('cws_other', ${instance}, 'shared', 'Others', 'internal', now(), now())`;
  return { databaseUrl, sql, tag: before.tag };
}

async function seedUser(sql: Sql, id: string, roles: string[]) {
  await sql`
    insert into product_users (
      id, client_instance_id, display_label, roles, permission_refs, permissions, status,
      created_at, updated_at
    ) values (
      ${id}, ${instance}, ${id}, ${JSON.stringify(roles)}::text::jsonb, '[]'::jsonb,
      '[]'::jsonb, 'active', now(), now()
    )`;
}

async function seedAsset(
  sql: Sql,
  asset: { id: string; kind: string; name: string; workspaceId?: string; status?: string }
) {
  await sql`
    insert into config_assets (
      id, client_instance_id, kind, name, status, active_revision_id, scope_kind, scope_id,
      created_at, updated_at
    ) values (
      ${asset.id}, ${instance}, ${asset.kind}, ${asset.name}, ${asset.status ?? "active"},
      ${`rev_${asset.id}`}, ${asset.workspaceId === undefined ? "instance" : "workspace"},
      ${asset.workspaceId ?? null}, now(), now()
    )`;
}

async function seedPrefixGrant(
  sql: Sql,
  grant: { id: string; action: string; prefix: string; effect?: "allow" | "deny" }
) {
  await sql`
    insert into permission_grants (
      id, client_instance_id, holder_kind, holder_id, action, effect, scope_kind, namespace,
      granted_by, created_at
    ) values (
      ${grant.id}, ${instance}, 'user', 'usr_kai', ${grant.action}, ${grant.effect ?? "allow"},
      'namespace', ${grant.prefix}, 'usr_admin', now()
    )`;
}

async function seedAssetGrant(
  sql: Sql,
  grant: { id: string; action: string; assetId: string; effect: "allow" | "deny" }
) {
  await sql`
    insert into permission_grants (
      id, client_instance_id, holder_kind, holder_id, action, effect, scope_kind, scope_id,
      granted_by, created_at
    ) values (
      ${grant.id}, ${instance}, 'user', 'usr_kai', ${grant.action}, ${grant.effect}, 'asset',
      ${grant.assetId}, 'usr_admin', now()
    )`;
}

async function seedKey(sql: Sql, id: string, scopes: string[]) {
  await sql`
    insert into api_credentials (
      id, client_instance_id, owner_user_id, name, key_prefix, secret_hash, scopes, created_at
    ) values (
      ${id}, ${instance}, 'usr_kai', ${id}, ${`prefix-${id}`}, ${`hash-${id}`},
      ${JSON.stringify(scopes)}::text::jsonb, now()
    )`;
}

/** The instance a release before held: Kai's rights reach the agents and skills under `kai-`. */
async function seedPrefixRights(sql: Sql) {
  await sql`
    insert into namespaces (
      client_instance_id, prefix, display_name, allowed_tool_names, created_by
    ) values (${instance}, 'kai-', 'Kai', '["read_skill"]'::jsonb, 'usr_admin')`;
  await seedAsset(sql, { id: "ast_helper", kind: "agent", name: "kai-helper" });
  await seedAsset(sql, { id: "ast_tax", kind: "agent", name: "kai-tax" });
  await seedAsset(sql, { id: "ast_notes", kind: "skill", name: "kai-notes" });
  // Not under the prefix, gone, or a workspace's own: the prefix covered none of them.
  await seedAsset(sql, { id: "ast_kaiser", kind: "agent", name: "kaiser" });
  await seedAsset(sql, { id: "ast_old", kind: "agent", name: "kai-old", status: "deleted" });
  await seedAsset(sql, { id: "ast_team", kind: "agent", name: "kai-team", workspaceId: "cws_kai" });
  await seedPrefixGrant(sql, { id: "grant_write", action: "agent.write", prefix: "kai-" });
  await seedPrefixGrant(sql, { id: "grant_read", action: "agent.read", prefix: "kai-" });
  await seedPrefixGrant(sql, { id: "grant_skill", action: "skill.read", prefix: "kai-" });
  // Rows Kai holds already on one asset stay as they are: the read beside the prefix, and the
  // deny that refused one write of it.
  await seedAssetGrant(sql, {
    id: "grant_own_read",
    action: "agent.read",
    assetId: "ast_helper",
    effect: "allow"
  });
  await seedAssetGrant(sql, {
    id: "grant_tax_deny",
    action: "agent.write",
    assetId: "ast_tax",
    effect: "deny"
  });
  await seedKey(sql, "apic_mixed", ["agent.read", "agent.write:kai-", "skill.read:kai-"]);
  await seedKey(sql, "apic_prefix", ["agent.write:kai-"]);
  await seedKey(sql, "apic_plain", ["agent.read", "skill.read"]);
}

interface GrantView {
  id: string;
  action: string;
  effect: string;
  scope_kind: string;
  scope_id: string | null;
}

async function grantsOfKai(sql: Sql) {
  return sql<GrantView[]>`
    select id, action, effect, scope_kind, scope_id from permission_grants
    where holder_id = 'usr_kai' order by action, scope_id, effect`;
}

describe("NS-RETIRE migration", () => {
  it("turns each prefix allow into allows on exactly the assets it covered, with audit", async () => {
    const { databaseUrl, sql, tag } = await databaseBeforeMigration();
    await seedPrefixRights(sql);

    expect(await migrateDatabase({ databaseUrl })).toContain(tag);

    const rows = await grantsOfKai(sql);
    expect(rows.map(({ id: _id, ...row }) => row)).toEqual([
      { action: "agent.read", effect: "allow", scope_kind: "asset", scope_id: "ast_helper" },
      { action: "agent.read", effect: "allow", scope_kind: "asset", scope_id: "ast_tax" },
      { action: "agent.write", effect: "allow", scope_kind: "asset", scope_id: "ast_helper" },
      { action: "agent.write", effect: "deny", scope_kind: "asset", scope_id: "ast_tax" },
      { action: "skill.read", effect: "allow", scope_kind: "asset", scope_id: "ast_notes" }
    ]);
    // The rows Kai held already keep their ids; no row was written next to them.
    expect(
      rows.find((row) => row.scope_id === "ast_helper" && row.action === "agent.read")?.id
    ).toBe("grant_own_read");
    expect(rows.find((row) => row.effect === "deny")?.id).toBe("grant_tax_deny");

    const audit = await sql<{ type: string; subject: string; metadata: Record<string, unknown> }[]>`
      select type, subject, metadata from audit_events
      where correlation_id = 'migration:0127_retire_namespaces' and reason = 'namespace_retired'
        and actor is null
      order by type, subject`;
    const granted = rows.filter((row) => !["grant_own_read", "grant_tax_deny"].includes(row.id));
    expect(audit.filter((event) => event.type === "permission.granted")).toEqual(
      expect.arrayContaining(
        granted.map((row) =>
          expect.objectContaining({
            subject: row.id,
            metadata: {
              grantId: row.id,
              holderKind: "user",
              holderId: "usr_kai",
              action: row.action,
              effect: "allow",
              scopeKind: "asset",
              scopeId: row.scope_id
            }
          })
        )
      )
    );
    expect(audit.filter((event) => event.type === "permission.granted")).toHaveLength(
      granted.length
    );
    expect(
      audit.filter((event) => event.type === "permission.revoked").map((event) => event.subject)
    ).toEqual(["grant_read", "grant_skill", "grant_write"]);
    expect(audit.filter((event) => event.type === "namespace.deleted")).toEqual([
      {
        type: "namespace.deleted",
        subject: "kai-",
        metadata: { prefix: "kai-", restrictsTools: true, restrictsModels: false }
      }
    ]);

    // The table and the scope kind are gone; no row can name a prefix again.
    const [table] = await sql<{ name: string | null }[]>`select to_regclass('namespaces') as name`;
    expect(table?.name).toBeNull();
    await expect(
      sql`insert into permission_grants (
            id, client_instance_id, holder_kind, holder_id, action, effect, scope_kind,
            granted_by, created_at
          ) values ('grant_new', ${instance}, 'user', 'usr_kai', 'agent.write', 'allow',
            'namespace', 'usr_admin', now())`
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("takes the prefix scopes out of personal keys, with audit, and leaves the others", async () => {
    const { databaseUrl, sql } = await databaseBeforeMigration();
    await seedPrefixRights(sql);

    await migrateDatabase({ databaseUrl });

    const keys = await sql<{ id: string; scopes: string[] }[]>`
      select id, scopes from api_credentials order by id`;
    expect(keys).toEqual([
      { id: "apic_mixed", scopes: ["agent.read"] },
      { id: "apic_plain", scopes: ["agent.read", "skill.read"] },
      { id: "apic_prefix", scopes: [] }
    ]);
    const narrowed = await sql<{ subject: string; metadata: Record<string, unknown> }[]>`
      select subject, metadata from audit_events
      where type = 'api_access.personal_key_narrowed' and reason = 'namespace_retired'
      order by subject`;
    expect(narrowed).toEqual([
      {
        subject: "apic_mixed",
        metadata: {
          keyId: "apic_mixed",
          ownerUserId: "usr_kai",
          removedScopes: ["agent.write:kai-", "skill.read:kai-"],
          remainingScopeCount: 1
        }
      },
      {
        subject: "apic_prefix",
        metadata: {
          keyId: "apic_prefix",
          ownerUserId: "usr_kai",
          removedScopes: ["agent.write:kai-"],
          remainingScopeCount: 0
        }
      }
    ]);
  });

  it("leaves Kai no right beyond the assets the prefix covered, with or without a key", async () => {
    const { databaseUrl, sql } = await databaseBeforeMigration();
    await seedPrefixRights(sql);
    await migrateDatabase({ databaseUrl });
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());

    const kai = (keyScopes?: string[]) =>
      createAuthorizer(stores.access).forActor({
        id: "usr_kai",
        externalUserId: "kai",
        displayLabel: "Kai",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId: asClientInstanceId(instance),
        authSource: "test",
        ...(keyScopes === undefined ? {} : { keyScopes })
      });
    const agent = (assetId: string, name: string, workspaceId?: string): AccessResource => ({
      kind: "agent",
      assetId,
      name,
      ...(workspaceId === undefined ? {} : { workspaceId })
    });
    const writes = async (keyScopes?: string[]) => {
      const access = await kai(keyScopes);
      return Object.fromEntries(
        [
          agent("ast_helper", "kai-helper"),
          agent("ast_tax", "kai-tax"),
          agent("ast_kaiser", "kaiser"),
          agent("ast_new", "kai-new"),
          agent("ast_team", "kai-team", "cws_kai")
        ].map((resource) => [resource.name, access.authorize("agent.write", resource).allowed])
      );
    };

    // Signed in: the write the prefix gave on kai-helper; the deny still refuses kai-tax; an
    // agent made later under the prefix is no longer reached.
    expect(await writes()).toEqual({
      "kai-helper": true,
      "kai-tax": false,
      kaiser: false,
      "kai-new": false,
      "kai-team": false
    });
    // A scope left in a key as a prefix names a workspace that does not exist and covers
    // nothing. A workspace scope covers only what that workspace owns, and only where Kai
    // holds the right there, which Kai does not.
    const nothing = {
      "kai-helper": false,
      "kai-tax": false,
      kaiser: false,
      "kai-new": false,
      "kai-team": false
    };
    expect(await writes(["agent.write:kai-"])).toEqual(nothing);
    expect(await writes(["agent.write:cws_kai"])).toEqual(nothing);

    // Once an administrator grants the write on Kai Spezis, the workspace key writes its own
    // agents only, and the plain key still nothing of another workspace.
    await sql`
      insert into permission_grants (
        id, client_instance_id, holder_kind, holder_id, action, effect, scope_kind, scope_id,
        granted_by, created_at
      ) values ('grant_team', ${instance}, 'user', 'usr_kai', 'agent.write', 'allow',
        'workspace', 'cws_kai', 'usr_admin', now())`;
    expect(await writes(["agent.write:cws_kai"])).toEqual({ ...nothing, "kai-team": true });
    const other = await kai(["agent.write:cws_kai"]);
    expect(
      other.authorize("agent.write", agent("ast_elsewhere", "kai-elsewhere", "cws_other")).allowed
    ).toBe(false);
  });

  it("stops at a prefix deny and names it, changing nothing", async () => {
    const { databaseUrl, sql } = await databaseBeforeMigration();
    await seedPrefixRights(sql);
    await seedPrefixGrant(sql, {
      id: "grant_deny",
      action: "skill.write",
      prefix: "kai-",
      effect: "deny"
    });

    await expect(migrateDatabase({ databaseUrl })).rejects.toThrow(
      `instance ${instance}, user usr_kai, skill.write in Namespace kai-`
    );

    const [table] = await sql<{ name: string | null }[]>`select to_regclass('namespaces') as name`;
    expect(table?.name).toBe("namespaces");
    const prefixRows = await sql<{ id: string }[]>`
      select id from permission_grants where scope_kind = 'namespace' order by id`;
    expect(prefixRows.map((row) => row.id)).toEqual([
      "grant_deny",
      "grant_read",
      "grant_skill",
      "grant_write"
    ]);
    const keys = await sql<{ scopes: string[] }[]>`
      select scopes from api_credentials where id = 'apic_prefix'`;
    expect(keys).toEqual([{ scopes: ["agent.write:kai-"] }]);
    const [audit] = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_events where reason = 'namespace_retired'`;
    expect(audit?.count).toBe(0);
  });
});
