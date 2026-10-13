import { z } from "zod";
import {
  AppError,
  DATA_STORE_ACTIONS,
  type KnowledgeBackend,
  type KnowledgeBaseTarget,
  type KnowledgeCheckResult
} from "@vivd-catalyst/core";
import { catalogTarget, rowsOf } from "../catalog";
import { databaseFailureError } from "../failures";
import { readStores } from "../operations";
import { asStoreRole } from "../roles";
import type { DataStoreRuntime } from "../runtime";
import type { PublishedStore } from "../verbs";

// The Data Store as the backend of a Knowledge Base. A Knowledge Base reads the store's rows
// as the store's app role, in a read-only transaction under the role's statement timeout and
// the executor's row and byte caps: the same way a query of the store itself runs. It creates
// no table and applies no migration there. Spec: Knowledge Base on top; the Knowledge Base
// that describes a Data Store's tables (build plan, readiness review slice 1).

/**
 * Which of the named relations of `public` the session's role may select from. Tables, views
 * and materialized views count: a Knowledge Base may describe a view a migration made.
 */
const READABLE_RELATIONS = `
  select c.relname::pg_catalog.text as name,
    pg_catalog.has_table_privilege(c.oid, 'select') as readable
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and c.relname = any ($1::pg_catalog.text[])
`;

const relationRow = z.object({ name: z.string(), readable: z.boolean() });

/** The published store a Knowledge Base names, or nothing where none has that id. */
async function storeOf(
  runtime: DataStoreRuntime,
  target: KnowledgeBaseTarget
): Promise<PublishedStore | undefined> {
  const { stores } = await readStores(runtime, [target.backend.dataStore]);
  return stores.find((store) => store.record.name === target.backend.dataStore);
}

/**
 * The store whose database a Knowledge Base reads, or why it cannot read one now, as a
 * sentence that names no row value.
 */
async function reachableStore(
  runtime: DataStoreRuntime,
  target: KnowledgeBaseTarget
): Promise<{ store: PublishedStore } | { problem: string }> {
  const name = target.backend.dataStore;
  const store = await storeOf(runtime, target);
  if (!store) {
    return {
      problem: `The Data Store '${name}' is not available: no published Data Store has that id. It may have been deleted.`
    };
  }
  return store.record.status === "ready"
    ? { store }
    : { problem: `The Data Store '${name}' has no database yet: it is being provisioned.` };
}

export function createDataStoreKnowledgeBackend(runtime: DataStoreRuntime): KnowledgeBackend {
  return {
    async requirePublishRight(target, access) {
      const store = await storeOf(runtime, target);
      // A store the caller may not read is not named to it: the check refuses it as missing.
      if (store) access.require(DATA_STORE_ACTIONS.read, store.resource);
    },

    async check(target, signal): Promise<KnowledgeCheckResult> {
      const reached = await reachableStore(runtime, target);
      if ("problem" in reached) {
        return {
          status: "needs_attention",
          tables: target.tables.map(({ name }) => ({ name, readable: false })),
          problem: reached.problem
        };
      }
      const { record } = reached.store;
      const found = await asStoreRole(runtime, record, signal, async () =>
        z.array(relationRow).parse(
          (
            await runtime.server.executor.query({
              ...catalogTarget(runtime.server.asRole(record, "app")),
              ...(signal ? { signal } : {}),
              sql: READABLE_RELATIONS,
              parameters: [{ type: "text[]", value: target.tables.map(({ name }) => name) }]
            })
          ).rows
        )
      );
      const tables = target.tables.map(({ name }) => ({
        name,
        readable: found.some((relation) => relation.name === name && relation.readable)
      }));
      return {
        status: tables.every((table) => table.readable) ? "ok" : "needs_attention",
        tables
      };
    },

    async query(target, statement, signal) {
      const reached = await reachableStore(runtime, target);
      if ("problem" in reached) {
        throw new AppError(
          "CONFLICT",
          reached.problem,
          { reason: "knowledge_backend_unavailable" },
          { exposeMessage: true }
        );
      }
      const { record } = reached.store;
      try {
        return await asStoreRole(runtime, record, signal, async () =>
          rowsOf(
            await runtime.server.executor.query({
              ...runtime.server.asRole(record, "app"),
              ...(signal ? { signal } : {}),
              sql: statement.sql,
              ...(statement.parameters ? { parameters: statement.parameters } : {})
            })
          )
        );
      } catch (error) {
        throw error instanceof AppError ? error : databaseFailureError(error, "The query");
      }
    }
  };
}
