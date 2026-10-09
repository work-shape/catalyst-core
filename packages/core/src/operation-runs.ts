import type { DelegatedActor } from "./identity";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { OperationDenial } from "./operation-denial";
import type { OperationEffect, OperationOrigin } from "./operations";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

export const OPERATION_RUN_STATUSES = [
  "running",
  "pending_confirmation",
  "pending_approval",
  "done",
  "failed",
  "denied",
  "expired"
] as const;

export type OperationRunStatus = (typeof OPERATION_RUN_STATUSES)[number];

/** Who called, as far as the run keeps it: never scopes, rights or an address. */
export interface OperationRunActor {
  kind: "user" | "service_principal";
  id: string;
  label: string;
  delegatedActor?: DelegatedActor;
}

export interface OperationRunDecision {
  /** `direct`: the caller's own call was the confirmation. */
  mode: "direct" | "confirmed" | "approved" | "declined";
  by: string;
  at: ISODateString;
  comment?: string;
  edited?: boolean;
  inputHashes?: string[];
}

/** Why a run failed or was refused: a code and a message that is safe to show. */
export interface OperationRunError {
  code: string;
  message: string;
}

/**
 * The durable record of one call of an operation. It holds a hash of the input and never the
 * input, and the output only of a completed changing call, up to a bound, so that the same
 * call sent again is answered from the record.
 */
export interface OperationRun {
  id: OperationRunId;
  clientInstanceId: ClientInstanceId;
  operation: string;
  effect: OperationEffect;
  actor: OperationRunActor;
  /** Whose private content the run holds, where it holds any. */
  ownerUserId?: string;
  workspaceId?: CollaborationWorkspaceId;
  origin: OperationOrigin;
  /** Set from agent and app origins. */
  conversationId?: ConversationId;
  idempotencyKey?: string;
  inputHash: string;
  /** Where the frozen input of a waiting call is kept, such as `approval_request:<id>`. */
  inputRef?: string;
  status: OperationRunStatus;
  attempt: number;
  decision?: OperationRunDecision;
  approvalRequestId?: string;
  /** Present while the run retains what the call answered. */
  output?: { value: JsonValue };
  resultRef?: string;
  error?: OperationRunError;
  /** Why a `denied` run was refused. */
  denial?: OperationDenial;
  usage?: JsonObject;
  correlationId: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
  expiresAt?: ISODateString;
  updatedAt: ISODateString;
}

export type NewOperationRun = Pick<
  OperationRun,
  | "id"
  | "clientInstanceId"
  | "operation"
  | "effect"
  | "actor"
  | "ownerUserId"
  | "workspaceId"
  | "origin"
  | "conversationId"
  | "idempotencyKey"
  | "inputHash"
  | "correlationId"
> & { startedAt: ISODateString };

/** How a running call ends for its caller: with an outcome, or waiting for an approval. */
export type OperationRunEnd = { finishedAt: ISODateString } & (
  | {
      status: "done";
      output?: { value: JsonValue };
      resultRef?: string;
      decision?: OperationRunDecision;
    }
  | { status: "failed"; error: OperationRunError }
  | { status: "denied"; error: OperationRunError; denial: OperationDenial }
  | {
      status: "pending_approval";
      approvalRequestId: string;
      inputRef: string;
      expiresAt: ISODateString;
    }
);

export interface OperationRunFilters {
  operation?: string;
  status?: OperationRunStatus;
  actorId?: string;
  originKind?: OperationOrigin["kind"];
  workspaceId?: CollaborationWorkspaceId;
  /** Runs created at or after this moment. */
  since?: ISODateString;
}

export interface OperationRunStore {
  /**
   * Starts a run. Where the actor already used the run's idempotency key, nothing is inserted:
   * a failed run of the same operation and input is taken for its next attempt and returned,
   * and any other run that holds the key leaves the answer `undefined`. An interrupted run of
   * a changing operation is never taken again: nobody knows how far its call got.
   */
  create(run: NewOperationRun): Promise<OperationRun | undefined>;
  /** Ends a run that is still `running`. `undefined` when it is not running any more. */
  finish(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    end: OperationRunEnd;
  }): Promise<OperationRun | undefined>;
  findByIdempotencyKey(input: {
    clientInstanceId: ClientInstanceId;
    actor: Pick<OperationRunActor, "kind" | "id">;
    idempotencyKey: string;
  }): Promise<OperationRun | undefined>;
  /** `id` is whatever a caller named: an id no run has answers `undefined`. */
  get(input: { clientInstanceId: ClientInstanceId; id: string }): Promise<OperationRun | undefined>;
  /** Newest first, by creation time and id. */
  list(input: {
    clientInstanceId: ClientInstanceId;
    filters?: OperationRunFilters;
    page?: StorePage;
  }): Promise<OperationRun[]>;
  /** Marks the waiting runs whose time ran out by the database's clock and returns them. */
  markExpired(input: { clientInstanceId: ClientInstanceId }): Promise<OperationRun[]>;
  /** Fails a run that is still `running` with the code `interrupted`. */
  markInterrupted(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
  }): Promise<OperationRun | undefined>;
}

/** The error of a run whose process ended before the call did. */
export const INTERRUPTED_RUN_ERROR = {
  code: "interrupted",
  message: "The call was interrupted before it finished"
};
