import type { ConnectionsStore, DataStoreRecord, KnowledgeBaseTarget } from "@vivd-catalyst/core";
import { asStoreRole, writeReaderRole } from "../roles";
import type { DataStoreRuntime } from "../runtime";
import { quoteIdentifier } from "../server";

// The role of one Knowledge Base on its store: a login role of its own, which reads exactly the
// tables the published revision describes. A query of the Knowledge Base connects as it, so
// the session itself is this role: `RESET ROLE`, `set_config('role', ...)` and `SET SESSION
// AUTHORIZATION` reach no wider role, because it is a member of none and no superuser.
//
// Who grants what. The platform's role makes the role, owns the store's database and its
// schema `public`, and grants CONNECT and USAGE. The migration role owns the tables, so it
// grants SELECT on them, and it takes EXECUTE on the store's functions from PUBLIC: a function
// a migration made with SECURITY DEFINER would otherwise read for the caller what it may not.
// No default privilege names this role, so a table made later is not readable by it.

/** How long one step of granting or taking away may take before it fails. */
const READER_STEP_TIMEOUT_MS = 120_000;

type Store = Pick<DataStoreRecord, "id" | "location" | "roles">;

/** As the platform's role on the store's database, in one transaction. */
function asPlatformOn(
  runtime: Pick<DataStoreRuntime, "server">,
  store: Store,
  signal: AbortSignal | undefined,
  script: string
): Promise<void> {
  const { server } = runtime;
  return server.executor.change(
    {
      ...server.asPlatform(store.location.database),
      timeoutMs: READER_STEP_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    },
    (sql) => sql.script(script)
  );
}

/** As the store's migration role, which owns its tables, in one transaction. */
function asOwnerOf(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  store: Store,
  signal: AbortSignal | undefined,
  script: string
): Promise<void> {
  const { server } = runtime;
  return asStoreRole(runtime, store, signal, () =>
    server.executor.change(
      {
        ...server.asRole(store, "migration"),
        timeoutMs: READER_STEP_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      },
      (sql) => sql.script(script)
    )
  );
}

/**
 * Lets the role of the Knowledge Base read the tables `target` describes in `store`, and no
 * other table there. The SELECT grants change in one transaction: a step that fails leaves the
 * grants of the revision before or of this one.
 */
export async function grantReader(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  /** Where the role's password is kept: the rows of the caller's transaction, where it has one. */
  secrets: ConnectionsStore,
  store: Store,
  target: KnowledgeBaseTarget,
  signal: AbortSignal | undefined
): Promise<void> {
  const { server, credentials } = runtime;
  const name = server.readerOf(target.assetId);
  const reader = quoteIdentifier(name);
  const password = await credentials.ensure(secrets, target.assetId, "reader");
  await writeReaderRole(server, name, password, signal);
  await asPlatformOn(
    runtime,
    store,
    signal,
    `grant connect on database ${quoteIdentifier(store.location.database)} to ${reader};
     grant usage on schema public to ${reader};`
  );
  const app = quoteIdentifier(store.roles.app);
  const tables = target.tables.map(({ name: table }) => `public.${quoteIdentifier(table)}`);
  await asOwnerOf(
    runtime,
    store,
    signal,
    `revoke all on all tables in schema public from ${reader};
     grant select on table ${tables.join(", ")} to ${reader};
     revoke execute on all routines in schema public from public;
     grant execute on all routines in schema public to ${app};
     alter default privileges in schema public revoke execute on routines from public;
     alter default privileges in schema public grant execute on routines to ${app};`
  );
}

/** Takes from the role of the Knowledge Base everything it was granted in `store`. */
export async function revokeReader(
  runtime: Pick<DataStoreRuntime, "server" | "credentials" | "stores">,
  store: Store,
  knowledgeBaseId: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const reader = quoteIdentifier(runtime.server.readerOf(knowledgeBaseId));
  if (!(await readerExists(runtime, knowledgeBaseId, signal))) return;
  await asOwnerOf(
    runtime,
    store,
    signal,
    `revoke all on all tables in schema public from ${reader};`
  );
  await asPlatformOn(
    runtime,
    store,
    signal,
    `revoke usage on schema public from ${reader};
     revoke connect on database ${quoteIdentifier(store.location.database)} from ${reader};`
  );
}

/** Drops the role of the Knowledge Base and its password. Its grants must be taken first. */
export async function dropReader(
  runtime: Pick<DataStoreRuntime, "server" | "credentials">,
  secrets: ConnectionsStore,
  knowledgeBaseId: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const { server, credentials } = runtime;
  await server.executor.change(
    {
      ...server.asPlatform(server.platformDatabase),
      timeoutMs: READER_STEP_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    },
    (sql) => sql.script(`drop role if exists ${quoteIdentifier(server.readerOf(knowledgeBaseId))}`)
  );
  await credentials.remove(secrets, knowledgeBaseId, "reader");
}

async function readerExists(
  runtime: Pick<DataStoreRuntime, "server">,
  knowledgeBaseId: string,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const { server } = runtime;
  const answer = await server.executor.query({
    ...server.asPlatform(server.platformDatabase),
    ...(signal ? { signal } : {}),
    sql: "select 1 as found from pg_catalog.pg_roles where rolname operator(pg_catalog.=) $1",
    parameters: [server.readerOf(knowledgeBaseId)]
  });
  return answer.rows.length > 0;
}
