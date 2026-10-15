import { AGENT_RUN_IDLE_LIMIT_MS } from "@work-shape/catalyst-agent-runtime";
import { asToolCallId, type AgentRun } from "@work-shape/catalyst-core";
import { createWorkspaceCommandClient } from "@work-shape/catalyst-tool-execution";
import { describe, expect, it, vi } from "vitest";
import {
  useAgentRunJobFixture,
  type AgentRunJobFixture as Fixture
} from "./support/agent-run-job-fixture";
import { deferred, required } from "./support/assertions";
import {
  advanceFakeClockUntilSettled,
  settleOnFakeClock,
  useFakeClockBesidePostgres
} from "./support/fake-clock";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// A run that stands still is ended after the idle limit. Its failure says what it waited on,
// and what it queued and nobody claimed does not outlive it.

describe("an agent run that stores no event for the idle limit", () => {
  const db = usePostgresSuite("agent_run_idle");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);

  /** A command of the run that waits in the queue, as `workspace.exec` leaves it. */
  async function queueCommand(fixture: Fixture, run: Pick<AgentRun, "id">) {
    const workspace = await db.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      ownerUserId: fixture.user.id
    });
    const { command } = await createWorkspaceCommandClient({
      stores: db.store,
      now: () => new Date().toISOString()
    }).enqueue(
      { kind: "execution_workspace", id: workspace.id },
      {
        clientInstanceId: fixture.clientInstanceId,
        ownerUserId: fixture.user.id,
        agentRunId: run.id,
        command: "cat secret-figures.csv",
        limits: { timeoutSeconds: 60, idleTimeoutSeconds: 60 }
      }
    );
    return command;
  }

  const commandOf = async (command: { id: string }) => {
    const [row] = await db.sql<{ status: string }[]>`
      select status from workspace_commands where id = ${command.id}`;
    return required(row);
  };

  const commandJobs = (fixture: Fixture) => db.sql<
    { status: string; attempts: number; error_code: string | null }[]
  >`
    select status, attempts, error_code from platform_jobs
    where client_instance_id = ${fixture.clientInstanceId} and kind = 'workspace.command'`;

  /** Starts the run, lets `during` emit what it emits, and moves the clock until the run ends. */
  async function standStill(
    fixture: Fixture,
    run: Pick<AgentRun, "id">,
    during: (execution: Awaited<ReturnType<Fixture["executor"]["next"]>>) => void
  ): Promise<number> {
    useFakeClockBesidePostgres();
    try {
      const pass = fixture.worker().runDue();
      const execution = await settleOnFakeClock(fixture.executor.next());
      during(execution);
      await settleOnFakeClock(execution.consumed());
      const stoodStillAt = Date.now();
      // In one move to 1.7 seconds before the limit, then in steps short enough for the
      // driver, whose connection attempts end on this clock too.
      await vi.advanceTimersByTimeAsync(AGENT_RUN_IDLE_LIMIT_MS - 1_700);
      expect(await settleOnFakeClock(fixture.run(run))).toMatchObject({ status: "running" });
      await advanceFakeClockUntilSettled(pass, 250);
      return Date.now() - stoodStillAt;
    } finally {
      vi.useRealTimers();
    }
  }

  it("names the tool it waited on and that no worker took the command, and withdraws the command", async () => {
    const fixture = await createFixture("command_not_taken");
    const run = await fixture.accept();
    const command = await queueCommand(fixture, run);

    const waited = await standStill(fixture, run, (execution) =>
      execution.emit((base) => ({
        type: "tool_call_started",
        ...base,
        toolCallId: asToolCallId("toolcall_exec"),
        toolName: "workspace.exec",
        input: { command: "cat secret-figures.csv" }
      }))
    );

    expect(waited).toBeGreaterThanOrEqual(AGENT_RUN_IDLE_LIMIT_MS);
    const failed = await fixture.run(run);
    expect(failed).toMatchObject({ status: "failed" });
    // The tool and the cause, and nothing of what the tool was given.
    expect(failed.error).toEqual({
      code: "AGENT_RUN_COMMAND_NOT_TAKEN",
      category: "runtime_interrupted",
      tool: "workspace.exec",
      message:
        "Agent run stored no event within the idle limit while it waited for the tool workspace.exec: no worker took the command"
    });
    expect(required((await fixture.events(run)).at(-1))).toMatchObject({
      type: "run_failed",
      error: { code: "AGENT_RUN_COMMAND_NOT_TAKEN", tool: "workspace.exec" }
    });
    expect(await commandOf(command)).toMatchObject({ status: "cancelled" });
    expect(await commandJobs(fixture)).toEqual([
      { status: "cancelled", attempts: 0, error_code: "WITHDRAWN" }
    ]);
  });

  it("names the tool that is still open, not one that answered", async () => {
    const fixture = await createFixture("tool_silent");
    const run = await fixture.accept();

    await standStill(fixture, run, (execution) => {
      execution.emit((base) => ({
        type: "tool_call_started",
        ...base,
        toolCallId: asToolCallId("toolcall_search"),
        toolName: "knowledge.search",
        input: {}
      }));
      execution.emit((base) => ({
        type: "tool_call_failed",
        ...base,
        toolCallId: asToolCallId("toolcall_search"),
        toolName: "knowledge.search",
        result: {
          status: "failed",
          error: { code: "validation_failed", message: "No such collection" }
        },
        modelOutput: "No such collection"
      }));
      execution.emit((base) => ({
        type: "tool_call_started",
        ...base,
        toolCallId: asToolCallId("toolcall_fetch"),
        toolName: "web.fetch",
        input: {}
      }));
    });

    expect((await fixture.run(run)).error).toEqual({
      code: "AGENT_RUN_TOOL_SILENT",
      category: "runtime_interrupted",
      tool: "web.fetch",
      message:
        "Agent run stored no event within the idle limit while it waited for the tool web.fetch"
    });
  });

  it("does not stop a run that stores an event while the watchdog reads the queue", async () => {
    const fixture = await createFixture("resumed");
    const run = await fixture.accept();
    const reading = deferred<void>();
    const read = deferred<boolean>();
    const stores = {
      ...db.store,
      executionWorkspaces: {
        ...db.store.executionWorkspaces,
        hasUnclaimedWorkspaceCommand() {
          reading.resolve();
          return read.promise;
        }
      }
    };
    useFakeClockBesidePostgres();
    try {
      const pass = fixture.worker({ stores }).runDue();
      const execution = await settleOnFakeClock(fixture.executor.next());
      const toolCallId = asToolCallId("toolcall_slow");
      execution.emit((base) => ({
        type: "tool_call_started",
        ...base,
        toolCallId,
        toolName: "web.fetch",
        input: {}
      }));
      await settleOnFakeClock(execution.consumed());
      await vi.advanceTimersByTimeAsync(AGENT_RUN_IDLE_LIMIT_MS - 1_700);
      await advanceFakeClockUntilSettled(reading.promise, 250);

      // The tool answers and the reply goes on, 1.3 seconds into the watchdog's read.
      await vi.advanceTimersByTimeAsync(1_300);
      execution.emit((base) => ({
        type: "tool_call_completed",
        ...base,
        toolCallId,
        toolName: "web.fetch",
        result: { status: "success", output: {} },
        modelOutput: "{}"
      }));
      execution.delta("Here it is.");
      await settleOnFakeClock(execution.consumed());
      read.resolve(false);
      await vi.advanceTimersByTimeAsync(2_300);

      expect(await settleOnFakeClock(fixture.run(run))).toMatchObject({ status: "running" });
      await settleOnFakeClock(execution.assistantMessage("Here it is."));
      execution.complete();
      await advanceFakeClockUntilSettled(pass, 250);
    } finally {
      vi.useRealTimers();
    }

    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
  });

  it("names no tool when none was open", async () => {
    const fixture = await createFixture("model_silent");
    const run = await fixture.accept();

    await standStill(fixture, run, (execution) => execution.reasoning("Thinking."));

    expect((await fixture.run(run)).error).toEqual({
      code: "AGENT_RUN_IDLE",
      category: "runtime_interrupted",
      message: "Agent run stored no event within the idle limit"
    });
  });
});

