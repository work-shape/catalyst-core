import type {
  ConnectionDetail,
  ConnectionTestResult,
  ConnectionTools
} from "@vivd-catalyst/api-contract";
import type { AccessResource, OperationResource, PlatformStores } from "@vivd-catalyst/core";

/**
 * How one discovery of a Connection ended. `skipped` is a Connection that has nothing to
 * discover: it is gone, off, or its operations are the release's own. `reason` is the code of
 * a failure, never a text of the outside system.
 */
export interface ConnectionDiscoveryOutcome {
  status: "discovered" | "skipped" | "failed";
  reason?: string;
  /** How many operations the stored catalog lists after a discovery. */
  operationCount?: number;
  /** How many listed operations the catalog did not take. */
  leftOutCount?: number;
  /** How many of those were left out because they held the Connection's credential. */
  rejectedCount?: number;
  /** The discovery was stopped through its signal. Nothing was decided or written. */
  stopped?: boolean;
}

/** What a discovery runs under: the job attempt that asked for it. */
export interface ConnectionDiscoveryAttempt {
  /** Aborted when the attempt is stopped or lost its lease. The discovery then writes nothing. */
  signal: AbortSignal;
  /**
   * What every write of the discovery goes through. It refuses once the attempt no longer
   * holds its lease, so a discovery that was taken over stores nothing.
   */
  transaction<Result>(write: (stores: PlatformStores) => Promise<Result>): Promise<Result>;
}

/**
 * What the server asks of the instance's Connections. The assembly brings it where the module
 * `connections` is on. It answers no secret, no handle and no data of an outside system.
 */
export interface ConnectionManagementPort {
  /** What a right on the Connection is decided on. Nothing where no such Connection exists. */
  resource(name: string): Promise<OperationResource | undefined>;
  /** `agents` are the agents the caller may read: the answer names no other. */
  get(
    name: string,
    agents: readonly { name: string; title: string; toolNames: readonly string[] }[]
  ): Promise<ConnectionDetail>;
  /** The type's bounded test, through the one connector context. Writes the health. */
  test(name: string, signal?: AbortSignal): Promise<ConnectionTestResult>;
  /** The tools an agent can carry, of the Connections `readable` admits. */
  listTools(readable: (resource: AccessResource) => boolean): Promise<ConnectionTools>;
  /**
   * Reads what the outside system offers into the Connection's catalog, bounded in time and
   * size. It makes nothing callable that the accepted list does not name. A failure is an
   * answer and leaves the stored catalog. Missing where the assembly brings no discovery:
   * the job kind `connection.discover` is then not served.
   */
  discover?(name: string, attempt: ConnectionDiscoveryAttempt): Promise<ConnectionDiscoveryOutcome>;
}
