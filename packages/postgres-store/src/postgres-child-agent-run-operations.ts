import {
  ACTIVE_AGENT_RUN_STATUSES,
  readAssistantToolCallsMetadata,
  AppError,
  SUBAGENTS_PER_RUN,
  SUBAGENT_ANSWER_MAX_LENGTH,
  SUBAGENT_FILES_MAX,
  WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES,
  WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS,
  WORKFLOW_STEP_TRANSCRIPT_TOOL_INPUT_MAX_CHARS,
  agentRunJobOptions,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  executeAgentRunJob,
  type AgentRunError,
  type ChildAgentRunStore,
  type ClientInstanceId,
  type StartSubagentRunInput,
  type StartSubagentRunResult,
  type SubagentOutcome,
  type SubagentSummary,
  type WorkflowAgentRunData
} from "@work-shape/catalyst-core";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { requestAgentRunCancellation } from "./postgres-agent-run-cancellation";
import { enqueueJob } from "./jobs/store";
import { enqueueSubagentWake, hasOpenChildren } from "./postgres-agent-run-lineage";
import { lockAgentRunConversations } from "./postgres-agent-run-locks";
import { claimedRunWhere, requireJobLease } from "./postgres-agent-run-worker-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapAgentRun } from "./rows";
import {
  agentRuns,
  conversations,
  managedArtifacts,
  messages,
  operationRuns,
  modelUsageEvents,
  workspaceCommands
} from "./schema";

// Child Agent Runs (CR-1): a subagent's start in its run thread, the parent's wait for its
// subagents, and what the parent and the Resources panel read of them. The lock order is the
// one `postgres-agent-run-lineage.ts` states.

type AgentRunRow = typeof agentRuns.$inferSelect;

