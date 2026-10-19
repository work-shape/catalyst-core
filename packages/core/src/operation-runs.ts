import {
  OPERATION_RUN_DECISION_MODES,
  OPERATION_RUN_DECISION_REASONS,
  OPERATION_RUN_STATUSES,
  OPERATION_TARGETS,
  PRINCIPAL_HOLDER_KINDS
} from "@work-shape/catalyst-asset-schemas";
import type { DelegatedActor } from "./identity";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId
} from "./ids";
import type { JsonValue } from "./json";
import type { OperationDenial } from "./operation-denial";
import type { OperationEffect, OperationOrigin } from "./operations";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

export {
  OPERATION_RUN_STATUSES,
  WAITING_OPERATION_RUN_STATUSES
} from "@work-shape/catalyst-asset-schemas";

export type OperationRunStatus = (typeof OPERATION_RUN_STATUSES)[number];

/**
 * Where a call went (ADR-0031). `live`: the asset it calls, for real. `test`: the test target
 * of that asset, for real (a Data Store's test copy, a Connection's test credential).
 * `dry_run`: nowhere; a changing call of a draft that answered what it would have done. Every
 * call of a published revision is `live`. `runOperation()` decides it, never its caller.
 */
export { OPERATION_TARGETS } from "@work-shape/catalyst-asset-schemas";

export type OperationTarget = (typeof OPERATION_TARGETS)[number];

/** Who called, as far as the run keeps it: never scopes, rights or an address. */
export interface OperationRunActor {
  kind: (typeof PRINCIPAL_HOLDER_KINDS)[number];
  id: string;
  label: string;
  delegatedActor?: DelegatedActor;
}

/**
 * Why a decision was taken the way it was, where the mode alone does not say it.
 * `inherited_approval_not_applied`: the instance default asked for another person's approval
 * and the call ran on its caller's word instead, because the operation answers a secret that
 * is shown once and so cannot wait. `workflow_publish`: a step of a run of a published Workflow
 * revision made a call whose policy asks its caller to confirm, and publishing the Workflow
 * was that confirmation: the publish review lists its changing operations. `approved_by_caller`:
 * a guardrail asked for an approval and the caller holds the right that decides it, so their
 * own call was the approval (`approval` of the operation's definition).
 */
export type OperationRunDecisionReason = (typeof OPERATION_RUN_DECISION_REASONS)[number];

export interface OperationRunDecision {
  /**
   * `direct`: nobody was asked when the call was made. The caller's own call was the
   * confirmation, or what `reason` names.
   */
  mode: (typeof OPERATION_RUN_DECISION_MODES)[number];
  reason?: OperationRunDecisionReason;
  by: string;
  /** The name of who decided, kept where the decision was another person's. */
  byLabel?: string;
  at: ISODateString;
  comment?: string;
  edited?: boolean;
  inputHashes?: string[];
}

