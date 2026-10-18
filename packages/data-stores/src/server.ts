import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createPostgresExecutor,
  type PostgresExecutor,
  type PostgresLimits,
  type PostgresTarget
} from "@work-shape/catalyst-postgres-connector";
import {
  AppError,
  type ClientInstanceId,
  type ConnectionsStore,
  type DataStoreLocation,
  type DataStoreRecord
} from "@work-shape/catalyst-core";
import type { DataStoreCredentials, DataStoreRole } from "./credentials";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";

// The Postgres server the stores of an instance live on, and the way to each database on it.
// Every connection to a store database is one of the bounded pools of the executor.

/**
 * Lower ceilings for one statement as a store's app role than the connector's own: how long
 * it runs, and how many rows and bytes it answers. Past the first the statement is cancelled
 * and its caller reads a timeout; past the others the result ends there and says `truncated`.
 */
export type DataStoreStatementLimits = Pick<
  PostgresLimits,
  "statementTimeoutMs" | "maxRows" | "maxBytes"
>;

/** The credential handle of the platform's own role. Every other handle names a store role. */
const PLATFORM_ROLE_HANDLE = "platform";

export interface DataStoreServer {
  readonly executor: PostgresExecutor;
  /** Where a store that is provisioned now is placed: the server of the platform database. */
  readonly location: Omit<DataStoreLocation, "database">;
  /** The database of the platform itself, which no store role may reach. */
  readonly platformDatabase: string;
  /** The names of a store's database and roles. They follow from the instance and the asset. */
  namesOf(storeId: string): { database: string; app: string; migration: string };
  /** A database of the server as the platform's own role, which owns the store databases. */
  asPlatform(database: string): PostgresTarget;
  /**
   * The database of a store as one of its roles. `secretRows` are where its password is read
   * should the call open a connection: the rows of a transaction the caller holds, so that the
   * call takes no second connection of the platform's pool. Every caller must supply them.
   */
  asRole(
    record: Pick<DataStoreRecord, "id" | "location" | "roles">,
    role: DataStoreRole,
    secretRows: ConnectionsStore
  ): PostgresTarget;
  /**
   * The name of the role of one Knowledge Base, which reads the tables it describes. It follows
   * from the instance and the Knowledge Base, not from the store, so it outlives a move.
   */
  readerOf(knowledgeBaseId: string): string;
  /** The database of a store as the role of a Knowledge Base on it, under the app role's limits. */
  asReader(
    record: Pick<DataStoreRecord, "location">,
    knowledgeBaseId: string,
    secretRows: ConnectionsStore
  ): PostgresTarget;
}

/** How many connections the role of one Knowledge Base may hold to its store at once. */
export const DATA_STORE_READER_CONNECTION_LIMIT = 5;

/** Quotes a name for a statement. Every name this package quotes is one it made or read from a catalog. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function createDataStoreServer(input: {
  clientInstanceId: ClientInstanceId;
  /** The address of the platform database, as the platform itself connects to it. */
  databaseUrl: string;
  credentials: DataStoreCredentials;
  /**
   * The connections this process holds to one store as one role, at most: the pool cap of
   * release config. A call that finds none free waits and then fails as busy.
   */
  poolMaxConnections: number;
  /** Read at every statement. Without it the ceilings are the connector's own. */
  statementLimits?: DataStoreStatementLimits;
}): DataStoreServer {
  const platform = readDatabaseUrl(input.databaseUrl);
  const base = { host: platform.host, port: platform.port, tls: platform.tls, schemas: [] };
  const { poolMaxConnections } = input;
  const executor = createPostgresExecutor({
    poolMaxConnections,
    secrets: {
      getSecret: (handle) =>
        Promise.resolve(handle === PLATFORM_ROLE_HANDLE ? platform.password : undefined)
    },
    // The server is the one the platform's own rows are on. Its address is resolved here and
    // checked against no egress list: it is the platform's database, not an outside system.
    pinAddress: async (host) => ({ allowed: true, address: (await lookup(host)).address })
  });
  const readerOf = (knowledgeBaseId: string) =>
    `catalyst_kb_${createHash("sha256")
      .update(`${input.clientInstanceId}|${knowledgeBaseId}`)
      .digest("hex")
      .slice(0, 24)}`;
  return {
    executor,
    readerOf,
    location: { host: platform.host, port: platform.port },
    platformDatabase: platform.database,
    namesOf(storeId) {
      const key = createHash("sha256")
        .update(`${input.clientInstanceId}|${storeId}`)
        .digest("hex")
        .slice(0, 24);
      const database = `catalyst_ds_${key}`;
      return { database, app: `${database}_app`, migration: `${database}_migration` };
    },
    asPlatform: (database) => ({
      location: { ...base, database, user: platform.user },
      credentialHandle: PLATFORM_ROLE_HANDLE,
      limits: { maxConnections: poolMaxConnections }
    }),
    asRole: (record, role, secretRows) => ({
      location: {
        host: record.location.host,
        port: record.location.port,
        database: record.location.database,
        user: record.roles[role],
        tls: platform.tls,
        // Unqualified names are the tables of the store, which its migrations make in `public`.
        schemas: ["public"]
      },
      credentialHandle: `${record.id}:${role}`,
      secrets: {
        getSecret: () => input.credentials.read(secretRows, record.id, role)
      },
      // Never more than Postgres lets the role open.
      limits: {
        ...(role === "app" ? input.statementLimits : {}),
        maxConnections: Math.min(poolMaxConnections, DATA_STORE_ROLE_LIMITS[role].connectionLimit)
      }
    }),
    asReader: (record, knowledgeBaseId, secretRows) => ({
      location: {
        host: record.location.host,
        port: record.location.port,
        database: record.location.database,
        user: readerOf(knowledgeBaseId),
        tls: platform.tls,
        schemas: ["public"]
      },
      credentialHandle: `${knowledgeBaseId}:reader`,
      secrets: {
        getSecret: () => input.credentials.read(secretRows, knowledgeBaseId, "reader")
      },
      limits: {
        ...input.statementLimits,
        maxConnections: Math.min(poolMaxConnections, DATA_STORE_READER_CONNECTION_LIMIT)
      }
    })
  };
}

function readDatabaseUrl(databaseUrl: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: "verify-full" | "off";
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // The address holds the password, so nothing of it is repeated.
    throw new AppError(
      "VALIDATION_FAILED",
      "Data Stores cannot read the platform database address"
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!/^postgres(?:ql)?:$/u.test(url.protocol) || url.hostname === "" || database === "") {
    throw new AppError(
      "VALIDATION_FAILED",
      "Data Stores cannot read the platform database address"
    );
  }
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    tls: url.searchParams.get("sslmode") === "verify-full" ? "verify-full" : "off"
  };
}
