import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createLocalAgentRunExecutor } from "@vivd-catalyst/agent-runtime";
import {
  AGENT_RUN_LEASE_MS,
  AGENT_RUN_MAX_QUEUED_MS,
  asClientInstanceId,
  asToolCallId,
  type AgentRunAuthorization,
  type AgentRunJobLease,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { afterEach, describe, expect, it } from "vitest";
import {
  useAgentRunJobFixture,
  type AgentRunJobFixture as Fixture,
  type AgentRunJobRecord
} from "./support/agent-run-job-fixture";
import { required, waitUntil } from "./support/assertions";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { withTestModelGateway } from "./support/model-gateway";
import { usePostgresSuite } from "./support/postgres-suite";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";

describe("agent runs as claimed jobs", () => {
  const db = usePostgresSuite("agent_run_jobs");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);
  const processes: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of processes.splice(0)) await kill(child);
  });

  it("executes a run once when two workers compete for it", async () => {
    const fixture = await createFixture("once");
    const run = await fixture.accept();
    expect(await fixture.jobs()).toMatchObject([{ subject: run.id, status: "queued" }]);

    const passes = Promise.all([
      fixture.worker().runDue(),
      fixture.worker({ stores: db.secondStore }).runDue()
    ]);
    const execution = await fixture.executor.next();
    execution.delta("Done.");
    await execution.assistantMessage("Done.");
    execution.complete();
    await passes;
    // A later pass finds nothing left to do.
    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.run(run)).toMatchObject({ status: "completed", lastSequence: 2 });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_completed"]);
    expect(await assistantTexts(fixture)).toEqual(["Done."]);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("refuses the next append of a worker whose lease was stolen and stores nothing of it", async () => {
    const fixture = await createFixture("stolen");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.delta("Before the steal.");
    await waitUntil(
      async () => (await fixture.events(run)).length === 1,
      "the first piece is stored"
    );
    const stolen = leaseOf(required((await fixture.jobs())[0]));

    // The steal: the lease ran out unrenewed and another worker took the job. It has used its
    // one attempt, so that worker ends the run and executes nothing.
    await fixture.expireJobLeases();
    await fixture.worker({ stores: db.secondStore }).runDue();
    const afterSteal = await fixture.events(run);
    expect(afterSteal.map((event) => event.type)).toEqual(["message_delta", "run_failed"]);
    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_WORKER_LOST", category: "runtime_interrupted" }
    });

    // The old worker goes on: its next piece, its message and its end are all refused.
    execution.delta("After the steal.");
    await pass;
    await expect(execution.assistantMessage("After the steal.")).rejects.toMatchObject({
      code: "CONFLICT"
    });
    await expect(execution.control.assertLease()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.store.agentRuns.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: run.id,
        lease: stolen,
        event: {
          type: "run_completed",
          runId: run.id,
          sequence: 3,
          createdAt: new Date().toISOString()
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await fixture.events(run)).toEqual(afterSteal);
    expect(await assistantTexts(fixture)).toEqual([]);
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.jobs()).toMatchObject([{ status: "dead", attempts: 1 }]);
  });

  it("refuses every write under a lease token that is not the job's", async () => {
    const fixture = await createFixture("token");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    const held = leaseOf(required((await fixture.jobs())[0]));
    const append = (lease: AgentRunJobLease) =>
      db.store.agentRuns.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: run.id,
        lease,
        event: {
          type: "message_delta",
          runId: run.id,
          sequence: 1,
          createdAt: new Date().toISOString(),
          delta: "Not this worker's."
        }
      });

    await expect(append({ ...held, leaseToken: "another-token" })).rejects.toMatchObject({
      code: "CONFLICT"
    });
    // A lease that ran out is lost even before anyone took the job.
    const [{ lease_expires_at: expiry }] = await db.sql<[{ lease_expires_at: Date }]>`
      select lease_expires_at from platform_jobs where id = ${held.jobId}`;
    await db.sql`
      update platform_jobs set lease_expires_at = now() - interval '1 second'
      where id = ${held.jobId}`;
    await expect(append(held)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.events(run)).toEqual([]);

    await db.sql`update platform_jobs set lease_expires_at = ${expiry} where id = ${held.jobId}`;
    execution.complete();
    await pass;
    expect(await fixture.eventTypes(run)).toEqual(["run_completed"]);
  });

  it("fails the run of a killed worker as lost after the lease time, and the conversation takes the next message", async () => {
    const fixture = await createFixture("killed");
    const run = await fixture.accept();
    const child = startWorkerProcess(fixture);
    await waitUntil(
      async () => (await fixture.events(run)).length === 1,
      "the worker process stored a piece of the reply",
      60_000
    );
    await kill(child);

    // Until the lease time is over nobody can tell the worker is gone: the run stays in
    // progress and its conversation takes no message.
    const survivor = fixture.worker();
    await survivor.runDue();
    expect(await fixture.run(run)).toMatchObject({ status: "running" });
    await expect(fixture.accept("And now?")).rejects.toMatchObject({ code: "CONFLICT" });
    const [{ remaining }] = await db.sql<[{ remaining: number }]>`
      select extract(epoch from lease_expires_at - now())::float8 * 1000 as remaining
      from platform_jobs where subject = ${run.id}`;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(AGENT_RUN_LEASE_MS);

    await fixture.expireJobLeases();
    await survivor.runDue();

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      lastSequence: 2,
      error: { code: "AGENT_RUN_WORKER_LOST", category: "runtime_interrupted" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_failed"]);
    expect(await fixture.jobs()).toMatchObject([{ status: "dead", attempts: 1 }]);
    const audit = await db.sql<{ subject: string }[]>`
      select subject from audit_events
      where client_instance_id = ${fixture.clientInstanceId} and type = 'agent_run.recovered'`;
    expect(audit).toEqual([{ subject: run.id }]);
    // The lost run is never executed again.
    await survivor.runDue();
    expect(fixture.executor.calls).toHaveLength(0);

    const next = await fixture.accept("And now?");
    const pass = survivor.runDue();
    (await fixture.executor.next()).complete();
    await pass;
    expect(await fixture.run(next)).toMatchObject({ status: "completed" });
    expect(fixture.executor.calls).toHaveLength(1);
  });

  it("brings a cancellation to a worker in another process within two seconds", async () => {
    const fixture = await createFixture("cancel");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.delta("So far.");
    await waitUntil(
      async () => (await fixture.events(run)).length === 1,
      "the first piece is stored"
    );

    // The API of another process asks: all the worker has is the row.
    const requestedAt = Date.now();
    const requested = await db.secondStore.agentRuns.requestAgentRunCancellation({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      requestedAt: new Date().toISOString(),
      reason: "Stop"
    });
    expect(requested).toMatchObject({ status: "cancelling" });
    await expect(execution.cancelRequested.promise).resolves.toBe("Stop");
    expect(Date.now() - requestedAt).toBeLessThan(2000);
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Stop"
    });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_cancelled"]);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("ends a queued run that was cancelled without executing it", async () => {
    const fixture = await createFixture("cancel_queued");
    const run = await fixture.accept();
    await db.store.agentRuns.requestAgentRunCancellation({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      requestedAt: new Date().toISOString(),
      reason: "No longer needed"
    });

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.run(run)).toMatchObject({ status: "cancelled", lastSequence: 1 });
    expect(await fixture.eventTypes(run)).toEqual(["run_cancelled"]);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("ends a run as cancelled when the request races with its completion", async () => {
    const fixture = await createFixture("cancel_race");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    await db.store.agentRuns.requestAgentRunCancellation({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      requestedAt: new Date().toISOString(),
      reason: "Stop during completion"
    });
    // The execution ends before the worker has looked at the row again.
    execution.complete();
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Stop during completion"
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_cancelled"]);
  });

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

  it("stores a held answer when the run goes on or ends without its last event", async () => {
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

  it("ends a run as interrupted when its worker stops, and no worker executes it again", async () => {
    const fixture = await createFixture("stop");
    const run = await fixture.accept();
    const worker = fixture.worker();
    worker.start();
    await fixture.executor.next();

    await worker.stop();

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED", category: "runtime_interrupted" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
    await fixture.worker({ stores: db.secondStore }).runDue();
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("lets a run finish when its worker stops with time to drain", async () => {
    const fixture = await createFixture("drain");
    const run = await fixture.accept();
    const worker = fixture.worker();
    worker.start();
    const execution = await fixture.executor.next();

    const stopped = worker.stop({ drainMs: 60_000 });
    execution.delta("Still writing.");
    await waitUntil(async () => (await fixture.events(run)).length === 1, "the run goes on");
    execution.complete();
    await stopped;

    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_completed"]);
  });

  it("interrupts a run that is still going when the drain time is over", async () => {
    const fixture = await createFixture("drain_over");
    const run = await fixture.accept();
    const worker = fixture.worker();
    worker.start();
    await fixture.executor.next();

    await worker.stop({ drainMs: 20 });

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
  });

  it("ends the drain at once when the worker is told to stop a second time", async () => {
    const fixture = await createFixture("drain_cut");
    const run = await fixture.accept();
    const worker = fixture.worker();
    worker.start();
    await fixture.executor.next();

    const draining = worker.stop({ drainMs: 10 * 60_000 });
    await worker.stop();
    await draining;

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED" }
    });
  });

  it("executes with the stored model binding, locale and authorization of the run", async () => {
    const authorization: AgentRunAuthorization = {
      principal: {
        kind: "service",
        id: "service-1",
        displayLabel: "Automation",
        clientInstanceId: asClientInstanceId("replaced-below"),
        authSource: "api-key"
      },
      subjectUserId: "replaced-below",
      delegatedActor: {
        kind: "service_principal",
        id: "service-1",
        displayLabel: "Automation",
        authSource: "api-key"
      },
      scopes: ["conversation:read"]
    };
    const fixture = await createFixture("dispatch", {
      authorization: (clientInstanceId, userId) => ({
        ...authorization,
        principal: { ...authorization.principal, clientInstanceId },
        subjectUserId: userId
      })
    });
    // The person holds every scope today; the run keeps the ones it was started with.
    fixture.user.scopes = ["*"];
    const run = await fixture.accept("Do it", { modelBindingId: "binding-fast", locale: "de" });
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.complete();
    await pass;

    expect(execution.input).toMatchObject({
      modelBindingId: "binding-fast",
      inputMessageId: run.inputMessageId,
      message: { text: "Do it" }
    });
    const context: RuntimeCallContext = execution.context;
    expect(context).toMatchObject({
      locale: "de",
      subjectUserId: fixture.user.id,
      scopes: ["conversation:read"],
      principal: { kind: "service", id: "service-1" },
      delegatedActor: { id: "service-1" },
      user: {
        scopes: ["conversation:read"],
        principal: { kind: "service", id: "service-1" },
        delegatedActor: { id: "service-1" }
      }
    });
  });

  it("fails a run without stored authorization and executes nothing", async () => {
    const fixture = await createFixture("no_authorization", { authorization: null });
    const run = await fixture.accept();

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN", category: "app_error" }
    });
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("fails a run that asks for a permission, which a worker cannot resume", async () => {
    const fixture = await createFixture("permission");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.emit((base) => ({
      type: "tool_permission_requested",
      ...base,
      toolCallId: asToolCallId("toolcall-1"),
      toolName: "dangerous-tool",
      reason: "Approval required"
    }));
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_PERMISSION_UNSUPPORTED" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
  });

  it("fails a run whose execution ends without ending the run", async () => {
    const fixture = await createFixture("ended");
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    (await fixture.executor.next()).end();
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_EXECUTOR_ENDED" }
    });
  });

  it("gives a job to a run in progress that has none, once", async () => {
    const fixture = await createFixture("adopt");
    const run = await fixture.acceptAsPreviousRelease();
    expect(await fixture.jobs()).toEqual([]);
    const worker = fixture.worker({ schedules: true });

    await worker.runDue();
    expect(await fixture.jobs()).toMatchObject([{ subject: run.id, status: "queued" }]);
    // A run with a live job is left alone by the next tick.
    await fixture.makeAdoptionDue();
    const pass = worker.runDue();
    (await fixture.executor.next()).complete();
    await pass;
    // And so is a run that ended.
    await fixture.makeAdoptionDue();
    await worker.runDue();

    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
  });

  it("fails the run of a killed worker when no worker is left, by the job worker of the API", async () => {
    const fixture = await createFixture("killed_no_worker");
    const run = await fixture.accept();
    const child = startWorkerProcess(fixture);
    await waitUntil(
      async () => (await fixture.events(run)).length === 1,
      "the worker process stored a piece of the reply",
      60_000
    );
    await kill(child);
    // No worker comes back. The only job worker left is the one of a process that executes
    // no runs.
    const api = fixture.upkeepWorker();
    await api.runDue();
    expect(await fixture.run(run)).toMatchObject({ status: "running" });

    await fixture.expireJobLeases();
    await api.runDue();

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_WORKER_LOST", category: "runtime_interrupted" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_failed"]);
    expect(await fixture.jobs()).toMatchObject([{ status: "dead", attempts: 1 }]);
    // The conversation takes the next message. Its run waits for a worker: this one claims
    // no run.
    const next = await fixture.accept("And now?");
    await api.runDue();
    expect(await fixture.run(next)).toMatchObject({ status: "queued" });
    expect(await fixture.jobs()).toMatchObject([
      { status: "dead" },
      { subject: next.id, status: "queued", attempts: 0 }
    ]);
  });

  it("fails a run that no worker took within the queue limit, and never executes it", async () => {
    const fixture = await createFixture("queued_too_long");
    const run = await fixture.accept();
    const api = fixture.upkeepWorker();
    const upkeep = async () => {
      await fixture.makeAdoptionDue();
      await api.runDue();
    };

    await fixture.acceptedAgo(run, AGENT_RUN_MAX_QUEUED_MS - 60_000);
    await upkeep();
    expect(await fixture.run(run)).toMatchObject({ status: "queued" });

    await fixture.acceptedAgo(run, AGENT_RUN_MAX_QUEUED_MS + 1000);
    await upkeep();

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      lastSequence: 1,
      error: { code: "AGENT_RUN_NOT_STARTED", category: "runtime_interrupted" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);
    const audit = await db.sql<{ subject: string }[]>`
      select subject from audit_events
      where client_instance_id = ${fixture.clientInstanceId} and type = 'agent_run.recovered'`;
    expect(audit).toEqual([{ subject: run.id }]);
    // A second tick fails nothing twice.
    await upkeep();
    expect(await fixture.eventTypes(run)).toEqual(["run_failed"]);

    // The conversation takes the next message, and a worker that comes up executes only that.
    const next = await fixture.accept("And now?");
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    expect(execution.input.preparedRun?.id).toBe(next.id);
    execution.complete();
    await pass;
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.jobs()).toMatchObject([
      { subject: run.id, status: "succeeded", attempts: 1 },
      { subject: next.id, status: "succeeded", attempts: 1 }
    ]);
  });

  it("runs the local runtime with the job as the only writer of the run", async () => {
    const fixture = await createFixture("local_runtime");
    const provider: ModelProviderConfig = {
      id: "worker-provider",
      type: "deterministic",
      model: "worker-model"
    };
    const execute = createLocalAgentRunExecutor(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          defaultAgentName: "test_agent",
          agents: [
            {
              name: "test_agent",
              displayName: "Test agent",
              instructions: "Answer briefly.",
              modelProviderId: provider.id,
              toolNames: [],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        modelProvider: {
          id: provider.id,
          async complete() {
            return {
              text: "Done.",
              toolCalls: [],
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                source: "not_reported",
                webSearchCallCount: 0
              }
            };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [] }),
        toolExecution: {
          async authorize() {
            throw new Error("No tools expected");
          },
          async execute() {
            throw new Error("No tools expected");
          }
        },
        usageGovernance: new ModelUsageGovernance({
          store: db.store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const run = await fixture.accept();

    await fixture.worker({ execute }).runDue();

    expect(await fixture.run(run)).toMatchObject({ status: "completed", lastSequence: 3 });
    expect(await fixture.eventTypes(run)).toEqual([
      "message_delta",
      "message_completed",
      "run_completed"
    ]);
    expect(await assistantTexts(fixture)).toEqual(["Done."]);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  /** An Agent Run worker in a process of its own, which the test can kill. */
  function startWorkerProcess(fixture: Fixture): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        fileURLToPath(new URL("./support/agent-run-worker-process.ts", import.meta.url))
      ],
      {
        // The TypeScript loader is a development dependency of this package, and Node
        // resolves `--import` from the working directory. The loader reads the package paths
        // of the tests from their TypeScript project.
        cwd: fileURLToPath(new URL("../packages/api-contract/", import.meta.url)),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.tests.json", import.meta.url)),
          AGENT_RUN_TEST_DATABASE_URL: db.databaseUrl,
          AGENT_RUN_TEST_CLIENT_INSTANCE_ID: fixture.clientInstanceId
        },
        stdio: ["pipe", "ignore", "inherit"]
      }
    );
    processes.push(child);
    return child;
  }
});

/** Ends the process as a crash or the kernel does: at once, with no chance to clean up. */
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

function leaseOf(job: AgentRunJobRecord): AgentRunJobLease {
  return { jobId: job.id, leaseToken: required(job.lease_token) };
}

async function assistantTexts(fixture: Fixture): Promise<string[]> {
  const messages = await fixture.messages();
  return messages.filter((message) => message.role === "assistant").map((message) => message.text);
}
