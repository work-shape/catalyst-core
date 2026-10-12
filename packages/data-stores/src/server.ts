import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  POSTGRES_POOL_MAX_CONNECTIONS,
  createPostgresExecutor,
  type PostgresExecutor,
  type PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  type ClientInstanceId,
  type ConnectionsStore,
  type DataStoreLocation,
  type DataStoreRecord
} from "@vivd-catalyst/core";
import type { DataStoreCredentials, DataStoreRole } from "./credentials";

// The Postgres server the stores of an instance live on, and the way to each database on it.
// Every connection to a store database is one of the bounded pools of the executor.

/**
 * The connections the platform holds to one store as one role, at most. It stays below the
 * connection limit of the app role, so a second process has room. A call that finds none free
 * waits and then fails as busy.
 */
const DATA_STORE_POOL_MAX_CONNECTIONS = POSTGRES_POOL_MAX_CONNECTIONS;

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
  /** The database of a store as one of its roles. */
  asRole(
    record: Pick<DataStoreRecord, "id" | "location" | "roles">,
    role: DataStoreRole
  ): PostgresTarget;
}

/** Quotes a name for a statement. Every name this package quotes is one it made or read from a catalog. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function createDataStoreServer(input: {
  clientInstanceId: ClientInstanceId;
  /** The address of the platform database, as the platform itself connects to it. */
  databaseUrl: string;
  credentials: DataStoreCredentials;
  /** The rows of the Secret Store, outside of any transaction. */
  secretRows: ConnectionsStore;
}): DataStoreServer {
  const platform = readDatabaseUrl(input.databaseUrl);
  const base = { host: platform.host, port: platform.port, tls: platform.tls, schemas: [] };
  const executor = createPostgresExecutor({
    secrets: {
      async getSecret(handle) {
        if (handle === PLATFORM_ROLE_HANDLE) return platform.password;
        const [storeId, role] = handle.split(":");
        return storeId !== undefined && (role === "app" || role === "migration")
          ? input.credentials.read(input.secretRows, storeId, role)
          : undefined;
      }
    },
    // The server is the one the platform's own rows are on. Its address is resolved here and
    // checked against no egress list: it is the platform's database, not an outside system.
    pinAddress: async (host) => ({ allowed: true, address: (await lookup(host)).address })
  });
  return {
    executor,
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
      limits: { maxConnections: DATA_STORE_POOL_MAX_CONNECTIONS }
    }),
    asRole: (record, role) => ({
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
      limits: { maxConnections: DATA_STORE_POOL_MAX_CONNECTIONS }
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
