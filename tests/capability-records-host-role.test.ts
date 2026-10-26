import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { capabilityStoresOf } from "@work-shape/catalyst-client-assembly";
import { createPostgresCapabilityRecords } from "@work-shape/catalyst-postgres-store";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { usePostgresSuite } from "./support/postgres-suite";

// EW-9: the public host of `outside-forms` connects with a role of its own. Postgres holds that
// role to the capability's rows of `capability_records`, and the platform's own access does not
// change. The role is made as the operator runbook says (docs: Operate > Deployment, the outside
// forms host's database role).

const at = "2026-10-26T10:00:00.000Z";
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const HOST_ROLE = `catalyst_outside_forms_${suffix}`;
/** The same grants under a name without the prefix: row-level security does not hold it. */
const MISNAMED_ROLE = `forms_host_${suffix}`;
/** A role such as an operator's read-only inspection role: neither owner nor superuser. */
const INSPECTION_ROLE = `inspection_${suffix}`;
const PASSWORD = "host-role-test";

describe("the outside forms host's database role", () => {
  const db = usePostgresSuite("capability_records_host_role");
  const opened: postgres.Sql[] = [];
  let host: postgres.Sql;
  let hostUrl: string;
  let misnamedUrl: string;

  function urlAs(role: string): string {
    const url = new URL(db.databaseUrl);
    url.username = role;
    url.password = PASSWORD;
    return url.toString();
  }

  function connect(url: string): postgres.Sql {
    const sql = postgres(url, { max: 1, onnotice() {} });
    opened.push(sql);
    return sql;
  }

  beforeAll(async () => {
    const database = new URL(db.databaseUrl).pathname.slice(1);
    for (const role of [HOST_ROLE, MISNAMED_ROLE]) {
      // The runbook's statements, as the owner of the platform database runs them.
      await db.sql.unsafe(`
        create role "${role}" login nosuperuser nocreatedb nocreaterole noinherit noreplication
          nobypassrls connection limit 8 password '${PASSWORD}';
        alter role "${role}" set temp_file_limit = '64MB';
        grant connect on database "${database}" to "${role}";
        grant usage on schema public to "${role}";
        grant select, insert, update on table capability_records to "${role}";
      `);
    }
    await db.sql.unsafe(`
      create role "${INSPECTION_ROLE}" login nosuperuser nobypassrls password '${PASSWORD}';
      grant connect on database "${database}" to "${INSPECTION_ROLE}";
      grant select, insert, update, delete on table capability_records to "${INSPECTION_ROLE}";
    `);
    hostUrl = urlAs(HOST_ROLE);
    misnamedUrl = urlAs(MISNAMED_ROLE);
    host = connect(hostUrl);
  });

  afterAll(async () => {
    await Promise.all(opened.map((sql) => sql.end({ timeout: 0 })));
    for (const role of [HOST_ROLE, MISNAMED_ROLE, INSPECTION_ROLE])
      await db.sql.unsafe(`drop owned by "${role}"; drop role "${role}"`);
  });

  /** One record of `capability` written by the platform, as the instance side writes it. */
  async function platformRecord(label: string, capability: string, id: string) {
    const clientInstanceId = db.clientInstance(label);
    const { records } = capabilityStoresOf({
      clientInstanceId,
      capability,
      store: db.store,
      operations: () => new Set()
    });
    await records.create({ kind: "form", id, status: "open", document: { id }, at });
    return { clientInstanceId, records };
  }

  async function refused(statement: Promise<unknown>): Promise<string> {
    const error: unknown = await statement.then(
      () => undefined,
      (failure: unknown) => failure
    );
    if (!(error instanceof postgres.PostgresError)) throw new Error("Postgres took the statement");
    expect(error.code).toBe("42501");
    return error.message;
  }

  it("reads and writes the records of outside-forms only", async () => {
    const own = await platformRecord("own", "outside-forms", "form-own");
    const other = await platformRecord("other", "document-processing", "form-other");

    const seen = await host<{ id: string; capability: string }[]>`
      select id, capability from capability_records
      where client_instance_id in (${own.clientInstanceId}, ${other.clientInstanceId})
    `;
    expect(seen).toEqual([{ id: "form-own", capability: "outside-forms" }]);

    // Another capability's row is invisible to an update, which so changes nothing.
    const changed = await host`
      update capability_records set status = 'taken'
      where client_instance_id = ${other.clientInstanceId}
    `;
    expect(changed.count).toBe(0);
    await expect(other.records.get({ kind: "form", id: "form-other" })).resolves.toMatchObject({
      status: "open"
    });

    expect(
      await refused(host`
        insert into capability_records
          (client_instance_id, capability, kind, id, status, document, created_at, updated_at)
        values (${own.clientInstanceId}, 'document-processing', 'form', 'planted', 'open', '{}',
          now(), now())
      `)
    ).toMatch(/row-level security/u);
    // Its own row cannot be moved to another capability either.
    expect(
      await refused(host`
        update capability_records set capability = 'document-processing'
        where client_instance_id = ${own.clientInstanceId}
      `)
    ).toMatch(/row-level security/u);
    await refused(
      host`delete from capability_records where client_instance_id = ${own.clientInstanceId}`
    );
    await refused(host`truncate capability_records`);

    // What it may do: insert and change its own records.
    await host`
      insert into capability_records
        (client_instance_id, capability, kind, id, status, document, created_at, updated_at)
      values (${own.clientInstanceId}, 'outside-forms', 'code', 'c1', 'pending', '{}', now(), now())
    `;
    const updated = await host`
      update capability_records set status = 'sent' where client_instance_id = ${own.clientInstanceId}
    `;
    expect(updated.count).toBe(2);
  });

  it("reaches no other table, sequence or function of the platform", async () => {
    await refused(host`select count(*) from product_users`);
    await refused(host`select count(*) from operation_runs`);
    await refused(host`select count(*) from audit_events`);
    await refused(host`select * from drizzle.__drizzle_migrations`);
    await refused(host`select nextval('drizzle.__drizzle_migrations_id_seq')`);
    await refused(host`update workflow_runs set status = 'done'`);
    await refused(host.unsafe(`set role "${new URL(db.databaseUrl).username}"`));
  });

  it("is refused every change of the schema", async () => {
    const statements = [
      "create table public.planted (id text)",
      "create view public.planted as select * from capability_records",
      "create function public.planted() returns int language sql as 'select 1'",
      "create schema planted",
      "alter table capability_records disable row level security",
      "alter table capability_records no force row level security",
      "alter table capability_records add column planted text",
      'drop policy "capability_records_outside_forms_host" on capability_records',
      'alter policy "capability_records_by_grant" on capability_records using (true)',
      'create policy "planted" on capability_records using (true)',
      "drop table capability_records",
      `alter role "${HOST_ROLE}" bypassrls`,
      `alter role "${HOST_ROLE}" rename to "planted"`
    ];
    const taken: string[] = [];
    for (const statement of statements) {
      const error: unknown = await host.unsafe(statement).then(
        () => undefined,
        (failure: unknown) => failure
      );
      if (!(error instanceof postgres.PostgresError)) taken.push(statement);
    }
    expect(taken).toEqual([]);
    // Postgres answers a grant of privileges the role holds without the grant option with a
    // warning, and grants nothing.
    await host`grant select on capability_records to public`;
    const [{ granted } = { granted: true }] = await db.sql<{ granted: boolean }[]>`
      select exists (
        select 1 from pg_class c, aclexplode(c.relacl) acl
        where c.oid = 'capability_records'::regclass and acl.grantee = 0
      ) as granted
    `;
    expect(granted).toBe(false);
    const [{ policies } = { policies: 0 }] = await db.sql<{ policies: number }[]>`
      select count(*)::int as policies from pg_policies where tablename = 'capability_records'
    `;
    expect(policies).toBe(2);
  });

  it("opens the records with nothing to report for the host's role, and every way out for others", async () => {
    const restricted = await createPostgresCapabilityRecords({
      databaseUrl: hostUrl,
      capability: "outside-forms"
    });
    try {
      expect(restricted.access.problems).toEqual([]);
      const { clientInstanceId } = await platformRecord("opened", "outside-forms", "f-opened");
      await expect(
        restricted.records.get({
          clientInstanceId,
          capability: "outside-forms",
          kind: "form",
          id: "f-opened"
        })
      ).resolves.toMatchObject({ id: "f-opened" });
    } finally {
      await restricted.close();
    }

    const misnamed = await createPostgresCapabilityRecords({
      databaseUrl: misnamedUrl,
      capability: "outside-forms"
    });
    await misnamed.close();
    expect(misnamed.access.problems).toEqual([
      "The role may write records of capabilities other than outside-forms."
    ]);

    // The platform's role in this test is the server's superuser, as on an operated host.
    const platform = await createPostgresCapabilityRecords({
      databaseUrl: db.databaseUrl,
      capability: "outside-forms"
    });
    await platform.close();
    const problems = platform.access.problems.join("\n");
    expect(problems).toMatch(/is a superuser/u);
    expect(problems).toMatch(/owns capability_records/u);
    expect(problems).toMatch(/privileges on other tables or sequences/u);
    expect(problems).toMatch(/may write records of capabilities other than outside-forms/u);
  });

  it("leaves the access of the platform and of other roles as their grants give it", async () => {
    const own = await platformRecord("platform-own", "outside-forms", "f1");
    const other = await platformRecord("platform-other", "document-processing", "f2");

    // A role that neither owns the table nor is a superuser reads and writes every capability's
    // rows, as before row-level security.
    const inspection = connect(urlAs(INSPECTION_ROLE));
    const rows = await inspection<{ capability: string }[]>`
      select capability from capability_records
      where client_instance_id in (${own.clientInstanceId}, ${other.clientInstanceId})
      order by capability
    `;
    expect(rows).toEqual([{ capability: "document-processing" }, { capability: "outside-forms" }]);
    await inspection`
      insert into capability_records
        (client_instance_id, capability, kind, id, status, document, created_at, updated_at)
      values (${other.clientInstanceId}, 'document-processing', 'form', 'f3', 'open', '{}', now(),
        now())
    `;
    await expect(other.records.get({ kind: "form", id: "f3" })).resolves.toBeDefined();

    // The platform's store reads, changes and deletes the rows of every capability.
    await expect(own.records.get({ kind: "form", id: "f1" })).resolves.toBeDefined();
    await expect(
      other.records.update({ kind: "form", id: "f2", status: "done", expiresAt: at, at })
    ).resolves.toMatchObject({ status: "done" });
    await expect(other.records.deleteExpired({ before: "2100-01-01T00:00:00.000Z" })).resolves.toBe(
      1
    );
  });
});