/** What the model calls made inside a run used, summed over the calls. */
export interface OperationRunUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Why a run failed or was refused: a code and a message that is safe to show. */
export interface OperationRunError {
  code: string;
  message: string;
  /**
   * The fixed reason of the failure where the operation names one, such as the reason a call
   * of a Connection ended with. The message is a sentence for people and may change its words.
   */
  reason?: string;
  /**
   * Set where the call failed before the operation's implementation was reached, or the
   * implementation said that nothing of it stayed (`AppError.changedNothing`). Only such a
   * failed run of a changing operation is run again under its key.
   */
  unexecuted?: true;
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
  /** Where the call went. */
  target: OperationTarget;
  /** Set from agent and app origins. */
  conversationId?: ConversationId;
  /** A dry run holds none: a key it held would only ever answer a simulation again. */
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
  usage?: OperationRunUsage;
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
  | "target"
  | "conversationId"
  | "idempotencyKey"
  | "inputHash"
  | "correlationId"
> & {
  startedAt: ISODateString;
  /**
   * The operation is one that is called again under the key of an interrupted call
   * (`repeatsUnderKey`): a run of it that failed as `interrupted` is taken like one that
   * never executed.
   */
  takesInterrupted?: true;
};

/**
 * How a running call ends for its caller: with an outcome, or waiting for a decision. Only a
 * call an Agent Run's worker makes waits for its caller's confirmation (`inputRef`
 * `agent_run:<id>`): the run keeps the frozen input.
 */
export type OperationRunEnd = { finishedAt: ISODateString } & (
  | {
      status: "done";
      output?: { value: JsonValue };
      resultRef?: string;
      decision?: OperationRunDecision;
      usage?: OperationRunUsage;
    }
  | { status: "failed"; error: OperationRunError }
  | { status: "denied"; error: OperationRunError; denial: OperationDenial }
  | {
      status: "pending_approval";
      approvalRequestId: string;
      inputRef: string;
      expiresAt: ISODateString;
    }
  | {
      status: "pending_confirmation";
      inputRef: string;
      expiresAt: ISODateString;
      /**
       * The Inbox item the confirmation waits in, where it waits in its person's Inbox and not
       * in a conversation (OP-4b).
       */
      approvalRequestId?: string;
    }
);

/**
 * A call that left no run while it went on and ended refused or failed: a read whose
 * operation does not record every call.
 */
export type EndedOperationRun = Omit<NewOperationRun, "idempotencyKey"> & {
  end: Extract<OperationRunEnd, { status: "failed" | "denied" }>;
};

export interface OperationRunFilters {
  operation?: string;
  effect?: OperationEffect;
  status?: OperationRunStatus;
  actorId?: string;
  originKind?: OperationOrigin["kind"];
  workspaceId?: CollaborationWorkspaceId;
  /** Runs created at or after this moment. */
  since?: ISODateString;
}

export interface OperationRunStore {
  /**
   * Starts a run. Where the actor already used the run's idempotency key, nothing is inserted.
   * A failed run of the same operation and input is taken for its next attempt and returned
   * where it is a read, its error says `unexecuted`, or it was interrupted and the new run
   * says `takesInterrupted`. Every other run that holds the key
   * leaves the answer `undefined`: a changing call that failed or was interrupted after its
   * implementation started may have changed something, and is never run again under its key.
   */
  create(run: NewOperationRun): Promise<OperationRun | undefined>;
  /**
   * Writes the run of a call that has ended, in one statement. The run is never `running` in
   * the store. It is for a read that is recorded only because it was refused or failed, so it
   * takes no idempotency key.
   */
  recordEnded(run: EndedOperationRun): Promise<OperationRun>;
  /**
   * Ends a run that is still `running`. `undefined` when it is not running any more, or when
   * it is on another attempt than `attempt`: a later call took the run under its key, and
   * only the writer of that attempt ends it. A writer names the attempt its call was given.
   * The transaction that ends a run also queues the job of every Workflow step that waits
   * for it (`completion: async` of its operation), so no end is lost to a step.
   */
  finish(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    attempt?: number;
    end: OperationRunEnd;
  }): Promise<OperationRun | undefined>;
  /** Counts and recovery timestamps for a paged Workflow read, kept across job deferrals. */
  checkpointReading(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    pages: number;
    rows: number;
    bytes: number;
    pageAttempts: number;
    /** Paging deadline and the latest time progress may resume, including a deferred page. */
    deadlineAt: string;
    recoverAfter: string;
  }): Promise<boolean>;
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
  /**
   * Takes a run that waits for an approval, or a confirmed run that waits to be executed, to
   * execute its call: the one transition by which a decided call starts. `undefined` when the
   * run does not wait any more, so of two takers one executes.
   */
  resume(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    decision: OperationRunDecision;
    startedAt: ISODateString;
  }): Promise<OperationRun | undefined>;
  /**
   * Records a timely approval and queues the Agent Run atomically. A standalone attributed
   * call, or a completed turn from before approval pauses, returns `resumesAgent: false`.
   */
  approveWaiting(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    /**
     * `approved` for a call that waits for another person's approval; `confirmed` for one
     * that waits in its own person's Inbox (OP-4b), whose decision is always recorded here.
     */
    decision: OperationRunDecision & { mode: "approved" | "confirmed" };
  }): Promise<{ run: OperationRun; resumesAgent: boolean } | undefined>;
  /**
   * Moves a call its person confirmed in the Inbox on to wait for another person's approval,
   * which their own direct call would have waited for: the run waits `pending_approval` on
   * the new request, without a decision. `undefined` when the run is no confirmed call that
   * waits.
   */
  holdConfirmedForApproval(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    approvalRequestId: string;
    inputRef: string;
    expiresAt: ISODateString;
  }): Promise<OperationRun | undefined>;
  /** Ends a run that waits for a decision without executing it. `undefined` when it does not wait. */
  endWaiting(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    end: Extract<OperationRunEnd, { status: "denied" | "failed" }>;
    decision?: OperationRunDecision;
  }): Promise<OperationRun | undefined>;
  /**
   * Marks waiting runs whose time ran out by the database's clock and returns them, oldest
   * first and at most `limit` of them. A decided run that waits to be executed does not expire.
   */
  markExpired(input: {
    clientInstanceId: ClientInstanceId;
    limit: number;
  }): Promise<OperationRun[]>;
  /** The runs that have been `running` since before the moment, oldest first. */
  listRunningSince(input: {
    clientInstanceId: ClientInstanceId;
    startedBefore: ISODateString;
    limit: number;
  }): Promise<OperationRun[]>;
  /** Deletes the runs that conversations caused and their decided Inbox requests atomically.
   * A run with a pending request is kept until that request settles. */
  deleteOfConversations(input: {
    clientInstanceId: ClientInstanceId;
    conversationIds: readonly ConversationId[];
  }): Promise<number>;
  /**
   * Deletes ended runs no conversation caused that are older than the days, by the database's
   * clock, at most `limit` of them in one call. Decided Inbox requests leave atomically with
   * their runs; a run with a pending request is kept until that request settles.
   */
  deleteWithoutConversationOlderThan(input: {
    clientInstanceId: ClientInstanceId;
    days: number;
    limit: number;
  }): Promise<number>;
  /** Deletes at most `limit` settled held-call requests whose run no longer exists.
   * Pending requests and approved calls still queued for execution are kept. */
  deleteOrphanedRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
    limit: number;
  }): Promise<number>;
  /**
   * Fails a run that is still `running` with the code `interrupted`, and wakes the Workflow
   * steps that wait for it as `finish` does.
   */
  markInterrupted(input: {
    clientInstanceId: ClientInstanceId;
    id: OperationRunId;
    /** Do not end a paged read whose checkpoint advanced since the sweep read it. */
    recoverAfter?: string;
  }): Promise<OperationRun | undefined>;
}

/** The error of a run whose process ended before the call did. */
export const INTERRUPTED_RUN_ERROR = {
  code: "interrupted",
  message: "The call was interrupted before it finished"
};
