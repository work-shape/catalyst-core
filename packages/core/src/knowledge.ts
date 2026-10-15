import type { AgentConfig } from "@work-shape/catalyst-asset-schemas";
import type { AssetKindActions } from "./asset-kinds";
import type { ActorAccess } from "./permissions";
import type { DataStoreRows, DataStoreStatement } from "./data-stores";
import type { ClientInstanceId } from "./ids";
import type { ConnectionsStore } from "./connections";
import type { ISODateString } from "./time";

// The names and shapes of a Knowledge Base that more than one package reads: the asset kind,
// the operations of one Knowledge Base, the one agent tool over all of an agent's, the port a
// backend answers through and what the platform keeps of the last check. The kind itself is
// in `@work-shape/catalyst-data-stores`, beside its only backend so far, the Data Store.
// Spec: data-stores-and-knowledge-bases.md, Knowledge Base on top, Retrieval methods,
// Assigning knowledge bases to an agent.
//
// Sensitive data. A Knowledge Base keeps no row of its own: the rows stay in the database of
// its backend and live as long as that database does. The platform keeps the definition (the
// sentences that describe the tables) and the result of the last check (table names, whether
// each could be read, a sentence, a time). A call of `knowledge.<id>.query` leaves one
// Operation Run with the asker as actor and audit rows that hold neither the SQL, nor a
// parameter, nor a row. An agent's call puts SQL and rows into its conversation, which keeps
// them under the conversation's retention and sends them to the model of the agent's model
// binding, in that binding's region. No embedding is made and no embedding provider is asked.

/**
 * The asset kind of a Knowledge Base. A kind of its own, with rights of its own: a Data Store
 * is one of its backends, not what it is. Spec: build order WD-2.
 */
export const KNOWLEDGE_BASE_ASSET_KIND = "knowledge_base";

/** The rights of the kind. `use` queries the published revision. */
export const KNOWLEDGE_BASE_ACTIONS = {
  read: "knowledge_base.read",
  write: "knowledge_base.write",
  publish: "knowledge_base.publish",
  delete: "knowledge_base.delete",
  use: "knowledge_base.use"
} as const satisfies AssetKindActions;

/**
 * The prefix of every operation of one Knowledge Base: `knowledge.<id>.<part>`. Rights, policy
 * and audit are per Knowledge Base. Spec: P40.
 */
export const KNOWLEDGE_OPERATION_PREFIX = "knowledge.";

/** The operation that answers read-only SQL on one structured Knowledge Base. Spec: P38. */
export function knowledgeQueryOperationName(knowledgeBase: string): string {
  return `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase}.query`;
}

/**
 * The one tool an agent queries its structured Knowledge Bases with, however many it has. It
 * names no Knowledge Base: a call is the call of `knowledge.<id>.query` of the one its input
 * names, made through `runOperation` like every other tool call. Spec: P40, P116.
 */
export const KNOWLEDGE_QUERY_TOOL_NAME = "knowledge.query";

/**
 * The operations an agent reaches through its one knowledge tool: the query of each
 * Knowledge Base its definition lists. An agent calls these and no other Knowledge Base.
 */
export function knowledgeOperationNamesOf(
  agent: Pick<AgentConfig, "knowledgeBases">
): readonly string[] {
  return (agent.knowledgeBases ?? []).map(knowledgeQueryOperationName);
}

/**
 * A call of the knowledge tool as the call of the operation it stands for: the operation of
 * the Knowledge Base the input names, with the rest of the input. Nothing where the input
 * names none, which the caller refuses as an input that does not hold.
 */
export function knowledgeToolCall(
  input: unknown
): { operation: string; knowledgeBase: string; input: Record<string, unknown> } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const { knowledgeBase, ...rest } = Object.fromEntries(Object.entries(input));
  if (typeof knowledgeBase !== "string" || knowledgeBase.length === 0) return undefined;
  return { operation: knowledgeQueryOperationName(knowledgeBase), knowledgeBase, input: rest };
}

/** One described table as the last check found it. */
export interface KnowledgeTableCheck {
  name: string;
  /** The Knowledge Base can read it: it exists and the role that answers may select from it. */
  readable: boolean;
}

/**
 * What a check of a Knowledge Base found. `needs_attention` where a described table cannot be
 * read or the backend cannot be reached: a query then fails, and a publish is refused.
 */
export interface KnowledgeCheckResult {
  status: "ok" | "needs_attention";
  /** Every described table, in the order of the definition. */
  tables: KnowledgeTableCheck[];
  /** Why the backend could not be asked at all, as a sentence. It names no row value. */
  problem?: string;
}

/** Where a Knowledge Base's tables are, as its definition names it under `backend`. */
export interface KnowledgeBackendReference {
  /** The id of the Data Store whose tables it describes. */
  dataStore: string;
}

/** The described tables of a Knowledge Base and where a backend finds them. */
export interface KnowledgeBaseTarget {
  /** The id of the Knowledge Base's asset, which its access on the backend is bound to. */
  assetId: string;
  /** The id of the Knowledge Base. */
  name: string;
  backend: KnowledgeBackendReference;
  tables: readonly { name: string }[];
}

/**
 * What a backend of a Knowledge Base answers. The kind asks it and never which backend it is.
 * Spec: build order WD-2, a backend port.
 */
export interface KnowledgeBackend {
  /**
   * Throws `FORBIDDEN` where the person who publishes may not hand the backend's rows to the
   * Knowledge Base's users: a published Knowledge Base answers whoever holds its `use` right.
   */
  requirePublishRight(target: KnowledgeBaseTarget, access: ActorAccess): Promise<void>;
  /** Whether every described table can be read. It reads the catalog and no row. */
  check(target: KnowledgeBaseTarget, signal?: AbortSignal): Promise<KnowledgeCheckResult>;
  /**
   * Lets the Knowledge Base read exactly the tables `target` describes, and nothing it read
   * for `replaced`, the revision that was published before. At no step can it read more than
   * one of the two revisions describes. Repeating it changes nothing. What it keeps of the
   * access, such as a password, it writes to `stores`, which a publish binds to its own
   * transaction: a write beside it would wait for that transaction to end.
   */
  grant(
    stores: { connections: ConnectionsStore },
    target: KnowledgeBaseTarget,
    replaced: KnowledgeBaseTarget | undefined,
    signal?: AbortSignal
  ): Promise<void>;
  /** Takes every access of a deleted Knowledge Base away. Repeating it changes nothing. */
  retire(
    stores: { connections: ConnectionsStore },
    target: KnowledgeBaseTarget,
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Runs one read-only statement with bound parameters, under the backend's row and byte caps,
   * with the access `grant` gave the Knowledge Base and no other.
   */
  query(
    target: KnowledgeBaseTarget,
    statement: DataStoreStatement,
    signal?: AbortSignal
  ): Promise<DataStoreRows>;
}

/** The last check of a Knowledge Base, as the platform keeps it. */
export interface KnowledgeBaseState extends KnowledgeCheckResult {
  /** The id of the Knowledge Base's asset. */
  assetId: string;
  clientInstanceId: ClientInstanceId;
  /** The revision that was checked: the one being published, or the published one. */
  revision: number;
  checkedAt: ISODateString;
}

/** What the platform keeps of each Knowledge Base, as `PlatformStores.knowledgeBases`. */
export interface KnowledgeBaseStateStore {
  getKnowledgeBaseState(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<KnowledgeBaseState | undefined>;
  /** Inserts the state, or replaces the one of the same asset. */
  putKnowledgeBaseState(state: KnowledgeBaseState): Promise<void>;
  deleteKnowledgeBaseState(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<void>;
}
