import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  type ApprovalRequest,
  type ConversationId
} from "@work-shape/catalyst-core";
import { fixture } from "./support/operation-approval";
import { withTestSql } from "./support/test-sql";

// What is written into a Workflow run whose values are already pruned: a held call that was
// approved before the prune and runs after it, and a request decided after it. The call runs as
// any other; what it answered and what the decider wrote stay out, as the prune removed them.
// Who decided, when and what came of it stay.

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A run thread of an ended Workflow run, and the prune of the run's values. */
async function runThread(f: Fixture) {
  const runId = createPlatformId<"WorkflowRunId">("wfrun");
  const threadId = asConversationId(createPlatformId("conv"));
  await withTestSql(async (sql) => {
    await sql`insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id,
        mode, trigger, status, input, principal_id, principal_name, principal_label, started_by,
        deadline_at, correlation_id, created_at, finished_at)
      values (${runId}, ${f.clientInstanceId}, 'deploys', 'rev_wf', 'live', 'manual', 'done',
        '{}'::jsonb, 'sp_deploys', 'deploys', 'Deploys',
        ${sql.json({ kind: "user", id: "requester", label: "Requester" })},
        now() + interval '1 day', 'corr', now() - interval '40 days',
        now() - interval '40 days')`;
    await sql`insert into conversations (id, client_instance_id, kind, workflow_run_id, visibility,
        title, status, created_at, updated_at, retained_until)
      values (${threadId}, ${f.clientInstanceId}, 'run_thread', ${runId}, 'private', 'Deploy',
        'active', now(), now(), now() + interval '30 days')`;
  });
  return {
    threadId,
    /** The run thread's agent made the call. */
    holds: (operationRunId: string) =>
      withTestSql(
        (sql) =>
          sql`update operation_runs set conversation_id = ${threadId} where id = ${operationRunId}`
      ),
    prune: () =>
      f.app.stores.workflowRuns.markRunDataPruned({
        clientInstanceId: f.clientInstanceId,
        id: runId,
        prunedAt: new Date().toISOString()
      })
  };
}

const rowsOf = (runId: string, requestId: string) =>
  withTestSql(async (sql) => ({
    call: (await sql`select * from operation_runs where id = ${runId}`)[0],
    request: (await sql`select * from approval_requests where id = ${requestId}`)[0]
  }));