export function createPostgresChildAgentRunStore(
  db: PostgresConnection,
  enqueued: () => void
): ChildAgentRunStore {
  return {
    async readWorkflowAgentSummaries(input) {
      if (input.stepRunIds.length === 0) return new Map();
      const rows = await db
        .select({
          stepRunId: agentRuns.workflowStepRunId,
          runId: agentRuns.id,
          status: agentRuns.status,
          modelCallCount: sql<number>`count(${modelUsageEvents.id})::int`,
          inputTokens: sql<number>`coalesce(sum(${modelUsageEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${modelUsageEvents.outputTokens}), 0)::int`,
          totalTokens: sql<number>`coalesce(sum(${modelUsageEvents.totalTokens}), 0)::int`
        })
        .from(agentRuns)
        .leftJoin(
          modelUsageEvents,
          and(
            eq(modelUsageEvents.clientInstanceId, agentRuns.clientInstanceId),
            eq(modelUsageEvents.agentRunId, agentRuns.id)
          )
        )
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            inArray(agentRuns.workflowStepRunId, [...input.stepRunIds])
          )
        )
        .groupBy(agentRuns.id);
      const summaries = new Map<string, WorkflowAgentRunData>();
      for (const { stepRunId, runId, status, ...usage } of rows)
        if (stepRunId) summaries.set(stepRunId, { runId: asAgentRunId(runId), status, usage });
      return summaries;
    },
    async readWorkflowAgentTranscript(input) {
      const child = await this.readWorkflowAgentRun(input);
      if (!child) return undefined;
      const rows = await db
        .select({
          role: messages.role,
          text: sql<string>`left(${messages.text}, ${WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS})`,
          cut: sql<boolean>`length(${messages.text}) > ${WORKFLOW_STEP_TRANSCRIPT_TEXT_MAX_CHARS}`,
          metadata: messages.metadata
        })
        .from(messages)
        .where(
          and(
            eq(messages.clientInstanceId, input.clientInstanceId),
            eq(messages.conversationId, child.conversationId)
          )
        )
        .orderBy(asc(messages.createdAt), asc(messages.storageOrdinal))
        .limit(WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES + 1);
      let truncated = rows.length > WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES;
      const transcriptMessages = rows
        .slice(0, WORKFLOW_STEP_TRANSCRIPT_MAX_MESSAGES)
        .flatMap(({ role, text, cut, metadata }) => {
          if (cut) truncated = true;
          const toolCalls = readAssistantToolCallsMetadata(metadata)?.toolCalls.map(
            ({ toolName, input: toolInput }) => {
              const fits =
                (JSON.stringify(toolInput) ?? "").length <=
                WORKFLOW_STEP_TRANSCRIPT_TOOL_INPUT_MAX_CHARS;
              if (!fits) truncated = true;
              return fits ? { toolName, input: toolInput } : { toolName };
            }
          );
          const message = { role, text, ...(toolCalls?.length ? { toolCalls } : {}) };
          // The repair turn's prompt is kept with the answer it rejected.
          const repairPrompt = metadata.workflowRepairPrompt;
          return typeof repairPrompt === "string"
            ? [message, { role: "user", text: repairPrompt }]
            : [message];
        });
      return { runId: child.id, messages: transcriptMessages, truncated };
    },
    async startWorkflowAgentRun(input) {
      const [existing] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(agentRuns.workflowStepRunId, input.stepRunId)
          )
        )
        .limit(1);
      if (existing) return mapAgentRun(existing);
      const at = new Date();
      const threadId = createPlatformId<"ConversationId">("conv");
      const inputMessageId = createPlatformId<"MessageId">("msg");
      await db.insert(conversations).values({
        id: threadId,
        clientInstanceId: input.clientInstanceId,
        kind: "run_thread",
        workflowRunId: input.runId,
        visibility: "private",
        title: input.title,
        status: "active",
        createdAt: at,
        updatedAt: at,
        retainedUntil: new Date(input.retainedUntil)
      });
      await db.insert(messages).values({
        id: inputMessageId,
        clientInstanceId: input.clientInstanceId,
        conversationId: threadId,
        role: "user",
        text: input.task,
        metadata: {},
        createdAt: at
      });
      const [row] = await db
        .insert(agentRuns)
        .values({
          id: createPlatformId<"AgentRunId">("run"),
          clientInstanceId: input.clientInstanceId,
          conversationId: threadId,
          principalId: input.tester ? null : input.principal.id,
          ...(input.tester ? { ownerUserId: input.tester.id } : {}),
          workflowStepRunId: input.stepRunId,
          inputMessageId,
          agentName: input.agentName,
          status: "queued",
          startedAt: at,
          updatedAt: at,
          correlationId: input.correlationId,
          authorizationContext: {
            principal: input.tester
              ? {
                  kind: "user",
                  id: input.tester.id,
                  displayLabel: input.tester.displayLabel,
                  clientInstanceId: input.clientInstanceId,
                  authSource: input.tester.authSource,
                  externalUserId: input.tester.externalUserId
                }
              : {
                  kind: "service",
                  id: input.principal.id,
                  displayLabel: input.principal.displayLabel,
                  clientInstanceId: input.clientInstanceId,
                  authSource: "workflow_run"
                },
            subjectUserId: input.tester?.id ?? input.principal.id,
            scopes: []
          }
        })
        .returning();
      const run = mapAgentRun(row);
      await enqueueJob(db, executeAgentRunJob, { runId: run.id }, agentRunJobOptions(run));
      enqueued();
      return run;
    },
    async cancelWorkflowAgentRuns(input) {
      const rows = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(conversations.workflowRunId, input.runId),
            inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
          )
        );
      for (const row of rows)
        await requestAgentRunCancellation(db, {
          clientInstanceId: input.clientInstanceId,
          runId: asAgentRunId(row.id),
          requestedAt: new Date().toISOString(),
          reason: "The Workflow run ended"
        });
    },
    async readWorkflowAgentRun(input) {
      const [row] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.clientInstanceId, input.clientInstanceId),
            eq(agentRuns.workflowStepRunId, input.stepRunId)
          )
        )
        .limit(1);
      return row ? mapAgentRun(row) : undefined;
    },
    async startSubagentRun(input) {
      const started = await startSubagentRun(db, input);
      if (started.status === "started" && started.run.status === "queued") enqueued();
      return started;
    },
    async pauseClaimedAgentRunForSubagents(input) {
      const paused = await pauseClaimedAgentRunForSubagents(db, input);
      if (paused.status === "queued") enqueued();
      return paused;
    },
    readSubagentOutcomes: (input) => readSubagentOutcomes(db, input),
    async listRunThreadIds(input) {
      const rows = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientInstanceId, input.clientInstanceId),
            eq(conversations.parentConversationId, input.rootConversationId)
          )
        )
        .orderBy(asc(conversations.id));
      return rows.map((row) => asConversationId(row.id));
    },
    listSubagents: (input) => listSubagents(db, input)
  };
}

