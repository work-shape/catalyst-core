import {
  agentRunJobOptions,
  createPlatformId,
  executeAgentRunJob,
  type AgentRun,
  type AgentRunJobLease,
  type AgentRunResumeState,
  type AgentRunStatus,
  type CollaborationWorkspace,
  type Conversation,
  type ConversationId,
  type OperationRunId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { PostgresSuite } from "./postgres-suite";

/** A run as the attempt of its job holds it. */
export interface ClaimedTestRun {
  run: AgentRun;
  lease: AgentRunJobLease;
}

/** A subagent with its thread and the Operation Run of the call that started it. */
export interface StartedTestSubagent {
  run: AgentRun;
  threadId: ConversationId;
  operationRunId: OperationRunId;
}

/**
 * One client instance on the test database with a person, their personal workspace, and what
 * the subagent tests arrange: a parent run that a job holds, its subagents, the parent's pause
 * and the ends of runs, each through the store a test names.
 */
export async function createSubagentFixture(db: PostgresSuite, label: string) {
  const clientInstanceId = db.clientInstance(label);
  const scope = { clientInstanceId };
  const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Author" });
  const workspace = await db.store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: user.id
  });

  const createSharedWorkspace = (name: string) =>
    db.store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name,
      visibility: "discoverable",
      creatorUserId: user.id
    });
  const createConversation = (
    title: string,
    input: { retainedUntil?: string; workspace?: CollaborationWorkspace } = {}
  ) =>
    db.store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: (input.workspace ?? workspace).id,
      createdByUserId: user.id,
      createdByExternalUserId: "user_test",
      title,
      retainedUntil: input.retainedUntil ?? "2999-01-01T00:00:00.000Z"
    });

  /**
   * Claims a queued run as its job does. The job is put into the state a worker's claim leaves
   * it in, without a worker: the token is that attempt's hold on the run.
   */
  const claim = async (run: AgentRun): Promise<ClaimedTestRun> => {
    // A subagent's job was enqueued with it; the same dedupe key answers that job.
    const job = await db.store.jobs.enqueue(
      executeAgentRunJob,
      { runId: run.id },
      agentRunJobOptions(run)
    );
    const leaseToken = `lease_${run.id}`;
    await db.sql`
      update platform_jobs
      set status = 'running', attempts = 1, started_at = now(), lease_owner = 'subagent-test',
        lease_token = ${leaseToken}, lease_expires_at = now() + interval '10 minutes'
      where id = ${job.id}`;
    const lease = { jobId: job.id, leaseToken };
    const claimed = await db.store.agentRuns.claimAgentRunForJob({
      ...scope,
      runId: run.id,
      lease,
      leaseMs: executeAgentRunJob.leaseMs
    });
    if (claimed.status !== "claimed") throw new Error("The queued run was not claimed");
    return { run: claimed.row, lease };
  };

  /** A run of the person in the conversation, claimed by its job. */
  const startParent = async (conversation: Conversation): Promise<ClaimedTestRun> => {
    const message = await db.store.conversations.appendMessage({
      ...scope,
      conversationId: conversation.id,
      role: "user",
      text: "split this in two"
    });
    const run = await db.store.agentRuns.createAgentRun({
      id: createPlatformId<"AgentRunId">("run"),
      ...scope,
      conversationId: conversation.id,
      ownerUserId: user.id,
      inputMessageId: message.id,
      agentName: "test_agent",
      status: "queued",
      correlationId: "corr_subagent_parent"
    });
    return claim(run);
  };

  /** A subagent of the parent, as its `run_agent` call starts it: queued with its job. */
  const startChild = async (
    parent: AgentRun,
    description: string,
    stores: Pick<PlatformStores, "childAgentRuns"> = db.store
  ): Promise<StartedTestSubagent> => {
    const operationRunId = createPlatformId<"OperationRunId">("oprun");
    const started = await stores.childAgentRuns.startSubagentRun({
      ...scope,
      parentRunId: parent.id,
      parentOperationRunId: operationRunId,
      agentName: "test_agent",
      description,
      task: `the task of ${description}`,
      correlationId: `corr_${description}`
    });
    if (started.status !== "started") throw new Error("The subagent was not started");
    return { run: started.run, threadId: started.threadId, operationRunId };
  };

  /** The parent's step is through while its subagents may still run. */
  const pause = (
    stores: PlatformStores,
    parent: ClaimedTestRun,
    children: StartedTestSubagent[]
  ) => {
    const resumeState: AgentRunResumeState = {
      version: 1,
      step: 0,
      stepMessageId: "msg_step",
      modelInputFrom: { kind: "input" },
      toolCalls: [],
      doneToolCallIds: [],
      waiting: [],
      repeatedToolCalls: {},
      compacted: false,
      subagents: children.map((child, index) => ({
        toolCallId: `call_${index}`,
        operationRunId: child.operationRunId,
        runId: child.run.id
      }))
    };
    return stores.childAgentRuns.pauseClaimedAgentRunForSubagents({
      ...scope,
      runId: parent.run.id,
      lease: parent.lease,
      resumeState
    });
  };

  /** The worker's end of a claimed subagent: its answer and `run_completed` in one transaction. */
  const complete = (stores: PlatformStores, child: ClaimedTestRun, answer: string) =>
    stores.agentRuns.appendClaimedAgentRunEnd({
      ...scope,
      runId: child.run.id,
      lease: child.lease,
      message: {
        ...scope,
        role: "assistant",
        conversationId: child.run.conversationId,
        text: answer
      },
      events: [
        {
          type: "run_completed",
          runId: child.run.id,
          sequence: child.run.lastSequence + 1,
          createdAt: new Date().toISOString()
        }
      ]
    });

  /** Ends a run with a status, as the API and the upkeep do. */
  const end = (stores: PlatformStores, run: AgentRun, status: AgentRunStatus) => {
    const now = new Date().toISOString();
    return stores.agentRuns.updateAgentRunStatus({
      ...scope,
      runId: run.id,
      status,
      updatedAt: now,
      ...(status === "completed" ? { completedAt: now } : {}),
      ...(status === "cancelled" ? { cancelledAt: now } : {})
    });
  };

  /** Stop on a run: one that no worker holds ends within the request. */
  const stop = (stores: PlatformStores, run: AgentRun) =>
    stores.agentRuns.requestAgentRunCancellation({
      ...scope,
      runId: run.id,
      requestedAt: new Date().toISOString()
    });

  /** Read from the row, so that a run of a deleted conversation is still read. */
  const statusOf = async (run: AgentRun) => {
    const [row] = await db.sql<Array<{ status: string }>>`
      select status from agent_runs where id = ${run.id}`;
    return row?.status;
  };
  /** The `agent_run.execute` jobs of a run, oldest first. */
  const executeJobsOf = async (run: AgentRun) =>
    (
      await db.sql<Array<{ id: string; status: string; dedupe_key: string | null }>>`
        select id, status, dedupe_key from platform_jobs
        where client_instance_id = ${clientInstanceId} and subject = ${run.id}
          and kind = ${executeAgentRunJob.kind}
        order by created_at, id`
    ).map((row) => ({ ...row }));
  const conversationStatusOf = async (conversationId: ConversationId) => {
    const [row] = await db.sql<Array<{ status: string }>>`
      select status from conversations where id = ${conversationId}`;
    return row?.status;
  };

  return {
    clientInstanceId,
    scope,
    user,
    workspace,
    createSharedWorkspace,
    createConversation,
    claim,
    startParent,
    startChild,
    pause,
    complete,
    end,
    stop,
    statusOf,
    executeJobsOf,
    conversationStatusOf
  };
}
