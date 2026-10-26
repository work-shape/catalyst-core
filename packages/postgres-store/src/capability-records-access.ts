import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { assertDatabaseMigrated } from "./migrations";

/**
 * What the database role of a capability's own process may reach besides the capability's
 * records (ADR-0033, EW-9). Empty when Postgres holds the role to them: it is no superuser,
 * does not bypass row-level security, does not own `capability_records`, writes no record of
 * another capability, and reaches no other table, sequence, schema or definer function.
 */
export interface CapabilityRecordsAccess {
  /** One sentence per way out, for the log of a process that refuses to start with them. */
  problems: string[];
}

/** How many names of other relations a problem lists before it counts the rest. */
const NAMED_RELATIONS = 5;

const ROLE = `
  select r.rolname as role, r.rolsuper as superuser, r.rolbypassrls as bypass,
    pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') as creates_schemas
  from pg_catalog.pg_roles r
  where r.rolname = current_user
`;

const TABLE = `
  select c.relrowsecurity as row_security,
    pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER') as owner,
    pg_catalog.has_table_privilege(c.oid, 'SELECT')
      and pg_catalog.has_table_privilege(c.oid, 'INSERT')
      and pg_catalog.has_table_privilege(c.oid, 'UPDATE') as reads_and_writes
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'capability_records' and c.relkind in ('r', 'p')
`;

/** Every relation but the records that the role holds any privilege on. */
const OTHER_RELATIONS = `
  select n.nspname || '.' || c.relname as name
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'
    and not (n.nspname = 'public' and c.relname = 'capability_records')
    and (
      (c.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_catalog.has_table_privilege(c.oid,
          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
      or (c.relkind = 'S'
        and pg_catalog.has_sequence_privilege(c.oid, 'USAGE, SELECT, UPDATE'))
    )
  order by 1
`;

/** Schemas the role may create objects in. */
const CREATE_SCHEMAS = `
  select n.nspname as name
  from pg_catalog.pg_namespace n
  where n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'
    and pg_catalog.has_schema_privilege(n.oid, 'CREATE')
  order by 1
`;

/** Functions that run with their owner's rights and that the role may call. */
const DEFINER_FUNCTIONS = `
  select p.oid::pg_catalog.regprocedure::text as name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef
    and n.nspname not in ('pg_catalog', 'information_schema')
    and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
  order by 1
`;

const MIGRATIONS_READABLE = `
  select pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    and pg_catalog.has_table_privilege(c.oid, 'SELECT') as readable
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations'
`;

function listed(names: string[]): string {
  const shown = names.slice(0, NAMED_RELATIONS).join(", ");
  return names.length > NAMED_RELATIONS
    ? `${shown} and ${names.length - NAMED_RELATIONS} more`
    : shown;
}

/**
 * Asks Postgres what the connected role may reach besides the records of `capability`. It
 * writes nothing: the one probe, a record of another capability, is rolled back. Throws when
 * `capability_records` is missing or the role may not read and write it, since a process of
 * the capability cannot work then.
 */
export async function inspectCapabilityRecordsAccess(
  sql: postgres.Sql,
  capability: string
): Promise<CapabilityRecordsAccess> {
  const [table] = await sql.unsafe<
    { row_security: boolean; owner: boolean; reads_and_writes: boolean }[]
  >(TABLE);
  if (!table) {
    throw new Error(
      "The database has no table capability_records. Run the migration step of this release before starting."
    );
  }
  // A role that may read the migration ledger is checked against it, as every platform
  // process is. A role held to the records cannot; its row-level security below then shows
  // that the database is at least at the migration that brought it.
  const [ledger] = await sql.unsafe<{ readable: boolean }[]>(MIGRATIONS_READABLE);
  if (ledger?.readable) await assertDatabaseMigrated(sql);
  if (!table.reads_and_writes) {
    throw new Error(
      "The database role may not read and write capability_records. Grant it SELECT, INSERT and UPDATE on that table."
    );
  }

  const problems: string[] = [];
  const [role] = await sql.unsafe<
    { role: string; superuser: boolean; bypass: boolean; creates_schemas: boolean }[]
  >(ROLE);
  if (role?.superuser) problems.push(`The role ${role.role} is a superuser.`);
  if (role?.bypass) problems.push(`The role ${role.role} bypasses row-level security.`);
  if (table.owner) {
    problems.push(
      "The role owns capability_records, or is a member of its owner, so row-level security does not apply to it."
    );
  }
  if (!table.row_security) problems.push("Row-level security is off on capability_records.");
  if (role?.creates_schemas) problems.push("The role may create schemas in the database.");

  const others = await sql.unsafe<{ name: string }[]>(OTHER_RELATIONS);
  if (others.length > 0) {
    problems.push(
      `The role holds privileges on other tables or sequences: ${listed(others.map((row) => row.name))}.`
    );
  }
  const schemas = await sql.unsafe<{ name: string }[]>(CREATE_SCHEMAS);
  if (schemas.length > 0) {
    problems.push(
      `The role may create objects in the schemas ${listed(schemas.map((row) => row.name))}.`
    );
  }
  const definers = await sql.unsafe<{ name: string }[]>(DEFINER_FUNCTIONS);
  if (definers.length > 0) {
    problems.push(
      `The role may call functions that run with their owner's rights: ${listed(definers.map((row) => row.name))}.`
    );
  }
  if (await writesOtherCapability(sql, capability)) {
    problems.push(`The role may write records of capabilities other than ${capability}.`);
  }
  return { problems };
}

/** Thrown inside the probe's transaction so that it rolls back what it wrote. */
class ProbeWritten extends Error {}

/**
 * Whether Postgres takes a record of another capability from this role. The probe's
 * transaction is always rolled back. A refusal by privilege or by row-level security is the
 * answer no; any other failure is not an answer and is thrown.
 */
async function writesOtherCapability(sql: postgres.Sql, capability: string): Promise<boolean> {
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into capability_records
          (client_instance_id, capability, kind, id, status, document, created_at, updated_at)
        values (
          ${"access-probe"}, ${`${capability}.access-probe`}, ${"access-probe"}, ${randomUUID()},
          ${"probe"}, '{}'::jsonb, now(), now()
        )
      `;
      throw new ProbeWritten();
    });
  } catch (error) {
    if (error instanceof ProbeWritten) return true;
    if (error instanceof postgres.PostgresError && error.code === "42501") return false;
    throw error;
  }
  return true;
}
