import { z } from "zod";
import { POSTGRES_PRIVILEGE_OBJECTS_MAX_LISTED } from "./limits";
import { textParameter } from "./parameters";
import type { PostgresSession } from "./pool";

export type PostgresWritePrivilege = "insert" | "update" | "delete" | "truncate" | "create";

/** Something the account can change: rows of a relation, or what a schema or the database holds. */
export interface PostgresWritableObject {
  kind: "relation" | "schema" | "database";
  /** The schema of a relation. */
  schema?: string;
  name: string;
  privileges: PostgresWritePrivilege[];
}

/**
 * What the account of a connection really may do, read from the database's catalog. The role
 * is the only boundary of a connection, so this is what a person is shown before they rely on
 * it. It holds names of objects and no row.
 */
export interface PostgresPrivileges {
  checkedAt: string;
  account: {
    user: string;
    superuser: boolean;
    /** The role's own connection limit, when it has one. */
    connectionLimit?: number;
    /** The statement timeout the role's sessions start with, when one is set. */
    statementTimeoutMs?: number;
  };
  canChangeData: boolean;
  writableObjects: PostgresWritableObject[];
  readableRelations: { schema: string; name: string }[];
  /** A list was cut at the listing cap. */
  listTruncated: boolean;
}

const accountRow = z.object({
  user: z.string(),
  superuser: z.boolean(),
  connection_limit: z.number(),
  // `reset_val` is the value a session starts with, untouched by the timeout of this transaction.
  statement_timeout_ms: z.coerce.number(),
  database: z.string(),
  can_create_in_database: z.boolean()
});

const ACCOUNT = `
  select
    role.rolname::text as "user",
    role.rolsuper as superuser,
    role.rolconnlimit as connection_limit,
    (select reset_val from pg_catalog.pg_settings where name = 'statement_timeout') as statement_timeout_ms,
    current_database()::text as database,
    pg_catalog.has_database_privilege(current_database(), 'create') as can_create_in_database
  from pg_catalog.pg_roles role
  where role.rolname = current_user
`;

const USER_SCHEMA = `
  namespace.nspname not in ('pg_catalog', 'information_schema')
  and namespace.nspname not like 'pg\\_toast%'
  and namespace.nspname not like 'pg\\_temp%'
`;

const schemaRow = z.object({ name: z.string() });

const CREATABLE_SCHEMAS = `
  select namespace.nspname::text as name
  from pg_catalog.pg_namespace namespace
  where ${USER_SCHEMA}
    and pg_catalog.has_schema_privilege(namespace.oid, 'create')
  order by namespace.nspname
  limit $1::int
`;

const relationRow = z.object({
  schema: z.string(),
  name: z.string(),
  can_insert: z.boolean(),
  can_update: z.boolean(),
  can_delete: z.boolean(),
  can_truncate: z.boolean()
});

/** `$1` chooses the relations the account can change (true) or read (false). */
const RELATIONS = `
  select * from (
    select
      namespace.nspname::text as schema,
      relation.relname::text as name,
      pg_catalog.has_table_privilege(relation.oid, 'select') as can_select,
      pg_catalog.has_any_column_privilege(relation.oid, 'insert') as can_insert,
      pg_catalog.has_any_column_privilege(relation.oid, 'update') as can_update,
      pg_catalog.has_table_privilege(relation.oid, 'delete') as can_delete,
      pg_catalog.has_table_privilege(relation.oid, 'truncate') as can_truncate
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and ${USER_SCHEMA}
      and pg_catalog.has_schema_privilege(namespace.oid, 'usage')
  ) relation
  where case when $1::boolean
    then can_insert or can_update or can_delete or can_truncate
    else can_select
  end
  order by schema, name
  limit $2::int
`;

export async function readPostgresPrivileges(
  session: PostgresSession
): Promise<PostgresPrivileges> {
  const cap = POSTGRES_PRIVILEGE_OBJECTS_MAX_LISTED;
  const limit = textParameter(String(cap + 1));
  const [account] = z.array(accountRow).parse(await session.run(ACCOUNT));
  if (account === undefined) throw new Error("The current role is not in the role catalog");
  const schemas = z.array(schemaRow).parse(await session.run(CREATABLE_SCHEMAS, [limit]));
  const writable = await relations(session, true, limit);
  const readable = await relations(session, false, limit);

  const writableObjects: PostgresWritableObject[] = [
    ...(account.can_create_in_database
      ? [{ kind: "database" as const, name: account.database, privileges: ["create" as const] }]
      : []),
    ...schemas.map(({ name }) => ({
      kind: "schema" as const,
      name,
      privileges: ["create" as const]
    })),
    ...writable.map((relation) => ({
      kind: "relation" as const,
      schema: relation.schema,
      name: relation.name,
      privileges: WRITE_PRIVILEGES.filter((privilege) => relation[`can_${privilege}`])
    }))
  ];
  return {
    checkedAt: new Date().toISOString(),
    account: {
      user: account.user,
      superuser: account.superuser,
      ...(account.connection_limit >= 0 ? { connectionLimit: account.connection_limit } : {}),
      ...(account.statement_timeout_ms > 0
        ? { statementTimeoutMs: account.statement_timeout_ms }
        : {})
    },
    canChangeData: account.superuser || writableObjects.length > 0,
    writableObjects: writableObjects.slice(0, cap),
    readableRelations: readable.slice(0, cap).map(({ schema, name }) => ({ schema, name })),
    listTruncated: writableObjects.length > cap || readable.length > cap
  };
}

const WRITE_PRIVILEGES = ["insert", "update", "delete", "truncate"] as const;

async function relations(
  session: PostgresSession,
  changeable: boolean,
  limit: ReturnType<typeof textParameter>
) {
  const rows = await session.run(RELATIONS, [textParameter(changeable ? "t" : "f"), limit]);
  return z.array(relationRow).parse(rows);
}