async function startSubagentRun(
  db: PostgresConnection,
  input: StartSubagentRunInput
): Promise<StartSubagentRunResult> {
  const { clientInstanceId } = input;
  return db.transaction(async (tx) => {
    // The root conversation, then the parent run: the order of the parent's own writes.
    await lockAgentRunConversations(tx, clientInstanceId, [input.parentRunId]);
    const [parent] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.id, input.parentRunId))
      )
      .for("update");
    if (!parent) throw new AppError("NOT_FOUND", "Agent run is not available");

    // The call under the same key answers the child it started.
    const [existing] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientInstanceId, clientInstanceId),
          eq(agentRuns.parentOperationRunId, input.parentOperationRunId)
        )
      )
      .limit(1);
    if (existing) {
      if (existing.parentRunId !== parent.id) {
        throw new AppError("CONFLICT", "The call started a subagent of another run");
      }
      return {
        status: "started",
        run: mapAgentRun(existing),
        threadId: asConversationId(existing.conversationId)
      };
    }

    if (parent.status !== "running") throw new AppError("CONFLICT", "Agent run has ended");
    // A subagent is never offered `run_agent`; this holds the depth where a call gets here.
    if (parent.depth !== 0 || parent.parentRunId !== null) {
      throw new AppError("FORBIDDEN", "A subagent starts no subagent of its own");
    }
    if (parent.ownerUserId === null) {
      throw new AppError("FORBIDDEN", "Only a run for a person starts a subagent");
    }
    const [started] = await tx
      .select({ count: count() })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.clientInstanceId, clientInstanceId), eq(agentRuns.parentRunId, parent.id))
      );
    if ((started?.count ?? 0) >= SUBAGENTS_PER_RUN) return { status: "limit_reached" };

    const [root] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, clientInstanceId),
          eq(conversations.id, parent.conversationId)
        )
      )
      .limit(1);
    if (!root || root.status !== "active" || root.kind !== "chat") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }

    const now = new Date();
    const threadId = createPlatformId<"ConversationId">("conv");
    // A thread carries its root's workspace, visibility and creator, so it is read and
    // deleted as its root is; its title is the subagent's description.
    await tx.insert(conversations).values({
      id: threadId,
      clientInstanceId,
      kind: "run_thread",
      parentConversationId: root.id,
      collaborationWorkspaceId: root.collaborationWorkspaceId,
      createdByUserId: root.createdByUserId,
      createdByExternalUserId: root.createdByExternalUserId,
      visibility: root.visibility,
      title: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now,
      retainedUntil: root.retainedUntil
    });
    const inputMessageId = createPlatformId<"MessageId">("msg");
    await tx.insert(messages).values({
      id: inputMessageId,
      clientInstanceId,
      conversationId: threadId,
      role: "user",
      text: input.task,
      metadata: {},
      createdAt: now
    });
    const [row] = await tx
      .insert(agentRuns)
      .values({
        id: createPlatformId<"AgentRunId">("run"),
        clientInstanceId,
        conversationId: threadId,
        // The subagent acts as the parent run's person, with what the parent was allowed.
        ownerUserId: parent.ownerUserId,
        parentRunId: parent.id,
        rootRunId: parent.rootRunId ?? parent.id,
        depth: 1,
        parentOperationRunId: input.parentOperationRunId,
        inputMessageId,
        agentName: input.agentName,
        modelBindingId: input.modelBindingId,
        reasoningEffort: input.reasoningEffort,
        locale: parent.locale,
        authorizationContext: parent.authorizationContext,
        status: "queued",
        startedAt: now,
        updatedAt: now,
        lastSequence: 0,
        correlationId: input.correlationId
      })
      .returning();
    const run = mapAgentRun(row);
    await enqueueJob(tx, executeAgentRunJob, { runId: run.id }, agentRunJobOptions(run));
    return { status: "started", run, threadId: asConversationId(threadId) };
  });
}

async function pauseClaimedAgentRunForSubagents(
  db: PostgresConnection,
  input: Parameters<ChildAgentRunStore["pauseClaimedAgentRunForSubagents"]>[0]
): Promise<{ status: "waiting_for_subagents" | "queued" }> {
  return db.transaction(async (tx) => {
    await requireJobLease(tx, input.lease);
    await lockAgentRunConversations(tx, input.clientInstanceId, [input.runId]);
    const [run] = await tx.select().from(agentRuns).where(claimedRunWhere(input)).for("update");
    if (!run) throw new AppError("CONFLICT", "Agent run has ended");
    if (run.status !== "running") throw new AppError("CONFLICT", "Agent run was asked to cancel");
    // Read under the run's lock: a child that ended before this transaction is seen here, and
    // one that ends after it waits for the lock and then finds the run waiting.
    const waits = await hasOpenChildren(tx, input.clientInstanceId, run.id);
    await tx
      .update(agentRuns)
      .set({
        status: waits ? "waiting_for_subagents" : "queued",
        resumeState: input.resumeState,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: sql`now()`
      })
      .where(and(eq(agentRuns.clientInstanceId, input.clientInstanceId), eq(agentRuns.id, run.id)));
    if (waits) return { status: "waiting_for_subagents" };
    await enqueueSubagentWake(tx, run);
    return { status: "queued" };
  });
}

