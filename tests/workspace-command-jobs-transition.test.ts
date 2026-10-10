import type { WorkspaceCommand } from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import {
  successResult,
  useWorkspaceCommandJobFixture,
  type WorkspaceCommandJobFixture as Fixture
} from "./support/workspace-command-job-fixture";

// The transition release: this release's API and command worker run beside the previous
// release's, whose claim and recovery are replayed here as that release ran them.
describe("workspace command jobs beside an API and a worker of the previous release", () => {
  const db = usePostgresSuite("command_jobs_transition");
  const harness = useJobExecutorHarness(db);
  const { createFixture, commandJobs } = useWorkspaceCommandJobFixture(db, harness);

  it("gives a job to a command the previous release queued without one, once", async () => {
    const fixture = await createFixture("adopt");
    // The previous release's API writes the row and knows nothing of jobs.
    const queued = await db.store.executionWorkspaces.enqueueWorkspaceCommand(
      fixture.request("printf adopted")
    );
    const worker = fixture.worker({}, { schedules: true });

    await worker.runDue();
    expect(await commandJobs(fixture)).toMatchObject([
      { subject: queued.id, status: "queued", concurrency_key: fixture.workspace.id }
    ]);
    // A command with a live job is left alone by the next tick.
    await makeAdoptionDue(fixture);
    const run = worker.runDue();
    (await fixture.executor.next()).complete(successResult({ stdoutPreview: "adopted" }));
    await run;
    // And so is a finished one.
    await makeAdoptionDue(fixture);
    await worker.runDue();

    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.command(queued)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("leaves a command to the previous release's worker that claimed it first", async () => {
    const fixture = await createFixture("yield");
    // Queued by this release, with its job, and claimed by the old worker's queue query.
    const queued = await fixture.enqueue("printf legacy");
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBe(queued.id);

    const run = fixture.worker({ yieldCheckIntervalMs: 5 }).runDue();
    await waitUntil(
      async () => (await commandJobs(fixture))[0]?.status === "running",
      "the job waits on the command"
    );
    await db.store.executionWorkspaces.completeWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      commandId: queued.id,
      leaseToken: "legacy-lease",
      output: { ...commandOutput(), stdoutPreview: "legacy" },
      completedAt: new Date().toISOString()
    });
    await run;

    // One result, the previous release's. The job ends without having started a process.
    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.command(queued)).toMatchObject({
      status: "completed",
      attempts: 1,
      output: { stdoutPreview: "legacy" }
    });
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("fails a command whose previous-release worker was killed, without running it again", async () => {
    const fixture = await createFixture("legacy_killed");
    const queued = await fixture.enqueue("printf half");
    await legacyClaim(fixture, "legacy-lease");
    await db.sql`
        update workspace_commands set lease_expires_at = now() - interval '1 second'
        where id = ${queued.id}`;

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: { category: "worker_lost" }
    });
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("keeps the previous release's worker off a command the job holds, and a rollback ends it once", async () => {
    const fixture = await createFixture("rollback");
    harness.heartbeatsByHand();
    const queued = await fixture.enqueue("printf held");
    const run = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    // The mirror makes the command look held to the previous release: neither its claim nor
    // its stale-lease recovery touches it.
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBeUndefined();
    await expect(legacyRecoverStale(fixture)).resolves.toEqual([]);

    // The rollback: this release's worker is gone mid-command and only the previous release
    // runs. Once the mirrored lease has run out, its recovery fails the command.
    await db.sql`
        update workspace_commands set lease_expires_at = now() - interval '1 second'
        where id = ${queued.id}`;
    await expect(legacyRecoverStale(fixture)).resolves.toEqual([queued.id]);

    // What the lost worker reports afterwards changes nothing.
    execution.complete(successResult({ stdoutPreview: "too late" }));
    await run;
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "WORKSPACE_COMMAND_STALE" }
    });
  });

  async function makeAdoptionDue(fixture: Pick<Fixture, "clientInstanceId">): Promise<void> {
    await db.sql`
      update platform_jobs set run_after = now()
      where client_instance_id = ${fixture.clientInstanceId}
        and kind = 'workspace_command.adopt_legacy' and status = 'queued'`;
  }

  /**
   * The claim of the previous release's command worker, as that release ran it: the oldest
   * queued command of an active workspace, whatever job stands beside it.
   */
  async function legacyClaim(
    fixture: Pick<Fixture, "clientInstanceId">,
    leaseToken: string
  ): Promise<string | undefined> {
    const rows = await db.sql<{ id: string }[]>`
      with candidate as (
        select wc.id
        from workspace_commands wc
        join execution_workspaces ew on ew.id = wc.workspace_id
        where wc.client_instance_id = ${fixture.clientInstanceId}
          and wc.status = 'queued'
          and ew.status = 'active'
        order by wc.queued_at asc, wc.id asc
        limit 1
        for update skip locked
      )
      update workspace_commands wc
      set status = 'running',
          lease_owner = 'legacy-worker',
          lease_token = ${leaseToken},
          lease_expires_at = now() + interval '10 minutes',
          heartbeat_at = now(),
          started_at = coalesce(wc.started_at, now()),
          attempts = wc.attempts + 1,
          error = null,
          updated_at = now()
      from candidate
      where wc.id = candidate.id
      returning wc.id
    `;
    return rows[0]?.id;
  }

  /** The previous release's stale-lease recovery: a command whose lease ran out is failed. */
  async function legacyRecoverStale(fixture: Pick<Fixture, "clientInstanceId">): Promise<string[]> {
    const rows = await db.sql<{ id: string }[]>`
      update workspace_commands
      set status = 'failed',
          error = ${db.sql.json({
            code: "WORKSPACE_COMMAND_STALE",
            message: "Workspace command lease expired before the worker completed it",
            category: "stale_lease"
          })},
          lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
          completed_at = now(), updated_at = now()
      where client_instance_id = ${fixture.clientInstanceId}
        and status in ('running', 'cancelling')
        and lease_expires_at is not null
        and lease_expires_at < now()
      returning id
    `;
    return rows.map((row) => row.id);
  }
});

function commandOutput(): NonNullable<WorkspaceCommand["output"]> {
  return {
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 10,
    truncated: { stdout: false, stderr: false },
    changedFiles: [],
    promotedArtifacts: []
  };
}
