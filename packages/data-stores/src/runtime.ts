import type { AuditRecorder, ClientInstanceId, Logger, PlatformStores } from "@vivd-catalyst/core";
import type { DataStoreCredentials } from "./credentials";
import type { DataStoreServer } from "./server";

/** What an operator sets for the stores of an instance, as release config holds it. */
export interface DataStoreLimits {
  /** The most one store may hold. A store's manifest may name less and never more. */
  sizeLimitBytes: number;
  /** The most connections the platform holds to one store at once. */
  poolMaxConnections: number;
}

/** What everything that serves Data Stores in one process is built on. */
export interface DataStoreRuntime {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  server: DataStoreServer;
  limits: DataStoreLimits;
  credentials: DataStoreCredentials;
  auditRecorder: AuditRecorder;
  logger: Logger;
}
