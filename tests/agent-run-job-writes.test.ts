import { AGENT_RUN_HELD_END_MAX_EVENTS } from "@vivd-catalyst/agent-runtime";
import { ApprovalRequestWorkflow } from "@vivd-catalyst/chat-server";
import {
  JobLeaseLostError,
  StoreBackedAuditRecorder,
  type AgentRunJobLease,
  type ApprovalRequestHandler
} from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import {
  useAgentRunJobFixture,
  type AgentRunJobFixture as Fixture,
  type AgentRunJobRecord
} from "./support/agent-run-job-fixture";
import { required, waitUntil } from "./support/assertions";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// What a run writes at its end and beside its events: the answer with the event that ends
// the run, and the writes a tool or the runtime makes for the run under the lease of its job.
describe("the writes of an agent run under the lease of its job", () => {
  const db = usePostgresSuite("agent_run_job_writes");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);

  it("stores the answer of a run and the end of the run together", async () => {
    const fixture = await createFixture("end_together");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.delta("Done.");
    await waitUntil(async () => (await fixture.events(run)).length === 1, "the piece is stored");
    const message = await execution.finalMessage("Done.");

    // The answer is written and the run has not ended: nothing of the answer is stored yet.
    expect(await assistantTexts(fixture)).toEqual([]);
    expect(await fixture.run(run)).toMatchObject({ status: "running", lastSequence: 1 });

    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({ status: "completed", lastSequence: 3 });
    expect(await fixture.eventTypes(run)).toEqual([
      "message_delta",
      "message_completed",
      "run_completed"
    ]);
    const stored = (await fixture.messages()).filter((entry) => entry.role === "assistant");
    expect(stored).toMatchObject([{ id: message.id, text: "Done." }]);
  });

  it("holds the answer back through events that are consumed after it, until the run ends", async () => {
    const fixture = await createFixture("end_interleaved");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("Done.");
    // The run produced faster than it was stored: the worker takes this event after the
    // answer, and cannot tell that it is older.
    execution.reasoning("Thinking.");
    await execution.consumed();

    expect(await assistantTexts(fixture)).toEqual([]);
    expect(await fixture.eventTypes(run)).toEqual([]);

    // The worker is killed here: the run fails and no answer stands beside it.
    await fixture.expireJobLeases();
    await fixture.worker({ stores: db.secondStore }).runDue();
    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({ status: "failed" });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
    expect(await assistantTexts(fixture)).toEqual([]);
  });

  it("stores the answer, the events consumed after it and the end of the run together", async () => {
    const fixture = await createFixture("end_interleaved_stored");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("Done.");
    execution.reasoning("Thinking.");
    await execution.consumed();
    expect(await fixture.eventTypes(run)).toEqual([]);
    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({ status: "completed", lastSequence: 3 });
    expect(await fixture.eventTypes(run)).toEqual([
      "message_completed",
      "reasoning_delta",
      "run_completed"
    ]);
    expect(await assistantTexts(fixture)).toEqual(["Done."]);
  });

  it("stores a held answer at once when more events are held behind it than the limit", async () => {
    const fixture = await createFixture("end_over_limit");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("Done.");
    // The event of the answer is held too, so this many more reach the limit and not above.
    for (let held = 1; held < AGENT_RUN_HELD_END_MAX_EVENTS; held += 1) execution.reasoning(".");
    await execution.consumed();
    expect(await assistantTexts(fixture)).toEqual([]);

    execution.reasoning("One too many.");
    await execution.consumed();
    expect(await assistantTexts(fixture)).toEqual(["Done."]);
    expect(await fixture.run(run)).toMatchObject({
      status: "running",
      lastSequence: AGENT_RUN_HELD_END_MAX_EVENTS + 1
    });

    execution.complete();
    await pass;
    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
  });

  it("leaves no answer beside a failed run when the worker is lost at the end of the run", async () => {
    const fixture = await createFixture("end_lost");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const worker = fixture.worker();
    const pass = worker.runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("Done.");
    // The worker is gone for the lease time between its answer and the end of its run.
    await fixture.expireJobLeases();
    await fixture.worker({ stores: db.secondStore }).runDue();

    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_WORKER_LOST" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
    expect(await assistantTexts(fixture)).toEqual([]);
  });

  it("stores the answer with a run that ends as cancelled at its completion", async () => {
    const fixture = await createFixture("end_cancelled");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("Done.");
    await db.store.agentRuns.requestAgentRunCancellation({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      requestedAt: new Date().toISOString(),
      reason: "Stop at the end"
    });
    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({ status: "cancelled", lastSequence: 2 });
    expect(await fixture.eventTypes(run)).toEqual(["message_completed", "run_cancelled"]);
    expect(await assistantTexts(fixture)).toEqual(["Done."]);
  });

  it("stores a held answer when the run goes on, and with the failure of a run that ends without its last event", async () => {
    const fixture = await createFixture("end_flushed");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await execution.finalMessage("First.");
    // The run goes on after what looked like its answer.
    await execution.assistantMessage("Second.");
    expect(await assistantTexts(fixture)).toEqual(["First.", "Second."]);
    await execution.finalMessage("Third.");
    execution.end();
    await pass;

    expect(await assistantTexts(fixture)).toEqual(["First.", "Second.", "Third."]);
    expect(await fixture.eventTypes(run)).toEqual([
      "message_completed",
      "message_completed",
      "run_failed"
    ]);
    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_EXECUTOR_ENDED" }
    });
  });

  it("refuses what a run writes beside its events once it lost its lease", async () => {
    const fixture = await createFixture("side_writes");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    const { clientInstanceId, conversation } = fixture;
    const handler: ApprovalRequestHandler = {
      kind: "note",
      requiredPermission: "agent_skills.approve",
      validate: (payload) => payload,
      preview: async () => ({}),
      isStale: async () => false,
      apply: async () => ({})
    };
    const approvals = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: db.store.approvals,
      handlers: new Map([[handler.kind, handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: db.store.audit })
    });
    // A tool of the run proposes a change with the context the run gave it.
    const propose = (summary: string) =>
      approvals.createRequest(execution.context.user, execution.context, {
        kind: handler.kind,
        summary,
        payload: {}
      });
    const continuation = { clientInstanceId, conversationId: conversation.id, providerId: "p" };
    const dropContinuation = () =>
      db.store.conversations.deleteModelProviderContinuation({
        ...continuation,
        runFence: execution.context.runFence
      });
    const requests = async () => {
      const listed = await db.store.approvals.listApprovalRequests({
        clientInstanceId,
        kinds: [handler.kind]
      });
      return listed.map((request) => request.summary);
    };
    await execution.control.conversationHistory.appendAssistantMessage({
      ...continuation,
      text: "Compacted.",
      providerContinuation: { providerId: "p", state: { cursor: 1 } }
    });

    expect(execution.context.runFence).toEqual({
      runId: run.id,
      lease: leaseOf(required((await fixture.jobs())[0]))
    });
    await propose("While the run holds its lease");
    expect(await requests()).toEqual(["While the run holds its lease"]);

    await fixture.expireJobLeases();
    await expect(propose("After the lease was lost")).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(dropContinuation()).rejects.toBeInstanceOf(JobLeaseLostError);

    expect(await requests()).toEqual(["While the run holds its lease"]);
    expect(await db.store.conversations.getModelProviderContinuation(continuation)).toMatchObject({
      state: { cursor: 1 }
    });
    const created = await db.sql<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where client_instance_id = ${clientInstanceId} and type = 'approval_request.created'`;
    expect(created).toEqual([{ count: 1 }]);

    execution.end();
    await pass;
  });
});

function leaseOf(job: AgentRunJobRecord): AgentRunJobLease {
  return { jobId: job.id, leaseToken: required(job.lease_token) };
}

async function assistantTexts(fixture: Fixture): Promise<string[]> {
  const messages = await fixture.messages();
  return messages.filter((message) => message.role === "assistant").map((message) => message.text);
}
