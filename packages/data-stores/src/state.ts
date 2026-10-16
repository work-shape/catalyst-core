import {
  DATA_STORE_ACTIONS,
  DATA_STORE_CONDITIONS,
  DATA_STORE_MIGRATION_OUTCOMES,
  DATA_STORE_OPERATION_PREFIX,
  LISTED_DATA_STORE_STATUSES,
  type DataStoreCondition,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { DATA_STORE_SIZE_WARNING_RATIO } from "./size";
import type { PublishedStore } from "./verbs";

// The state of one store, for the screen that shows it: where its migrations stand, how large
// it is against its limit, what the server leaves open around it and how its last migration
// ended. It is read from the platform's own record of the store and from the published
// definition, so it answers also while the store's database does not.

/** How long the read of a store's state may take, in milliseconds. It reads no database of a store. */
const DATA_STORE_STATE_TIMEOUT_MS = 10_000;

/**
 * What an operator does about each thing the server leaves open, in a sentence. A store works
 * with each of them; the sentence says what stays possible until it is closed.
 */
const CONDITION_ADVICE: Readonly<Record<DataStoreCondition, string>> = {
  server_databases_open:
    "A role of this store can connect to another database of the Postgres server, such as 'postgres' or 'template1', and read its catalog there. On a server that is this instance's alone, run REVOKE CONNECT ON DATABASE <name> FROM PUBLIC as the owner of each such database; the condition goes at the store's next job. On a shared server add the line 'host postgres,template1 /^catalyst_ds_ all reject' to pg_hba.conf above the lines that admit the platform and reload Postgres; the platform cannot see that file, so the condition stays shown.",
  sessions_open:
    "The platform's database role is no superuser, so a query of this store can see the sessions of the Postgres server and end another query of this store. It reaches no other store and nothing of the platform. To close it, let the platform connect as a superuser of a server that is this instance's alone; the condition goes at the store's next job.",
  temp_files_unbounded:
    "The platform's database role is no superuser, so it cannot set temp_file_limit on the roles of this store: a statement of the store that sorts or joins without end fills the disk with temporary files until its timeout. Set temp_file_limit in postgresql.conf for the whole server, or let the platform connect as a superuser of a server that is this instance's alone. With the setting in postgresql.conf the condition stays shown."
};

const migrationSchema = z.object({ number: z.number().int(), name: z.string() });

/** The state of one store as the interface reads it. */
const dataStoreStateSchema = z.object({
  /** The id of the store's asset. */
  id: z.string(),
  /** The id operations and routes name the store by. */
  name: z.string(),
  /** `provisioning` until the database of the store is complete. Its rows are reached while `ready`. */
  status: z.enum(LISTED_DATA_STORE_STATUSES),
  /** The number of the last migration the database has applied. Zero before the first. */
  level: z.number().int(),
  /** The number of the last migration of the published revision. */
  publishedLevel: z.number().int(),
  size: z.object({
    /** What the last measurement found. Missing before the first. */
    bytes: z.number().int().optional(),
    measuredAt: z.string().optional(),
    limitBytes: z.number().int(),
    /** Whether the store is at 80 percent of its limit or above. */
    nearLimit: z.boolean()
  }),
  /** What the last job of the store found open on the server, each with what an operator does. */
  conditions: z.array(z.object({ code: z.enum(DATA_STORE_CONDITIONS), message: z.string() })),
  /**
   * How the last attempt to bring the store to its published revision ended. `applied`: the
   * database is at the published level, and `migration` is the last one applied. `failed`:
   * the attempt ended in `failure`, at `migration` where it was a migration that failed; the
   * store stays at `level`. `pending`: published migrations wait for their job. `none`: the
   * published revision has no migration.
   */
  lastMigration: z.object({
    outcome: z.enum(DATA_STORE_MIGRATION_OUTCOMES),
    migration: migrationSchema.optional(),
    /** A code and a sentence, never a value of a row. */
    failure: z.object({ code: z.string(), message: z.string() }).optional()
  })
});

type DataStoreState = z.infer<typeof dataStoreStateSchema>;

function stateOf({ record, definition }: PublishedStore): DataStoreState {
  const published = definition.migrations;
  const next = published.find((migration) => migration.number > record.level);
  const last = record.migrations.at(-1);
  const named = (migration: { number: number; name: string } | undefined) =>
    migration ? { migration: { number: migration.number, name: migration.name } } : {};
  const lastMigration: DataStoreState["lastMigration"] = record.failure
    ? // A store that never got its database failed before any migration ran.
      {
        outcome: "failed",
        ...(record.status === "ready" ? named(next) : {}),
        failure: record.failure
      }
    : next
      ? { outcome: "pending", ...named(next) }
      : last
        ? { outcome: "applied", ...named(last) }
        : { outcome: "none" };
  return {
    id: record.id,
    name: record.name,
    status: record.status === "ready" ? "ready" : "provisioning",
    level: record.level,
    publishedLevel: published.at(-1)?.number ?? 0,
    size: {
      ...(record.sizeBytes === undefined ? {} : { bytes: record.sizeBytes }),
      ...(record.sizeMeasuredAt === undefined ? {} : { measuredAt: record.sizeMeasuredAt }),
      limitBytes: record.sizeLimitBytes,
      nearLimit:
        record.sizeBytes !== undefined &&
        record.sizeBytes >= record.sizeLimitBytes * DATA_STORE_SIZE_WARNING_RATIO
    },
    conditions: record.conditions.map((code) => ({ code, message: CONDITION_ADVICE[code] })),
    lastMigration
  };
}

/** The last part of the name of the operation that answers a store's state. */
export const DATA_STORE_STATE_VERB = "state";

/** `data_store.<id>.state`: the operation the route `data_stores.get` runs as. */
export function dataStoreStateOperationName(store: string): string {
  return `${DATA_STORE_OPERATION_PREFIX}${store}.${DATA_STORE_STATE_VERB}`;
}

/**
 * The read of one store's state. It needs `data_store.read` on the store and reads no row of
 * it, so a call that completes leaves no run.
 */
export function stateOperation(store: PublishedStore, module: string): OperationDefinition {
  return {
    name: dataStoreStateOperationName(store.record.name),
    effect: "reading",
    action: DATA_STORE_ACTIONS.read,
    // The state is of the store's definition and its database, as `describe` is.
    scope: "config_assets:read",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: dataStoreStateSchema,
    resource: () => store.resource,
    module,
    timeoutMs: DATA_STORE_STATE_TIMEOUT_MS,
    execute: () => Promise.resolve(stateOf(store))
  };
}
