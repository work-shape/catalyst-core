import { SCHEDULED_START_STATES } from "@work-shape/catalyst-asset-schemas";
export { SCHEDULED_START_STATES };
import type { AgentRunId, ClientInstanceId, CollaborationWorkspaceId, ConversationId } from "./ids";
import type { StorePage } from "./paging";

/**
 * The kind of the job that fires one due time of a saved start. It is named here because a store
 * that clears `nextRunAt` withdraws the queued tick in the same transaction.
 */
export const SCHEDULED_PROMPT_JOB_KIND = "scheduled_prompt.fire";

/** The dedupe key of the tick for one due time. A manual Run now never shares a scheduled key. */
export function scheduledPromptDedupeKey(
  scheduledStartId: string,
  dueAt: string,
  manual = false
): string {
  return `${SCHEDULED_PROMPT_JOB_KIND}:${scheduledStartId}:${manual ? "manual:" : ""}${dueAt}`;
}

/** A person's saved prompt, independent of Workflows. Times are ISO instants. */
export interface ScheduledStart {
  id: string;
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  agentName: string;
  prompt: string;
  cron: string;
  timeZone: string;
  state: (typeof SCHEDULED_START_STATES)[number];
  nextRunAt: string | null;
  personalConnectionsAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledStartRun {
  id: string;
  /** Null after deletion of the saved start; an existing run keeps its provenance. */
  scheduledStartId: string | null;
  scheduledFor: string;
  conversationId: ConversationId | null;
  agentRunId: AgentRunId | null;
  status: string;
  reason: string | null;
  /** Immutable consent at the moment this run started. */
  personalConnectionsAllowed: boolean;
  createdAt: string;
}

type StartRef = { clientInstanceId: ClientInstanceId; id: string };

export interface ScheduledStartsStore {
  list(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    page: StorePage;
  }): Promise<ScheduledStart[]>;
  /** The caller holds this lock through its transaction when dispatching or changing a start. */
  get(input: StartRef & { forUpdate?: boolean }): Promise<ScheduledStart | undefined>;
  create(input: { start: ScheduledStart }): Promise<ScheduledStart>;
  update(
    input: StartRef & {
      ownerUserId: string;
      patch: Partial<
        Pick<
          ScheduledStart,
          | "ownerUserId"
          | "agentName"
          | "prompt"
          | "cron"
          | "timeZone"
          | "state"
          | "nextRunAt"
          | "personalConnectionsAllowed"
        >
      >;
      now: string;
    }
  ): Promise<ScheduledStart>;
  delete(input: StartRef & { ownerUserId: string }): Promise<void>;
  /** Under the start's row lock, detach the previous owner's results before handover. */
  detachRuns(input: {
    clientInstanceId: ClientInstanceId;
    scheduledStartId: string;
  }): Promise<void>;
  /** Remove runless history older than the instance's audit retention boundary. */
  pruneRunless(input: {
    clientInstanceId: ClientInstanceId;
    scheduledStartId: string;
    keepAfter: string;
  }): Promise<void>;
  listRuns(input: {
    clientInstanceId: ClientInstanceId;
    scheduledStartId: string;
    page: StorePage;
  }): Promise<ScheduledStartRun[]>;
  addRun(input: { clientInstanceId: ClientInstanceId; run: ScheduledStartRun }): Promise<void>;
  getRun(input: {
    clientInstanceId: ClientInstanceId;
    scheduledStartId: string;
    scheduledFor: string;
  }): Promise<ScheduledStartRun | undefined>;
  hasOpenRun(input: {
    clientInstanceId: ClientInstanceId;
    scheduledStartId: string;
  }): Promise<"waiting_for_decision" | "active" | undefined>;
  isScheduledAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }): Promise<{ personalConnectionsAllowed: boolean } | undefined>;
}
