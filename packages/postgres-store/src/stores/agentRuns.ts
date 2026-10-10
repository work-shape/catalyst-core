import {
  type ChatMessage,
  type AssertClaimedAgentRunInput,
  type ClientInstanceId,
  type ConversationId,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AppendClaimedAgentRunMessageInput,
  type AppendClaimedRunObservationInput,
  type AppendRunObservationInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type CompleteRunStartCommandInput,
  type ReleaseRunStartCommandInput,
  type RequestAgentRunCancellationInput,
  type RunObservation,
  type RunObservationStore,
  type UpdateAgentRunStatusInput
} from "@vivd-catalyst/core";
import {
  appendClaimedAgentRunMessage as appendPostgresClaimedAgentRunMessage,
  appendClaimedRunObservation as appendPostgresClaimedRunObservation,
  appendRunObservation as appendPostgresRunObservation,
  assertClaimedAgentRun as assertPostgresClaimedAgentRun,
  claimAgentRunForJob as claimPostgresAgentRunForJob,
  failLostAgentRun as failLostPostgresAgentRun,
  listAgentRunsWithoutJob as listPostgresAgentRunsWithoutJob,
  renewAgentRunJobLease as renewPostgresAgentRunJobLease,
  claimRunStartCommand as claimPostgresRunStartCommand,
  completeRunStartCommand as completePostgresRunStartCommand,
  createAgentRun as createPostgresAgentRun,
  getAgentRun as getPostgresAgentRun,
  getActiveConversationAgentRun as getPostgresActiveConversationAgentRun,
  getConversationAgentRun as getPostgresConversationAgentRun,
  getLatestConversationAgentRun as getPostgresLatestConversationAgentRun,
  listRunObservations as listPostgresRunObservations,
  prepareConversationRunStart as preparePostgresConversationRunStart,
  releaseRunStartCommand as releasePostgresRunStartCommand,
  listAgentRunsInProgress as listPostgresAgentRunsInProgress,
  requestAgentRunCancellation as requestPostgresAgentRunCancellation,
  updateAgentRunStatus as updatePostgresAgentRunStatus
} from "../postgres-agent-run-operations";
import type { AgentRunsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
/** `enqueued` is called for every job this store inserts, before its transaction commits. */
export function createPostgresAgentRunsStore(
  db: PostgresConnection,
  enqueued: () => void
): AgentRunsStore {
  return {
    async claimRunStartCommand(
      input: ClaimRunStartCommandInput
    ): Promise<ClaimRunStartCommandResult> {
      return claimPostgresRunStartCommand(db, input);
    },
    async completeRunStartCommand(input: CompleteRunStartCommandInput) {
      return completePostgresRunStartCommand(db, input);
    },
    async releaseRunStartCommand(input: ReleaseRunStartCommandInput): Promise<void> {
      return releasePostgresRunStartCommand(db, input);
    },
    async prepareConversationRunStart(
      input: Parameters<AgentRunStore["prepareConversationRunStart"]>[0]
    ) {
      const prepared = await preparePostgresConversationRunStart(db, input);
      if (prepared.run.status === "queued") enqueued();
      return prepared;
    },
    async createAgentRun(input: Parameters<AgentRunStore["createAgentRun"]>[0]): Promise<AgentRun> {
      return createPostgresAgentRun(db, input);
    },
    async getAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      runId: AgentRunId;
    }): Promise<AgentRun | undefined> {
      return getPostgresAgentRun(db, input);
    },
    async getConversationAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      runId: AgentRunId;
    }): Promise<AgentRun | undefined> {
      return getPostgresConversationAgentRun(db, input);
    },
    async getActiveConversationAgentRun(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      ownerUserId: string;
    }): Promise<AgentRun | undefined> {
      return getPostgresActiveConversationAgentRun(db, input);
    },
    async getLatestConversationAgentRun(
      input: Parameters<AgentRunStore["getLatestConversationAgentRun"]>[0]
    ): Promise<AgentRun | undefined> {
      return getPostgresLatestConversationAgentRun(db, input);
    },
    async updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun> {
      return updatePostgresAgentRunStatus(db, input);
    },
    async claimAgentRunForJob(input: Parameters<AgentRunStore["claimAgentRunForJob"]>[0]) {
      return claimPostgresAgentRunForJob(db, input);
    },
    async renewAgentRunJobLease(input: Parameters<AgentRunStore["renewAgentRunJobLease"]>[0]) {
      return renewPostgresAgentRunJobLease(db, input);
    },
    async failLostAgentRun(input: Parameters<AgentRunStore["failLostAgentRun"]>[0]) {
      return failLostPostgresAgentRun(db, input);
    },
    async listAgentRunsWithoutJob(input: Parameters<AgentRunStore["listAgentRunsWithoutJob"]>[0]) {
      return listPostgresAgentRunsWithoutJob(db, input);
    },
    async requestAgentRunCancellation(input: RequestAgentRunCancellationInput): Promise<AgentRun> {
      return requestPostgresAgentRunCancellation(db, input);
    },
    async listAgentRunsInProgress(
      input: Parameters<AgentRunsStore["listAgentRunsInProgress"]>[0]
    ): Promise<AgentRun[]> {
      return listPostgresAgentRunsInProgress(db, input);
    },
    async appendClaimedRunObservation(
      input: AppendClaimedRunObservationInput
    ): Promise<RunObservation> {
      return appendPostgresClaimedRunObservation(db, input);
    },
    async assertClaimedAgentRun(input: AssertClaimedAgentRunInput): Promise<AgentRun> {
      return assertPostgresClaimedAgentRun(db, input);
    },
    async appendClaimedAgentRunMessage(
      input: AppendClaimedAgentRunMessageInput
    ): Promise<ChatMessage> {
      return appendPostgresClaimedAgentRunMessage(db, input);
    },
    async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
      return appendPostgresRunObservation(db, input);
    },
    async listRunObservations(input: Parameters<RunObservationStore["listRunObservations"]>[0]) {
      return listPostgresRunObservations(db, input);
    }
  };
}
