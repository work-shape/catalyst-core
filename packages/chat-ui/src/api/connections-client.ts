// What the interface reads of a Connection beyond its revision, and the one thing it does to
// it. The shapes are written from the contract of `connections.get`, `connections.test` and
// `connections.list_tools`. When the contract's own schemas exist in `@vivd-catalyst/api-client`,
// these types are replaced by theirs and `ConnectionsClient` is bound to `client.connections`.
// No shape here holds a secret, a handle of one or a way to either.

/** The health the instance recorded for a Connection. */
type ConnectionHealth = "unknown" | "ok" | "failed" | "needs_configuration" | "secret_unreadable";

/** Whether the Connection's credential is there. Never the credential or its handle. */
interface ConnectionSecretState {
  state: "set" | "not_set" | "unreadable";
  version?: number;
}

type ConnectionOperationEffect = "reading" | "changing";
export type ConnectionOperationExposure = "agent" | "bridge" | "workflow";
export type ConnectionOperationStatus =
  "ready" | "awaiting_discovery" | "needs_review" | "unknown" | "disabled";

export interface ConnectionOperationDetail {
  name: string;
  /** `connection.<name>.<operation>`. */
  toolName: string;
  effect: ConnectionOperationEffect;
  exposure: ConnectionOperationExposure[];
  enabled: boolean;
  status: ConnectionOperationStatus;
  /** From the catalog. It is shown as text. */
  description?: string;
  /** Only with the status `needs_review`. */
  discoveredFingerprint?: string;
}

/** An agent that carries tools of the Connection. */
interface ConnectionUsage {
  agentName: string;
  title: string;
  toolNames: string[];
}

/** The answer of `connections.get`. */
export interface ConnectionDetail {
  name: string;
  health: ConnectionHealth;
  lastTestedAt?: string;
  lastErrorCode?: string;
  secret: ConnectionSecretState;
  /** One account for everyone who may use the Connection. */
  sharedCredential: boolean;
  operations: ConnectionOperationDetail[];
  usedBy: ConnectionUsage[];
  discoveredAt?: string;
}

export type ConnectionTestStatus = "ready" | "unauthorized" | "network_denied" | "unavailable";

/** The answer of `connections.test`. It holds nothing of the outside system. */
export interface ConnectionTestResult {
  status: ConnectionTestStatus;
  testedAt: string;
}

/** The answer of `connections.list_tools`: what an agent can carry, per Connection. */
interface ConnectionTools {
  connections: {
    name: string;
    title: string;
    tools: {
      toolName: string;
      operation: string;
      description?: string;
      effect: ConnectionOperationEffect;
    }[];
  }[];
}

/** The three calls. A refusal and a failure reject with the instance's error, as every call. */
export interface ConnectionsClient {
  get(input: { params: { name: string }; signal?: AbortSignal }): Promise<ConnectionDetail>;
  test(input: { params: { name: string } }): Promise<ConnectionTestResult>;
  list_tools(input?: { signal?: AbortSignal }): Promise<ConnectionTools>;
}
