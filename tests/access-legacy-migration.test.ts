import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import {
  LEGACY_LIST_GRANTOR,
  PERMISSIONS,
  asClientInstanceId,
  asUserId,
  legacyGrantRows
} from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import {
  frozenHasPermission,
  frozenLegacyFunctions,
  restoreLegacyColumns,
  runVerifyPermissions
} from "../scripts/verify-permissions";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { storesOn } from "./support/upgrade-database";

// AP-4: the legacy permission lists become instance-wide grant rows, and a credential without
// a scope list gets `["*"]`. A database is filled at the migration before, with the columns as
// a release before AP-4 wrote them, then migrated; the verification script then compares the
// frozen rules over the columns with the evaluator over the rows.

const MIGRATION = "legacy_permission_grants";
const instance = "legacy-migration";
const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A database migrated up to the migration before AP-4's, and a way to apply the rest. */
async function databaseBeforeMigration(): Promise<{
  databaseUrl: string;
  sql: Sql;
  migrate(): Promise<string[]>;
}> {
  const databaseUrl = await fixtures.database(`legacy-migration:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: MIGRATION, including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  return {
    databaseUrl,
    sql,
    async migrate() {
      const applied = await migrateDatabase({ databaseUrl });
      expect(applied).toContain(before.tag);
      return applied;
    }
  };
}

interface SeedUser {
  id: string;
  roles: string[];
  permissions: string[];
  refs?: string[];
  status?: "active" | "disabled";
  deleting?: boolean;
  clientInstanceId?: string;
}

async function seedUser(sql: Sql, user: SeedUser): Promise<void> {
  await sql`
    insert into product_users (
      id, client_instance_id, display_label, roles, permission_refs, permissions, status,
      deletion_requested_at, created_at, updated_at
    ) values (
      ${user.id}, ${user.clientInstanceId ?? instance}, ${user.id}, ${JSON.stringify(user.roles)}::text::jsonb,
      ${JSON.stringify(user.refs ?? [])}::text::jsonb, ${JSON.stringify(user.permissions)}::text::jsonb,
      ${user.status ?? "active"}, ${user.deleting ? new Date() : null}, now(), now()
    )
  `;
}

async function seedPrincipal(
  sql: Sql,
  principal: { id: string; permissions: string[]; status?: "active" | "disabled" }
): Promise<void> {
  await sql`
    insert into service_principals (
      id, client_instance_id, display_label, status, permission_refs, permissions, created_at, updated_at
    ) values (
      ${principal.id}, ${instance}, ${principal.id}, ${principal.status ?? "active"}, '[]'::jsonb,
      ${JSON.stringify(principal.permissions)}::text::jsonb, now(), now()
    )
  `;
}

/** `scopes` as the column held it: a SQL null, or the text of a JSON value. */
async function seedCredential(
  sql: Sql,
  credential: { id: string; principalId: string; scopes: string | null; revoked?: boolean }
): Promise<void> {
  await sql`
    insert into api_credentials (
      id, client_instance_id, service_principal_id, name, key_prefix, secret_hash, scopes,
      created_at, revoked_at
    ) values (
      ${credential.id}, ${instance}, ${credential.principalId}, ${credential.id},
      ${`prefix-${credential.id}`}, ${`hash-${credential.id}`}, ${credential.scopes}::text::jsonb, now(),
      ${credential.revoked ? new Date() : null}
    )
  `;
}

interface GrantRowView {
  holder_kind: string;
  holder_id: string;
  action: string;
  effect: string;
  scope_kind: string;
  granted_by: string;
}

async function grantRows(sql: Sql, holderId?: string): Promise<GrantRowView[]> {
  return holderId === undefined
    ? sql<GrantRowView[]>`
        select holder_kind, holder_id, action, effect, scope_kind, granted_by
        from permission_grants order by holder_kind, holder_id, action`
    : sql<GrantRowView[]>`
        select holder_kind, holder_id, action, effect, scope_kind, granted_by
        from permission_grants where holder_id = ${holderId} order by action, scope_kind`;
}

function sortedRows(rows: { action: string; effect: string }[]) {
  return [...rows]
    .map((row) => ({ action: row.action, effect: row.effect }))
    .sort((left, right) => left.action.localeCompare(right.action));
}

// Every key in every state a list can give it, each beside nothing else, and the lists that
// mix keys, name every key, revoke every key or hold entries that are no key.
const columns: string[][] = [
  [],
  ...PERMISSIONS.flatMap((key) => [[key], [`!${key}`], [key, `!${key}`], [`!${key}`, key]]),
  [...PERMISSIONS],
  PERMISSIONS.map((key) => `!${key}`),
  ["!config_assets.write", "config_assets.read", "usage.view", "!usage.view", "audit.view"],
  ["nonsense", "!nonsense", "agent.write", "!", "ref:demo-tools", "*"]
];
const roleSets = [[], ["user"], ["user", "admin"], ["user", "admin", "superadmin"], ["owner"]];

const principalColumns: Record<string, string[]> = {
  sp_none: [],
  sp_read: ["config_assets.read"],
  sp_release: ["config_assets.release"],
  sp_both: ["config_assets.read", "config_assets.release"],
  sp_revoked_read: ["!config_assets.read", "config_assets.release", "config_assets.read"],
  sp_odd: ["config_assets.read", "api_access.manage", "nonsense"]
};

// The column as it was, and what the migration makes of it.
const credentialScopes: { scopes: string | null; after: string[] }[] = [
  { scopes: null, after: ["*"] },
  { scopes: "null", after: ["*"] },
  { scopes: "[]", after: [] },
  { scopes: '["config_assets:read"]', after: ["config_assets:read"] },
  { scopes: '["config_assets:release"]', after: ["config_assets:release"] },
  {
    scopes: '["config_assets:read","config_assets:release"]',
    after: ["config_assets:read", "config_assets:release"]
  },
  {
    scopes: '["config_assets.read","config_assets.release"]',
    after: ["config_assets.read", "config_assets.release"]
  },
  { scopes: '["config_assets:write"]', after: ["config_assets:write"] },
  { scopes: '["*"]', after: [] },
  { scopes: '["config_assets:read","*"]', after: ["config_assets:read"] }
];

async function seedEveryCombination(sql: Sql) {
  const users: SeedUser[] = [];
  roleSets.forEach((roles, roleIndex) => {
    columns.forEach((permissions, columnIndex) => {
      users.push({ id: `usr_${roleIndex}_${columnIndex}`, roles, permissions });
    });
  });
  users.push(
    { id: "usr_refs", roles: ["user"], permissions: ["usage.view"], refs: ["demo-tools"] },
    {
      id: "usr_disabled",
      roles: ["user", "admin"],
      permissions: ["usage.view"],
      status: "disabled"
    },
    {
      id: "usr_deleting",
      roles: ["user", "admin"],
      permissions: ["config_assets.release"],
      deleting: true
    },
    {
      id: "usr_other_instance",
      roles: ["user"],
      permissions: ["audit.view"],
      clientInstanceId: "legacy-migration-other"
    }
  );
  for (const user of users) await seedUser(sql, user);

  for (const [id, permissions] of Object.entries(principalColumns)) {
    await seedPrincipal(sql, { id, permissions });
    for (const [index, credential] of credentialScopes.entries()) {
      await seedCredential(sql, {
        id: `cred_${id}_${index}`,
        principalId: id,
        scopes: credential.scopes
      });
    }
  }
  await seedPrincipal(sql, {
    id: "sp_disabled",
    permissions: ["config_assets.read"],
    status: "disabled"
  });
  await seedCredential(sql, { id: "cred_sp_disabled", principalId: "sp_disabled", scopes: null });
  await seedCredential(sql, {
    id: "cred_revoked",
    principalId: "sp_both",
    scopes: null,
    revoked: true
  });
  return users;
}

/** Holders of the small seed, used where an answer is made to differ on purpose. */
async function seedSmall(sql: Sql): Promise<void> {
  await seedUser(sql, {
    id: "usr_admin",
    roles: ["user", "admin"],
    permissions: ["!usage.view", "config_assets.release"],
    refs: ["demo-tools"]
  });
  await seedUser(sql, { id: "usr_plain", roles: ["user"], permissions: [] });
  await seedPrincipal(sql, {
    id: "sp_cli",
    permissions: ["config_assets.read", "config_assets.release"]
  });
  await seedCredential(sql, { id: "cred_unscoped", principalId: "sp_cli", scopes: null });
  await seedCredential(sql, {
    id: "cred_read",
    principalId: "sp_cli",
    scopes: '["config_assets:read"]'
  });
}

async function verify(databaseUrl: string, legacy = frozenLegacyFunctions) {
  const lines: string[] = [];
  const exitCode = await runVerifyPermissions({
    databaseUrl,
    write: (line) => lines.push(line),
    legacy
  });
  return { exitCode, lines, different: lines.filter((line) => line.startsWith("DIFFERENT")) };
}

describe("AP-4 migration: legacy lists become grant rows", () => {
  it("writes one instance row per action of every key a list names, and leaves the columns as they were", async () => {
    const database = await databaseBeforeMigration();
    const { sql } = database;
    const users = await seedEveryCombination(sql);
    const columnsBefore = {
      users:
        await sql`select id, permissions, permission_refs, roles, status from product_users order by id`,
      principals: await sql`select id, permissions from service_principals order by id`
    };

    await database.migrate();

    expect({
      users:
        await sql`select id, permissions, permission_refs, roles, status from product_users order by id`,
      principals: await sql`select id, permissions from service_principals order by id`
    }).toEqual(columnsBefore);

    const rows = await grantRows(sql);
    for (const row of rows) {
      expect(row).toMatchObject({ scope_kind: "instance", granted_by: LEGACY_LIST_GRANTOR });
    }
    for (const user of users) {
      const held = rows.filter((row) => row.holder_kind === "user" && row.holder_id === user.id);
      // A user whose deletion was requested holds nothing and gets no row.
      const expected = user.deleting ? [] : legacyGrantRows(user.permissions);
      expect(sortedRows(held), `${user.id} [${String(user.permissions)}]`).toEqual(
        sortedRows(expected)
      );
    }
    for (const [id, permissions] of Object.entries(principalColumns)) {
      const held = rows.filter(
        (row) => row.holder_kind === "service_principal" && row.holder_id === id
      );
      expect(sortedRows(held), id).toEqual(sortedRows(legacyGrantRows(permissions)));
    }
    // A revocation beside an entry of the same key is a deny, as the list read it.
    expect(sortedRows(rows.filter((row) => row.holder_id === "sp_revoked_read"))).toEqual(
      sortedRows([
        { action: "agent.read", effect: "deny" },
        { action: "skill.read", effect: "deny" },
        { action: "assets.release", effect: "allow" }
      ])
    );
  });

  it('gives a credential without a list `["*"]`, keeps an empty list empty and takes `*` out of a list', async () => {
    const database = await databaseBeforeMigration();
    const { sql } = database;
    await seedEveryCombination(sql);
    await database.migrate();

    const credentials = await sql<{ id: string; scopes: string[] | null }[]>`
      select id, scopes from api_credentials order by id
    `;
    for (const [id] of Object.entries(principalColumns)) {
      for (const [index, credential] of credentialScopes.entries()) {
        expect(
          credentials.find((row) => row.id === `cred_${id}_${index}`)?.scopes,
          `${id} ${String(credential.scopes)}`
        ).toEqual(credential.after);
      }
    }
    expect(credentials.find((row) => row.id === "cred_revoked")?.scopes).toEqual(["*"]);
    expect(credentials.every((row) => Array.isArray(row.scopes))).toBe(true);
  });

  it("keeps who wrote a row the holder already had, and a legacy revocation still denies", async () => {
    const database = await databaseBeforeMigration();
    const { sql } = database;
    await seedUser(sql, {
      id: "usr_revoked",
      roles: ["user", "admin"],
      permissions: ["!audit.view"]
    });
    await seedUser(sql, { id: "usr_denied", roles: ["user"], permissions: ["usage.view"] });
    await seedUser(sql, { id: "usr_scoped", roles: ["user"], permissions: ["config_assets.read"] });
    await sql`
      insert into permission_grants (
        id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, namespace,
        effect, granted_by, created_at
      ) values
        ('grant_kept_allow', ${instance}, 'user', 'usr_revoked', 'audit.view', 'instance', null, null, 'allow', 'usr_boss', '2026-10-01'),
        ('grant_kept_deny', ${instance}, 'user', 'usr_denied', 'usage.view', 'instance', null, null, 'deny', 'usr_boss', '2026-10-01'),
        ('grant_workspace', ${instance}, 'user', 'usr_scoped', 'agent.read', 'workspace', 'ws_1', null, 'allow', 'usr_boss', '2026-10-01')
    `;

    await database.migrate();

    const rows = await sql<
      {
        id: string;
        holder_id: string;
        action: string;
        scope_kind: string;
        effect: string;
        granted_by: string;
      }[]
    >`select id, holder_id, action, scope_kind, effect, granted_by from permission_grants order by holder_id, action, scope_kind`;
    expect(rows.filter((row) => row.holder_id === "usr_revoked")).toEqual([
      {
        id: "grant_kept_allow",
        holder_id: "usr_revoked",
        action: "audit.view",
        scope_kind: "instance",
        effect: "deny",
        granted_by: "usr_boss"
      }
    ]);
    expect(rows.filter((row) => row.holder_id === "usr_denied")).toEqual([
      {
        id: "grant_kept_deny",
        holder_id: "usr_denied",
        action: "usage.view",
        scope_kind: "instance",
        effect: "deny",
        granted_by: "usr_boss"
      }
    ]);
    expect(
      rows
        .filter((row) => row.holder_id === "usr_scoped")
        .map((row) => [row.action, row.scope_kind, row.effect, row.granted_by])
    ).toEqual([
      ["agent.read", "instance", "allow", LEGACY_LIST_GRANTOR],
      ["agent.read", "workspace", "allow", "usr_boss"],
      ["skill.read", "instance", "allow", LEGACY_LIST_GRANTOR]
    ]);
  });
});

describe("AP-4 verification script", () => {
  it("finds every right of every legacy combination unchanged after the migration", async () => {
    const database = await databaseBeforeMigration();
    await seedEveryCombination(database.sql);
    await database.migrate();

    const { exitCode, lines, different } = await verify(database.databaseUrl);
    expect(different).toEqual([]);
    expect(exitCode).toBe(0);
    const holderLines = lines.slice(0, -1);
    // Every user, every principal and every credential that is not revoked.
    const holders =
      roleSets.length * columns.length +
      4 +
      Object.keys(principalColumns).length * (1 + credentialScopes.length) +
      2;
    expect(holderLines).toHaveLength(holders);
    expect(lines.at(-1)).toBe(`${holders} holders, every right unchanged`);
    expect(holderLines.every((line) => line.startsWith("same "))).toBe(true);
    expect(lines.join("\n")).not.toContain("cred_revoked");
    expect(holderLines.find((line) => line.includes("user usr_deleting "))).toContain(
      "(deleting) keys=[] refs=[]"
    );
    expect(holderLines.find((line) => line.includes("user usr_refs "))).toContain(
      "keys=[usage.view] refs=[demo-tools]"
    );
    expect(holderLines.find((line) => line.includes("credential cred_sp_both_0 "))).toContain(
      "keys=[config_assets.read,config_assets.release]"
    );
    expect(holderLines.find((line) => line.includes("credential cred_sp_both_2 "))).toContain(
      "keys=[] "
    );
    expect(holderLines.find((line) => line.includes("credential cred_sp_both_9 "))).toContain(
      "keys=[config_assets.read] "
    );
  });

  it("names the holder and the action when a migrated row is missing or has the wrong effect", async () => {
    const database = await databaseBeforeMigration();
    await seedSmall(database.sql);
    await database.migrate();
    expect((await verify(database.databaseUrl)).exitCode).toBe(0);

    await database.sql`
      delete from permission_grants where holder_id = 'usr_admin' and action = 'assets.release'
    `;
    await database.sql`
      update permission_grants set effect = 'allow'
      where holder_id = 'usr_admin' and action = 'usage.view'
    `;
    const { exitCode, lines, different } = await verify(database.databaseUrl);
    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toBe("1 of 5 holders differ");
    expect(different).toEqual([
      expect.stringContaining(
        "user usr_admin (active) keys=[agent_skills.approve,config_assets.read,config_assets.write,usage.view,users.manage,audit.view] refs=[demo-tools] :: config_assets.release: legacy true, evaluator false; usage.view: legacy false, evaluator true"
      )
    ]);
  });

  it("finds a single action of a key that a row narrows", async () => {
    const database = await databaseBeforeMigration();
    await seedSmall(database.sql);
    await database.migrate();
    const stores = await storesOn(database.databaseUrl);
    cleanups.push(() => stores.close());
    await stores.access.createGrant({
      clientInstanceId: asClientInstanceId(instance),
      holderKind: "user",
      holderId: "usr_admin",
      action: "agent.write",
      effect: "deny",
      scopeKind: "instance",
      grantedBy: asUserId("usr_boss")
    });
    await database.sql`
      update permission_grants set effect = 'deny'
      where holder_kind = 'service_principal' and action = 'skill.read'
    `;
    const { exitCode, different } = await verify(database.databaseUrl);
    expect(exitCode).toBe(1);
    expect(different).toEqual([
      expect.stringContaining("user usr_admin "),
      expect.stringContaining("service_principal sp_cli "),
      expect.stringContaining("credential cred_read of sp_cli"),
      expect.stringContaining("credential cred_unscoped of sp_cli")
    ]);
    expect(different[0]).toContain(":: config_assets.write: legacy true, evaluator false");
    expect(different[1]).toContain(":: config_assets.read: legacy true, evaluator false");
  });

  // The credential lists are rewritten in place, so the script reads them as they are now; the
  // tests above prove what the migration makes of each. A release before AP-4 that runs beside
  // this one during a deploy still writes null for a credential without a list.
  it("reads a credential with null, as a release before AP-4 writes it, as one without a list", async () => {
    const database = await databaseBeforeMigration();
    await seedSmall(database.sql);
    await database.migrate();
    await seedCredential(database.sql, {
      id: "cred_written_old",
      principalId: "sp_cli",
      scopes: null
    });
    const { exitCode, lines } = await verify(database.databaseUrl);
    expect(exitCode).toBe(0);
    expect(lines.find((line) => line.includes("credential cred_written_old "))).toContain(
      "keys=[config_assets.read,config_assets.release]"
    );
  });

  it("fails when the frozen rules are tampered with", async () => {
    const database = await databaseBeforeMigration();
    await seedSmall(database.sql);
    await database.migrate();

    const keys = await verify(database.databaseUrl, {
      ...frozenLegacyFunctions,
      hasPermission: (subject, key) =>
        key === "audit.view" ? false : frozenHasPermission(subject, key)
    });
    expect(keys.exitCode).toBe(1);
    expect(keys.different).toEqual([expect.stringContaining("user usr_admin (active)")]);
    expect(keys.different[0]).toContain(":: audit.view: legacy false, evaluator true");

    const refs = await verify(database.databaseUrl, {
      ...frozenLegacyFunctions,
      hasPermissionRef: () => false
    });
    expect(refs.exitCode).toBe(1);
    expect(refs.different.join("\n")).toContain("ref:demo-tools: legacy false, evaluator true");

    // The admin, the principal and its unrestricted credential hold the release key.
    const release = await verify(database.databaseUrl, {
      ...frozenLegacyFunctions,
      hasPermission: (subject, key) =>
        key === "config_assets.release" ? false : frozenHasPermission(subject, key)
    });
    expect(release.exitCode).toBe(1);
    expect(release.lines.at(-1)).toBe("3 of 5 holders differ");
  });
});

describe("AP-4 rollback: the columns back for a release that reads them", () => {
  it('writes the rows back into the columns and `["*"]` back to null', async () => {
    const database = await databaseBeforeMigration();
    const { sql, databaseUrl } = database;
    await seedSmall(sql);
    await seedCredential(sql, { id: "cred_star", principalId: "sp_cli", scopes: '["*"]' });
    await database.migrate();

    // A change made after the migration lives only in the rows.
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    await stores.users.updateUser({
      clientInstanceId: asClientInstanceId(instance),
      userId: asUserId("usr_admin"),
      permissions: ["config_assets.release", "audit.view", "!users.manage"],
      grantedBy: asUserId("usr_boss")
    });
    expect((await sql`select permissions from product_users where id = 'usr_admin'`)[0]).toEqual({
      permissions: ["!usage.view", "config_assets.release"]
    });

    const lines: string[] = [];
    expect(await restoreLegacyColumns({ sql, write: (line) => lines.push(line) })).toBe(2);
    expect(lines).toEqual([
      "restored   user usr_admin [!usage.view,config_assets.release] -> [config_assets.release,!users.manage,audit.view]",
      'restored   credential cred_unscoped ["*"] -> null',
      "2 rows restored for a release that reads the legacy columns"
    ]);
    expect(await sql`select id, permissions from product_users order by id`).toEqual([
      { id: "usr_admin", permissions: ["config_assets.release", "!users.manage", "audit.view"] },
      { id: "usr_plain", permissions: [] }
    ]);
    expect(await sql`select id, scopes from api_credentials order by id`).toEqual([
      { id: "cred_read", scopes: ["config_assets:read"] },
      // `*` had given nothing before the migration, which took it out.
      { id: "cred_star", scopes: [] },
      { id: "cred_unscoped", scopes: null }
    ]);

    // The columns now say what the rows say: the frozen rules agree with the evaluator.
    const after = await verify(databaseUrl);
    expect(after.different).toEqual([]);
    expect(after.exitCode).toBe(0);

    const again: string[] = [];
    expect(await restoreLegacyColumns({ sql, write: (line) => again.push(line) })).toBe(0);
    expect(again).toEqual(["0 rows restored for a release that reads the legacy columns"]);
  });
});