describe("a run that ends while a command of it waits for a worker", () => {
  const db = usePostgresSuite("agent_run_end_withdraws");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);

  it("withdraws the command and its job when the worker of the run is lost", async () => {
    const fixture = await createFixture("lost");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    const workspace = await db.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      ownerUserId: fixture.user.id
    });
    const { command } = await createWorkspaceCommandClient({
      stores: db.store,
      now: () => new Date().toISOString()
    }).enqueue(
      { kind: "execution_workspace", id: workspace.id },
      {
        clientInstanceId: fixture.clientInstanceId,
        ownerUserId: fixture.user.id,
        agentRunId: run.id,
        command: "ls",
        limits: { timeoutSeconds: 60, idleTimeoutSeconds: 60 }
      }
    );

    await fixture.expireJobLeases();
    await fixture.worker({ stores: db.secondStore }).runDue();
    execution.end();
    await pass;

    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_WORKER_LOST" }
    });
    expect(
      await db.store.executionWorkspaces.getWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id
      })
    ).toMatchObject({
      status: "cancelled",
      cancellationReason:
        "Workspace command was withdrawn: its agent run ended before a worker took it"
    });
    expect(
      await db.sql`
        select status, attempts, error_code from platform_jobs
        where client_instance_id = ${fixture.clientInstanceId} and kind = 'workspace.command'`
    ).toEqual([{ status: "cancelled", attempts: 0, error_code: "WITHDRAWN" }]);
  });
});