describe("a held call of a pruned Workflow run", () => {
  it("approved before the prune runs after it and keeps no answer or comment", async () => {
    const f = await fixture();
    const thread = await runThread(f);
    const anna = await f.hold("anna-deploy", "key-anna");
    await thread.holds(anna.runId);
    // A call of no run, approved and run alike: its answer and comment stay.
    const bert = await f.hold("bert-deploy", "key-bert");
    expect(
      (await f.decide("approver", anna.requestId, "approve", "Anna confirmed by phone")).statusCode
    ).toBe(200);
    expect(
      (await f.decide("approver", bert.requestId, "approve", "Bert confirmed by phone")).statusCode
    ).toBe(200);
    // Queued at prune time: the prune leaves the request its input, to run the call from.
    expect(await thread.prune()).toBe(true);
    expect((await f.stored(anna.requestId)).payload.input).toMatchObject({ name: "anna-deploy" });

    await f.runJobs();

    // Both calls ran, as the person who made them.
    expect(f.executed.sort()).toEqual(["requester:anna-deploy", "requester:bert-deploy"]);
    const left = await rowsOf(anna.runId, anna.requestId);
    expect(left.call).toMatchObject({
      status: "done",
      output: null,
      decision: { mode: "approved", by: expect.any(String), at: expect.any(String) }
    });
    expect(left.call?.decision).not.toHaveProperty("comment");
    expect(left.request).toMatchObject({
      status: "approved",
      decision: { approved: true, decidedBy: expect.any(String) },
      apply_result: { runId: anna.runId, requestId: anna.requestId, execution: "done" },
      payload: { runId: anna.runId, inputRemoved: true }
    });
    expect(left.request?.decision).not.toHaveProperty("comment");
    expect(JSON.stringify(left)).not.toMatch(/Anna|anna-deploy/);

    const kept = await rowsOf(bert.runId, bert.requestId);
    expect(kept.call).toMatchObject({
      status: "done",
      output: { value: { name: "bert-deploy" } },
      decision: { comment: "Bert confirmed by phone" }
    });
    expect(kept.request?.decision).toMatchObject({ comment: "Bert confirmed by phone" });
  });

  it("decided after the prune keeps who decided and how it ended, without comment or answer", async () => {
    const f = await fixture();
    const thread = await runThread(f);
    const carla = await f.hold("carla-deploy", "key-carla");
    const dora = await f.hold("dora-deploy", "key-dora");
    const erik = await f.hold("erik-deploy", "key-erik", "requester", { mode: "not-found" });
    for (const held of [carla, dora, erik]) await thread.holds(held.runId);
    // Still open at prune time: each keeps the input its decision needs.
    expect(await thread.prune()).toBe(true);
    expect((await f.stored(dora.requestId)).payload.input).toMatchObject({ name: "dora-deploy" });

    expect((await f.approve("approver", carla.requestId, "Carla confirmed")).statusCode).toBe(200);
    expect(
      (await f.decide("approver", dora.requestId, "reject", "Dora is on leave")).statusCode
    ).toBe(200);
    expect((await f.approve("approver", erik.requestId, "Erik confirmed")).statusCode).toBe(200);

    expect(f.executed.sort()).toEqual(["requester:carla-deploy", "requester:erik-deploy"]);
    const approved = await rowsOf(carla.runId, carla.requestId);
    expect(approved.call).toMatchObject({ status: "done", output: null });
    expect(approved.request).toMatchObject({
      status: "approved",
      apply_result: { execution: "done" },
      payload: { inputRemoved: true }
    });
    const rejected = await rowsOf(dora.runId, dora.requestId);
    expect(rejected.call?.status).toBe("denied");
    expect(rejected.request).toMatchObject({
      status: "rejected",
      decision: { approved: false, decidedBy: expect.any(String) }
    });
    const failed = await rowsOf(erik.runId, erik.requestId);
    expect(failed.call?.status).toBe("failed");
    // A failure keeps its code, not its message.
    expect(failed.request?.apply_result).toEqual({
      runId: erik.runId,
      requestId: erik.requestId,
      execution: "failed",
      error: { code: "NOT_FOUND" }
    });
    for (const rows of [approved, rejected, failed]) {
      expect(rows.call?.decision ?? {}).not.toHaveProperty("comment");
      expect(rows.request?.decision).not.toHaveProperty("comment");
    }
    // A declined call's denial names who declined it, not what they wrote.
    expect(rejected.call?.error).toMatchObject({ denial: { kind: "declined" } });
    expect(JSON.stringify([approved, rejected, failed])).not.toMatch(
      /Carla|Dora|Erik|carla-deploy|dora-deploy|erik-deploy/
    );
  });

  it("tells its pruned thread nothing of a decision; a thread of a run not pruned is told", async () => {
    const f = await fixture();
    const pruned = await runThread(f);
    const open = await runThread(f);
    expect(await pruned.prune()).toBe(true);
    const decided = (conversationId: ConversationId): ApprovalRequest => ({
      id: createPlatformId("apr"),
      clientInstanceId: f.clientInstanceId,
      kind: "operation_call",
      summary: "deploy",
      checks: [],
      payload: { inputRemoved: true },
      requestedBy: { id: "requester", displayLabel: "Requester" },
      origin: {
        conversationId,
        agentRunId: asAgentRunId("run_agent"),
        toolCallId: asToolCallId("call_1"),
        agentName: "deployer"
      },
      status: "approved",
      decision: {
        approved: true,
        decidedBy: "approver",
        decidedByLabel: "Approver",
        decidedAt: new Date().toISOString(),
        comment: "Fiona confirmed"
      },
      applyResult: { execution: "done" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await f.app.stores.approvals.appendApprovalDecision(decided(pruned.threadId));
    await f.app.stores.approvals.appendApprovalDecision(decided(open.threadId));

    const messages = await withTestSql(
      (sql) => sql`select conversation_id from messages
        where conversation_id in (${pruned.threadId}, ${open.threadId})`
    );
    expect(messages.map((row) => row.conversation_id)).toEqual([open.threadId]);
  });
});
