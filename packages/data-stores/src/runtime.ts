import type { AuditRecorder, ClientInstanceId, Logger, PlatformStores } from "@vivd-catalyst/core";
import type { DataStoreCredentials } from "./credentials";
import type { DataStoreServer } from "./server";

/** What everything that serves Data Stores in one process is built on. */
export interface DataStoreRuntime {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  server: DataStoreServer;
  credentials: DataStoreCredentials;
  auditRecorder: AuditRecorder;
  logger: Logger;
}