async function readSubagentOutcomes(
  db: PostgresConnection,
  input: Parameters<ChildAgentRunStore["readSubagentOutcomes"]>[0]
): Promise<SubagentOutcome[]> {
  if (input.runIds.length === 0) return [];
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, input.clientInstanceId),
        eq(agentRuns.parentRunId, input.parentRunId),
        inArray(agentRuns.id, [...input.runIds])
      )
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const outcomes: SubagentOutcome[] = [];
  for (const runId of input.runIds) {
    const row = byId.get(runId);
    if (!row) throw new AppError("NOT_FOUND", "A subagent of this run is not available");
    outcomes.push(await outcomeOf(db, input.clientInstanceId, row));
  }
  return outcomes;
}

async function outcomeOf(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  row: AgentRunRow
): Promise<SubagentOutcome> {
  const runId = asAgentRunId(row.id);
  if (ACTIVE_AGENT_RUN_STATUSES.some((status) => status === row.status)) {
    return { runId, status: "open" };
  }
  const files = await filesOf(db, clientInstanceId, row.id);
  const base = {
    runId,
    agent: row.agentName,
    ...(files.length > 0 ? { files } : {})
  };
  if (row.status === "completed") {
    const [answer] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(
        and(
          eq(messages.clientInstanceId, clientInstanceId),
          eq(messages.conversationId, row.conversationId),
          eq(messages.role, "assistant")
        )
      )
      .orderBy(desc(messages.storageOrdinal))
      .limit(1);
    const text = answer?.text ?? "";
    return {
      ...base,
      status: "completed",
      answer: text.slice(0, SUBAGENT_ANSWER_MAX_LENGTH),
      ...(text.length > SUBAGENT_ANSWER_MAX_LENGTH ? { answerTruncated: true } : {})
    };
  }
  if (row.status === "cancelled") {
    return {
      ...base,
      status: "cancelled",
      error: { code: "cancelled", message: "The subagent was stopped before it finished." }
    };
  }
  return { ...base, status: "failed", error: failureOf(row.error) };
}

/**
 * Why a subagent failed, as its parent's model reads it: the code of the failure and a fixed
 * sentence of its kind. A provider's own text never reaches the parent.
 */
function failureOf(error: AgentRunError | null): { code: string; message: string } {
  const code = error?.code ?? "failed";
  return {
    code,
    message:
      error?.category === "app_error"
        ? `The subagent could not finish: ${error.message}`
        : "The subagent failed before it finished."
  };
}

/** The files a subagent made, as the root conversation keeps them. */
async function filesOf(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  runId: string
): Promise<{ id: string; name: string; mimeType: string }[]> {
  const rows = await db
    .select({
      id: managedArtifacts.id,
      filename: managedArtifacts.filename,
      mimeType: managedArtifacts.mimeType
    })
    .from(managedArtifacts)
    .innerJoin(
      workspaceCommands,
      and(
        eq(workspaceCommands.clientInstanceId, managedArtifacts.clientInstanceId),
        eq(workspaceCommands.id, sql<string>`${managedArtifacts.metadata} ->> 'commandId'`)
      )
    )
    .where(
      and(
        eq(managedArtifacts.clientInstanceId, clientInstanceId),
        eq(workspaceCommands.agentRunId, runId),
        eq(managedArtifacts.status, "available")
      )
    )
    .orderBy(asc(managedArtifacts.createdAt), asc(managedArtifacts.id))
    .limit(SUBAGENT_FILES_MAX);
  return rows.map((file) => ({
    id: file.id,
    name: file.filename ?? file.id,
    mimeType: file.mimeType
  }));
}

async function listSubagents(
  db: PostgresConnection,
  input: Parameters<ChildAgentRunStore["listSubagents"]>[0]
): Promise<SubagentSummary[]> {
  const rows = await db
    .select({ run: agentRuns, title: conversations.title, origin: operationRuns.origin })
    .from(conversations)
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.clientInstanceId, conversations.clientInstanceId),
        eq(agentRuns.conversationId, conversations.id)
      )
    )
    .innerJoin(
      operationRuns,
      and(
        eq(operationRuns.clientInstanceId, agentRuns.clientInstanceId),
        eq(operationRuns.id, agentRuns.parentOperationRunId)
      )
    )
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.parentConversationId, input.conversationId),
        eq(conversations.kind, "run_thread"),
        eq(conversations.status, "active")
      )
    )
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id));
  return rows.flatMap(({ run, title, origin }) => {
    if (run.parentRunId === null || origin.kind !== "agent") return [];
    const endedAt = run.completedAt ?? run.failedAt ?? run.cancelledAt;
    return [
      {
        runId: asAgentRunId(run.id),
        threadId: asConversationId(run.conversationId),
        parentRunId: asAgentRunId(run.parentRunId),
        toolCallId: asToolCallId(origin.toolCallId),
        agentName: run.agentName,
        description: title,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        ...(endedAt ? { endedAt: endedAt.toISOString() } : {})
      }
    ];
  });
}
