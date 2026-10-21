import type {
  ConnectionDetail,
  ConnectionPersonContext,
  ConnectionOAuthStart,
  ConnectionSecretState,
  ConnectionTestResult,
  ConnectionTools,
  ConnectorTypeOffers
} from "@work-shape/catalyst-api-contract";
import type {
  AccessResource,
  AuthenticatedIdentity,
  ConnectionPersonContextSubject,
  AuditActor,
  AuditRecorder,
  ConnectionProviderRevocation,
  OperationResource,
  PlatformStores
} from "@work-shape/catalyst-core";

/** What a step of a sign-in records its audit events with. */
interface ConnectionSignInAudit {
  auditRecorder: AuditRecorder;
  actor: AuditActor;
  correlationId: string;
}

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
  /** How many of those were left out because a schema of theirs was refused. */
  schemaRefusedCount?: number;
  /** The code of why the first of those was refused, such as `schema_too_large`. */
  schemaRefusal?: string;
  /**
   * The Connection changed while it was discovered. Nothing was written, and a discovery of
   * the revision it has now is owed.
   */
  superseded?: boolean;
  /** The discovery was stopped through its signal. Nothing was decided or written. */
  stopped?: boolean;
}

/** What a discovery runs under: the job attempt that asked for it. */
interface ConnectionDiscoveryAttempt {
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
  getPersonContext(
    name: string,
    subject: ConnectionPersonContextSubject
  ): Promise<ConnectionPersonContext>;
  setPersonContext(
    name: string,
    input: ConnectionPersonContextSubject & {
      value: string | null;
      expectedRowVersion: number | null;
    },
    audit: { actor: AuditActor; correlationId: string }
  ): Promise<ConnectionPersonContext>;
  /** What a right on the Connection is decided on. Nothing where no such Connection exists. */
  resource(name: string): Promise<OperationResource | undefined>;
  /** `agents` are the agents the caller may read: the answer names no other. */
  get(
    name: string,
    agents: readonly { name: string; title: string; toolNames: readonly string[] }[],
    readable?: (resource: AccessResource) => boolean
  ): Promise<ConnectionDetail>;
  /** The type's bounded test, through the one connector context. Writes the health. */
  test(
    name: string,
    signal?: AbortSignal,
    actor?: AuthenticatedIdentity
  ): Promise<ConnectionTestResult>;
  /** The tools an agent can carry, of the Connections `readable` admits. */
  listTools(readable: (resource: AccessResource) => boolean): Promise<ConnectionTools>;
  /** The Connector types of the build that the New connection dialog offers with a form. */
  connectorTypes(): ConnectorTypeOffers;
  /**
   * Stores the shared secret of a Connection made on the instance as its next version, after
   * the version the writer saw. The value is never answered, logged or read back.
   */
  setSecret(
    name: string,
    input: { value: string; expectedVersion: number | null }
  ): Promise<ConnectionSecretState>;
  /**
   * Reads what the outside system offers into the Connection's catalog, bounded in time and
   * size. It makes nothing callable that the accepted list does not name. A failure is an
   * answer and leaves the stored catalog. Missing where the assembly brings no discovery:
   * the job kind `connection.discover` is then not served.
   */
  discover?(name: string, attempt: ConnectionDiscoveryAttempt): Promise<ConnectionDiscoveryOutcome>;
  /**
   * Starts the shared OAuth sign-in of a Connection: answers the provider's authorization
   * address, which holds the state, and keeps the session that waits for the callback.
   * `authSessionId` is the first-party session's id, or `key:<id>` for a personal key.
   */
  oauthStart(
    name: string,
    input: {
      starter: { userId: string; authSessionId: string };
      audit: ConnectionSignInAudit;
      signal?: AbortSignal;
    }
  ): Promise<ConnectionOAuthStart>;
  /**
   * Completes a sign-in from the provider's callback and answers the in-app address to send
   * the browser to. A refusal throws with its reason and, where known, the Connection's name
   * in `details.connection`. Only a person in a first-party session completes one.
   */
  oauthComplete(input: {
    /** The Connection whose callback path the provider sent the browser to. */
    connectionName: string;
    query: { state?: string; code?: string; error?: string; iss?: string };
    completer: { userId: string; firstPartySessionId: string | undefined } | undefined;
    mayWrite(resource: OperationResource): boolean;
    audit: ConnectionSignInAudit;
    signal?: AbortSignal;
  }): Promise<{ location: string; connectionName: string }>;
  /** The in-app address of an outcome, or nothing where `instance.publicUrl` is not set. */
  oauthLandingUrl(outcome: string, connectionName?: string): string | undefined;
  /**
   * Refreshes the shared OAuth sign-ins no call used for 7 days, never a personal one, and
   * answers how many were refreshed and failed. Missing where the assembly brings no refresh:
   * the job kind `connection_bindings.keep_alive` is then not served.
   */
  keepAlive?(input: { signal: AbortSignal }): Promise<{ refreshed: number; failed: number }>;
  /**
   * Disconnect: ends the shared sign-in of a Connection. Its token set is deleted before the
   * provider is asked to revoke the grant, and the answer says what the provider said.
   */
  disconnect(
    name: string,
    audit: { actor: AuditActor; correlationId: string }
  ): Promise<{ state: "revoked"; providerRevocation: ConnectionProviderRevocation }>;
}
