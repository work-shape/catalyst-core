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
  type ClaimAgentRunInput,
  type ClaimRunStartCommandInput,
  type ClaimRunStartCommandResult,
  type CompleteRunStartCommandInput,
  type HeartbeatAgentRunInput,
  type ReleaseRunStartCommandInput,
  type RecoverExpiredAgentRunsInput,
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
  claimNextAgentRun as claimNextPostgresAgentRun,
  claimRunStartCommand as claimPostgresRunStartCommand,
  completeRunStartCommand as completePostgresRunStartCommand,
  createAgentRun as createPostgresAgentRun,
  getAgentRun as getPostgresAgentRun,
  getActiveConversationAgentRun as getPostgresActiveConversationAgentRun,
  getConversationAgentRun as getPostgresConversationAgentRun,
  getLatestConversationAgentRun as getPostgresLatestConversationAgentRun,
  heartbeatAgentRun as heartbeatPostgresAgentRun,
  listRunObservations as listPostgresRunObservations,
  prepareConversationRunStart as preparePostgresConversationRunStart,
  listStaleActiveAgentRuns as listPostgresStaleActiveAgentRuns,
  releaseRunStartCommand as releasePostgresRunStartCommand,
  recoverStaleAgentRun as recoverPostgresStaleAgentRun,
  recoverExpiredAgentRuns as recoverPostgresExpiredAgentRuns,
  listAgentRunsInProgress as listPostgresAgentRunsInProgress,
  requestAgentRunCancellation as requestPostgresAgentRunCancellation,
  updateAgentRunStatus as updatePostgresAgentRunStatus
} from "../postgres-agent-run-operations";
import type { AgentRunsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresAgentRunsStore(db: PostgresConnection): AgentRunsStore {
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
      return preparePostgresConversationRunStart(db, input);
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
    async listStaleActiveAgentRuns(
      input: Parameters<AgentRunStore["listStaleActiveAgentRuns"]>[0]
    ) {
      return listPostgresStaleActiveAgentRuns(db, input);
    },
    async recoverStaleAgentRun(input: Parameters<AgentRunStore["recoverStaleAgentRun"]>[0]) {
      return recoverPostgresStaleAgentRun(db, input);
    },
    async claimNextAgentRun(input: ClaimAgentRunInput): Promise<AgentRun | undefined> {
      return claimNextPostgresAgentRun(db, input);
    },
    async heartbeatAgentRun(input: HeartbeatAgentRunInput): Promise<AgentRun> {
      return heartbeatPostgresAgentRun(db, input);
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
    async recoverExpiredAgentRuns(input: RecoverExpiredAgentRunsInput): Promise<AgentRun[]> {
      return recoverPostgresExpiredAgentRuns(db, input);
    },
    async appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation> {
      return appendPostgresRunObservation(db, input);
    },
    async listRunObservations(input: Parameters<RunObservationStore["listRunObservations"]>[0]) {
      return listPostgresRunObservations(db, input);
    }
  };
}
