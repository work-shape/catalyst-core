import type { AgentRun } from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import {
  useAgentRunJobFixture,
  type AgentRunJobFixture as Fixture
} from "./support/agent-run-job-fixture";
import { waitUntil } from "./support/assertions";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// The mixed-release rehearsal: this release's API and Agent Run worker beside the previous
// release's, with runs in flight. What the previous release does to a run is replayed here as
// that release ran it: its claim, its event append and its recovery of an expired lease.
describe("agent run jobs beside an API and a worker of the previous release", () => {
  const db = usePostgresSuite("agent_run_jobs_transition");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);

  it("executes a run the previous release's API accepted without a job, once", async () => {
    const fixture = await createFixture("old_api");
    const run = await fixture.acceptAsPreviousRelease();
    const worker = fixture.worker({ schedules: true });

    await worker.runDue();
    const pass = worker.runDue();
    const execution = await fixture.executor.next();
    execution.delta("Done.");
    execution.complete();
    await pass;
    await fixture.makeAdoptionDue();
    await worker.runDue();

    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
    expect(await terminalEvents(fixture, run)).toEqual(["run_completed"]);
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBeUndefined();
  });

  it("leaves a run to the previous release's worker that claimed it first", async () => {
    const fixture = await createFixture("old_worker");
    // Accepted by this release, with its job, and claimed by the old worker's queue query.
    const run = await fixture.accept();
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBe(run.id);
    const worker = fixture.worker({ schedules: true });

    // The job finds the run held and ends without waiting on it. The adoption gives the run
    // a job again for as long as it is in progress, and each of them ends the same way.
    await worker.runDue();
    await worker.runDue();
    await fixture.makeAdoptionDue();
    await worker.runDue();
    await worker.runDue();
    const whileHeld = await fixture.jobs();
    expect(whileHeld.length).toBeGreaterThanOrEqual(2);
    expect(whileHeld.every((job) => job.status === "succeeded" && job.attempts === 1)).toBe(true);
    expect(await fixture.run(run)).toMatchObject({ status: "running", leaseToken: "legacy-lease" });

    await legacyAppend(fixture, run, "legacy-lease", 1, "message_delta");
    await legacyAppend(fixture, run, "legacy-lease", 2, "run_completed");
    // A run that ended gets no further job.
    await fixture.makeAdoptionDue();
    await worker.runDue();
    await worker.runDue();

    // One result, the previous release's. No job of this release started an execution.
    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.run(run)).toMatchObject({ status: "completed", lastSequence: 2 });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_completed"]);
    expect(await fixture.jobs()).toEqual(whileHeld);
  });

  it("leaves a run alive that the previous release's worker holds when the job's worker dies", async () => {
    const fixture = await createFixture("two_owners");
    const run = await fixture.accept();
    // The old worker's queue query took the run. A worker of this release claimed the job
    // beside it and was killed before the job looked at the run: its lease ran out.
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBe(run.id);
    await db.sql`
      update platform_jobs
      set status = 'running', attempts = 1, started_at = now(), lease_owner = 'killed-worker',
        lease_token = 'killed-lease', lease_expires_at = now() - interval '1 second'
      where client_instance_id = ${fixture.clientInstanceId} and kind = 'agent_run.execute'`;

    // The surviving worker buries the dead job. The run is not the job's, so it goes on.
    await fixture.worker().runDue();

    expect(await fixture.jobs()).toMatchObject([{ status: "dead", error_code: "LEASE_EXPIRED" }]);
    expect(await fixture.run(run)).toMatchObject({ status: "running", leaseToken: "legacy-lease" });
    expect(await fixture.eventTypes(run)).toEqual([]);
    await expect(legacyAppend(fixture, run, "legacy-lease", 1, "run_completed")).resolves.toBe(
      true
    );
    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
    expect(fixture.executor.calls).toHaveLength(0);
  });

  it("fails a run whose previous-release worker was killed, without executing it again", async () => {
    const fixture = await createFixture("old_worker_killed");
    const run = await fixture.accept();
    await legacyClaim(fixture, "legacy-lease");
    await legacyAppend(fixture, run, "legacy-lease", 1, "message_delta");
    await db.sql`
      update agent_runs set lease_expires_at = now() - interval '1 second' where id = ${run.id}`;

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_WORKER_LOST" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_failed"]);
    // The previous release's own recovery finds nothing left to end.
    await expect(legacyRecoverExpired(fixture)).resolves.toEqual([]);
    // What the killed worker's process might still write is refused as before.
    await expect(legacyAppend(fixture, run, "legacy-lease", 3, "run_completed")).resolves.toBe(
      false
    );
    expect(await terminalEvents(fixture, run)).toEqual(["run_failed"]);
  });

  it("keeps the previous release's worker off a run the job holds, and a rollback ends it once", async () => {
    const fixture = await createFixture("rollback");
    harness.heartbeatsByHand();
    const run = await fixture.accept();
    const pass = fixture.worker().runDue();
    const execution = await fixture.executor.next();
    execution.delta("Before the rollback.");
    await waitUntil(
      async () => (await fixture.events(run)).length === 1,
      "the first piece is stored"
    );

    // The lease on the row makes the run look held to the previous release: neither its
    // claim nor its recovery touches it.
    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBeUndefined();
    await expect(legacyRecoverExpired(fixture)).resolves.toEqual([]);

    // The rollback: this release's worker is gone mid-run and only the previous release
    // runs. Once the lease on the row has run out, its recovery fails the run.
    await db.sql`
      update agent_runs set lease_expires_at = now() - interval '1 second' where id = ${run.id}`;
    await expect(legacyRecoverExpired(fixture)).resolves.toEqual([run.id]);

    // What the lost worker reports afterwards changes nothing.
    execution.delta("After the rollback.");
    execution.complete();
    await pass;
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.run(run)).toMatchObject({
      status: "failed",
      lastSequence: 2,
      error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED" }
    });
    expect(await fixture.eventTypes(run)).toEqual(["message_delta", "run_failed"]);
  });

  it("lets the previous release go on after a rollback with a run this release accepted", async () => {
    const fixture = await createFixture("rollback_queued");
    // Accepted by this release and never claimed by its worker, which is gone.
    const run = await fixture.accept();

    await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBe(run.id);
    await expect(legacyAppend(fixture, run, "legacy-lease", 1, "run_completed")).resolves.toBe(
      true
    );

    expect(await fixture.run(run)).toMatchObject({ status: "completed" });
    expect(await terminalEvents(fixture, run)).toEqual(["run_completed"]);
    // The job this release left behind does nothing when a worker of it ever returns.
    await fixture.worker().runDue();
    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.jobs()).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    // The conversation is free for the next message.
    await expect(fixture.accept("Next")).resolves.toMatchObject({ status: "queued" });
  });

  async function terminalEvents(fixture: Fixture, run: Pick<AgentRun, "id">): Promise<string[]> {
    const types = await fixture.eventTypes(run);
    return types.filter((type) => type.startsWith("run_"));
  }

  /**
   * The claim of the previous release's Agent Run worker, as that release ran it: the oldest
   * queued run, whatever job stands beside it.
   */
  async function legacyClaim(
    fixture: Pick<Fixture, "clientInstanceId">,
    leaseToken: string
  ): Promise<string | undefined> {
    const rows = await db.sql<{ id: string }[]>`
      with candidate as (
        select id
        from agent_runs
        where client_instance_id = ${fixture.clientInstanceId}
          and status = 'queued'
        order by started_at asc, id asc
        limit 1
        for update skip locked
      )
      update agent_runs ar
      set status = 'running',
          lease_owner = 'legacy-worker',
          lease_token = ${leaseToken},
          lease_expires_at = now() + interval '10 minutes',
          heartbeat_at = now(),
          updated_at = now()
      from candidate
      where ar.id = candidate.id
      returning ar.id
    `;
    return rows[0]?.id;
  }

  /**
   * The event append of the previous release's worker: fenced by the token on the row alone.
   * Resolves false when the row refused it, which that release answered with a conflict.
   */
  async function legacyAppend(
    fixture: Pick<Fixture, "clientInstanceId">,
    run: AgentRun,
    leaseToken: string,
    sequence: number,
    type: "message_delta" | "run_completed"
  ): Promise<boolean> {
    return db.sql.begin(async (tx) => {
      const terminal = type === "run_completed";
      const rows = await tx<{ id: string }[]>`
        update agent_runs
        set last_sequence = ${sequence},
            updated_at = now(),
            status = case when ${terminal} then 'completed' else status end,
            completed_at = case when ${terminal} then now() else completed_at end,
            lease_owner = case when ${terminal} then null else lease_owner end,
            lease_token = case when ${terminal} then null else lease_token end,
            lease_expires_at = case when ${terminal} then null else lease_expires_at end,
            heartbeat_at = case when ${terminal} then null else heartbeat_at end
        where client_instance_id = ${fixture.clientInstanceId}
          and id = ${run.id}
          and lease_token = ${leaseToken}
          and lease_expires_at > now()
          and status in ('running', 'waiting_for_permission')
          and last_sequence = ${sequence - 1}
        returning id
      `;
      if (rows.length === 0) return false;
      const createdAt = new Date().toISOString();
      const payload =
        type === "run_completed"
          ? { type, runId: run.id, sequence, createdAt }
          : { type, runId: run.id, sequence, createdAt, delta: "From the previous release." };
      await tx`
        insert into agent_run_observations
          (client_instance_id, run_id, conversation_id, owner_user_id, sequence, type, payload,
           created_at)
        values
          (${fixture.clientInstanceId}, ${run.id}, ${run.conversationId}, ${run.ownerUserId},
           ${sequence}, ${type}, ${tx.json(payload)}, ${createdAt})
      `;
      return true;
    });
  }

  /** The previous release's recovery: a run whose lease ran out is failed, with its event. */
  async function legacyRecoverExpired(
    fixture: Pick<Fixture, "clientInstanceId">
  ): Promise<string[]> {
    return db.sql.begin(async (tx) => {
      const error = {
        code: "AGENT_RUN_RUNTIME_INTERRUPTED",
        message: "Agent run worker lease expired before completion",
        category: "runtime_interrupted"
      };
      const rows = await tx<
        { id: string; conversation_id: string; owner_user_id: string; last_sequence: number }[]
      >`
        update agent_runs
        set status = 'failed',
            failed_at = now(),
            updated_at = now(),
            last_sequence = last_sequence + 1,
            error = ${tx.json(error)},
            lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null
        where client_instance_id = ${fixture.clientInstanceId}
          and status in ('running', 'waiting_for_permission', 'cancelling')
          and lease_expires_at is not null
          and lease_expires_at < now()
        returning id, conversation_id, owner_user_id, last_sequence
      `;
      for (const row of rows) {
        const createdAt = new Date().toISOString();
        const payload = {
          type: "run_failed",
          runId: row.id,
          sequence: row.last_sequence,
          createdAt,
          error
        };
        await tx`
          insert into agent_run_observations
            (client_instance_id, run_id, conversation_id, owner_user_id, sequence, type, payload,
             created_at)
          values
            (${fixture.clientInstanceId}, ${row.id}, ${row.conversation_id}, ${row.owner_user_id},
             ${row.last_sequence}, 'run_failed', ${tx.json(payload)}, ${createdAt})
        `;
      }
      return rows.map((row) => row.id);
    });
  }
});
