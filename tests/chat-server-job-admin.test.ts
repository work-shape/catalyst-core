import { jobAdminQueryPlanTests } from "./support/job-admin-query-plan";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorResponseSchema } from "@work-shape/catalyst-api-contract";
import {
  StoreBackedAuditRecorder,
  asClientInstanceId,
  defineJobKind,
  legacyPermissionFor,
  type JobRetry
} from "@work-shape/catalyst-core";
import { runWorkspaceCommandJob } from "@work-shape/catalyst-tool-execution";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { withTestSql as withSql } from "./support/test-sql";
import { createTestInstanceWith, getTestJobs } from "./support/test-instance";

// Instance > Jobs over HTTP: what an operator is shown of the queue, who may read and retry,
// and that neither a payload nor an error message leaves the instance.

const clientInstanceId = asClientInstanceId("demo-local");
const PAYLOAD_MARKER = "payload-marker-7f3a";
const MESSAGE_MARKER = "provider-message-marker-91bc";

const auditView = [legacyPermissionFor("audit.view")];
const superadmin = asCaller({ id: "usr_root", roles: ["superadmin"], permissions: auditView });
// A customer's admin: every right an admin holds by default, and not `system.view` (RIGHTS-1e).
const administrator = asCaller({ id: "usr_admin", roles: ["admin"], permissions: auditView });
// Who runs the instance and reads its jobs: a superadmin, who holds `system.view` by default.
const operator = superadmin;
const member = asCaller({ id: "usr_member", roles: ["user"] });

const fixtureKind = (kind: string) =>
  defineJobKind({
    kind,
    payloadSchema: z.object({}),
    maxAttempts: 3,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs: 60_000,
    concurrency: {}
  });
/** What `report.locked` jobs were asked to put back, and the answer they get. */
const restoreCalls: (string | undefined)[] = [];
// As a capability hands them over: a kind that is retried as it is, and one whose subject
// cannot be worked on again. `mail.send` stays unknown to the API.
const capabilityJobRetries: JobRetry[] = [
  { kind: fixtureKind("report.build") },
  // Handed over by mistake: the kind itself says that it is not retried.
  { kind: runWorkspaceCommandJob },
  {
    kind: fixtureKind("report.locked"),
    restoreSubject: (job) => {
      restoreCalls.push(job.subject);
      return Promise.resolve(false);
    }
  }
];

function createServer() {
  return createTestInstanceWith((stores) => ({
    authAdapter: createCallerAuthAdapter(),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
    jobRetries: capabilityJobRetries
  }));
}

interface PlantedJob {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "dead";
  instance?: string;
  subject?: string;
  dedupeKey?: string;
  /** The stored moments, so a test reads back exactly what it wrote. */
  createdAt?: string;
  runAfter?: string;
}

const PAST = "2020-01-01T00:00:00.000Z";

/** Writes job rows as the executor leaves them, each with a payload and an error message. */
function plant(...jobs: PlantedJob[]): Promise<void> {
  return withSql(async (sql) => {
    for (const job of jobs) {
      const ended = job.status === "failed" || job.status === "dead";
      await sql`
        insert into platform_jobs (
          id, client_instance_id, kind, subject, payload, status, run_after, attempts,
          max_attempts, dedupe_key, error_code, error_message, correlation_id, created_at,
          finished_at
        ) values (
          ${job.id}, ${job.instance ?? clientInstanceId}, ${job.kind}, ${job.subject ?? null},
          ${sql.json({ note: PAYLOAD_MARKER })}, ${job.status}, ${job.runAfter ?? PAST},
          ${ended ? 3 : 0}, 3, ${job.dedupeKey ?? null}, ${ended ? "INTERNAL" : null},
          ${ended ? MESSAGE_MARKER : null}, ${`corr_${job.id}`}, ${job.createdAt ?? PAST},
          ${ended ? PAST : null}
        )`;
    }
  });
}

function storedJob(id: string) {
  return withSql(async (sql) => {
    const [row] = await sql<{ status: string; attempts: number; error_code: string | null }[]>`
      select status, attempts, error_code from platform_jobs where id = ${id}`;
    return row ? { ...row } : undefined;
  });
}

const jobListSchema = z.object({
  items: z.array(z.object({ id: z.string(), retryable: z.boolean() }).loose()),
  nextCursor: z.string().optional()
});
const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;

describe("Instance > Jobs: what an operator reads", () => {
  it("counts the queued, running, failed and dead jobs of each kind of this instance", async () => {
    const server = await createServer();
    await plant(
      {
        id: "job_a1",
        kind: "report.build",
        status: "queued",
        runAfter: "2021-03-01T10:00:00.000Z"
      },
      {
        id: "job_a2",
        kind: "report.build",
        status: "queued",
        runAfter: "2021-02-01T10:00:00.000Z"
      },
      // Waits for a later attempt: it is queued, and it is not waiting on a worker.
      {
        id: "job_a3",
        kind: "report.build",
        status: "queued",
        runAfter: "2999-01-01T00:00:00.000Z"
      },
      { id: "job_a4", kind: "report.build", status: "running" },
      { id: "job_a5", kind: "report.build", status: "dead" },
      { id: "job_a6", kind: "report.build", status: "succeeded" },
      { id: "job_b1", kind: "mail.send", status: "failed" },
      { id: "job_b2", kind: "mail.send", status: "failed" },
      { id: "job_c1", kind: "done.only", status: "succeeded" },
      { id: "job_x1", kind: "report.build", status: "dead", instance: "another-instance" }
    );

    const response = await server.call("instance.jobs.summary", {}, operator);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { kind: "mail.send", queued: 0, running: 0, failed: 2, dead: 0 },
        {
          kind: "report.build",
          queued: 3,
          running: 1,
          failed: 0,
          dead: 1,
          waitingSince: "2021-02-01T10:00:00.000Z"
        }
      ]
    });
  });

  it("lists jobs newest first by status and kind, without payload or error message", async () => {
    const server = await createServer();
    await plant(
      { id: "job_1", kind: "report.build", status: "dead", createdAt: "2024-05-01T08:00:00.000Z" },
      {
        id: "job_2",
        kind: "mail.send",
        status: "failed",
        subject: "msg_42",
        createdAt: "2024-05-02T08:00:00.000Z"
      },
      {
        id: "job_3",
        kind: "report.build",
        status: "queued",
        createdAt: "2024-05-03T08:00:00.000Z"
      },
      { id: "job_4", kind: "report.build", status: "failed", instance: "another-instance" }
    );

    const ended = await server.call(
      "instance.jobs.list",
      { query: { status: "failed,dead" } },
      operator
    );
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({
      items: [
        {
          id: "job_2",
          kind: "mail.send",
          status: "failed",
          attempts: 3,
          maxAttempts: 3,
          subject: "msg_42",
          errorCode: "INTERNAL",
          createdAt: "2024-05-02T08:00:00.000Z",
          finishedAt: PAST,
          // The API was given no retry for this kind.
          retryable: false
        },
        {
          id: "job_1",
          kind: "report.build",
          status: "dead",
          attempts: 3,
          maxAttempts: 3,
          errorCode: "INTERNAL",
          createdAt: "2024-05-01T08:00:00.000Z",
          finishedAt: PAST,
          retryable: true
        }
      ]
    });
    const ofKind = await server.call(
      "instance.jobs.list",
      { query: { kind: "report.build" } },
      operator
    );
    // A job that has not ended is not retried, whatever its kind.
    expect(jobListSchema.parse(ofKind.json()).items.map((job) => [job.id, job.retryable])).toEqual([
      ["job_3", false],
      ["job_1", true]
    ]);
    for (const response of [ended, ofKind]) {
      expect(response.body).not.toContain(PAYLOAD_MARKER);
      expect(response.body).not.toContain(MESSAGE_MARKER);
    }

    const unknownStatus = await server.call(
      "instance.jobs.list",
      { query: { status: "failed,lost" } },
      operator
    );
    expect(unknownStatus.statusCode).toBe(422);
    expect(errorOf(unknownStatus).code).toBe("VALIDATION_FAILED");
  });

  it("pages through jobs created within one millisecond without losing or repeating one", async () => {
    const server = await createServer();
    // The executor stamps microseconds and the list answers milliseconds.
    await plant(
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `job_${index}`,
        kind: "report.build",
        status: "dead" as const,
        createdAt: `2024-05-01T08:00:00.0004${index}Z`
      }))
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await server.call(
        "instance.jobs.list",
        { query: { status: "dead", limit: 2, cursor } },
        operator
      );
      const page = jobListSchema.parse(response.json());
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((job) => job.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(["job_4", "job_3", "job_2", "job_1", "job_0"]);
  });
});

describe("Instance > Jobs: retry", () => {
  it("queues a dead job again with its attempts reset, records who did it, and the job runs", async () => {
    const server = await createServer();
    // A kind the API process serves. Its conversation is gone, so the attempt ends at once.
    await plant({ id: "job_dead", kind: "conversation.generate_title", status: "dead" });
    await withSql(
      (sql) => sql`
        update platform_jobs
        set payload = ${sql.json({ conversationId: "conv_gone", userId: "usr_gone" })}
        where id = 'job_dead'`
    );

    const response = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      superadmin
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "job_dead",
      status: "queued",
      attempts: 0,
      errorCode: "INTERNAL",
      retryable: false
    });
    expect(response.json()).not.toHaveProperty("finishedAt");
    expect(response.body).not.toContain(MESSAGE_MARKER);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "queued", attempts: 0 });
    const retried = await server.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "job.retried"
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      status: "success",
      subject: "job_dead",
      actor: { userId: "usr_root" },
      metadata: {
        kind: "conversation.generate_title",
        operationRunId: response.headers["operation-run-id"]
      }
    });
    expect(JSON.stringify(retried)).not.toContain(MESSAGE_MARKER);

    await getTestJobs(server).runDue();

    await expect(storedJob("job_dead")).resolves.toEqual({
      status: "succeeded",
      attempts: 1,
      error_code: null
    });
  });

  it("refuses a job that has not ended, is unknown, belongs elsewhere or was superseded", async () => {
    const server = await createServer();
    await plant(
      { id: "job_queued", kind: "report.build", status: "queued" },
      { id: "job_running", kind: "report.build", status: "running" },
      { id: "job_elsewhere", kind: "report.build", status: "dead", instance: "another-instance" },
      { id: "job_old", kind: "report.build", status: "dead", dedupeKey: "report:7" },
      { id: "job_new", kind: "report.build", status: "queued", dedupeKey: "report:7" }
    );
    const retry = (jobId: string) =>
      server.call("instance.jobs.retry", { params: { jobId } }, superadmin);

    for (const status of ["queued", "running"]) {
      const live = await retry(`job_${status}`);
      expect([live.statusCode, errorOf(live)]).toEqual([
        409,
        expect.objectContaining({ code: "CONFLICT", details: { status } })
      ]);
      await expect(storedJob(`job_${status}`)).resolves.toMatchObject({ status });
    }
    for (const jobId of ["job_missing", "job_elsewhere"]) {
      const missing = await retry(jobId);
      expect([missing.statusCode, errorOf(missing).code]).toEqual([404, "NOT_FOUND"]);
    }
    const superseded = await retry("job_old");
    expect([superseded.statusCode, errorOf(superseded)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "superseded" } })
    ]);

    await expect(storedJob("job_old")).resolves.toMatchObject({ status: "dead", attempts: 3 });
    await expect(storedJob("job_elsewhere")).resolves.toMatchObject({ status: "dead" });
    await expect(
      server.stores.audit.listAuditEvents({ clientInstanceId, type: "job.retried" })
    ).resolves.toEqual([]);
  });

  it("offers no retry for a schedule tick or a kind it was given no retry for, and takes none", async () => {
    const server = await createServer();
    await plant(
      // A tick that failed while the next one already waits under the schedule's key.
      {
        id: "job_tick",
        kind: "conversation.expire",
        status: "failed",
        dedupeKey: "schedule:conversation.expire"
      },
      // The same kind without a key: it is the kind that is not retried, not the key.
      { id: "job_tick_free", kind: "conversation.expire", status: "failed" },
      { id: "job_unknown", kind: "mail.send", status: "dead" }
    );

    const listed = await server.call(
      "instance.jobs.list",
      { query: { status: "failed,dead" } },
      operator
    );
    expect(jobListSchema.parse(listed.json()).items.map((job) => [job.id, job.retryable])).toEqual(
      expect.arrayContaining([
        ["job_tick", false],
        ["job_tick_free", false],
        ["job_unknown", false]
      ])
    );
    for (const jobId of ["job_tick_free", "job_unknown"]) {
      const refused = await server.call("instance.jobs.retry", { params: { jobId } }, superadmin);
      expect([refused.statusCode, errorOf(refused)]).toEqual([
        409,
        expect.objectContaining({ code: "CONFLICT", details: { reason: "kind_not_retried" } })
      ]);
      // The refusal took back the reset of the job.
      await expect(storedJob(jobId)).resolves.toMatchObject({ attempts: 3 });
    }
    await expect(storedJob("job_unknown")).resolves.toMatchObject({ status: "dead" });
  });

  it("offers no retry for a workspace command, even when the API was given one for the kind", async () => {
    const server = await createServer();
    await plant(
      { id: "job_cmd_dead", kind: "workspace.command", status: "dead", subject: "wcmd_1" },
      { id: "job_cmd_failed", kind: "workspace.command", status: "failed", subject: "wcmd_2" }
    );

    const listed = await server.call(
      "instance.jobs.list",
      { query: { kind: "workspace.command" } },
      operator
    );
    // The page shows Retry for a job listed as retryable and for no other.
    expect(
      jobListSchema
        .parse(listed.json())
        .items.map((job) => [job.id, job.retryable])
        .sort()
    ).toEqual([
      ["job_cmd_dead", false],
      ["job_cmd_failed", false]
    ]);
    const refused = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_cmd_dead" } },
      superadmin
    );
    expect([refused.statusCode, errorOf(refused)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "kind_not_retried" } })
    ]);
    await expect(storedJob("job_cmd_dead")).resolves.toMatchObject({ status: "dead", attempts: 3 });
  });

  it("changes nothing when what the job worked on cannot be worked on again", async () => {
    const server = await createServer();
    await plant({ id: "job_locked", kind: "report.locked", status: "dead", subject: "rep_9" });
    restoreCalls.length = 0;

    const refused = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_locked" } },
      superadmin
    );

    expect(restoreCalls).toEqual(["rep_9"]);
    expect([refused.statusCode, errorOf(refused)]).toEqual([
      409,
      expect.objectContaining({
        code: "CONFLICT",
        details: { reason: "subject_not_restorable" }
      })
    ]);
    await expect(storedJob("job_locked")).resolves.toEqual({
      status: "dead",
      attempts: 3,
      error_code: "INTERNAL"
    });
    await expect(
      server.stores.audit.listAuditEvents({ clientInstanceId, type: "job.retried" })
    ).resolves.toEqual([]);
  });
});

describe("Instance > Jobs: who may", () => {
  it("refuses all three operations without the right to view the audit log", async () => {
    const server = await createServer();
    await plant({ id: "job_dead", kind: "report.build", status: "dead" });

    const refusals = [
      await server.call("instance.jobs.summary", {}, member),
      await server.call("instance.jobs.list", {}, member),
      await server.call("instance.jobs.retry", { params: { jobId: "job_dead" } }, member)
    ];

    expect(refusals.map((response) => [response.statusCode, errorOf(response).code])).toEqual([
      [403, "FORBIDDEN"],
      [403, "FORBIDDEN"],
      [403, "FORBIDDEN"]
    ]);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "dead" });
  });

  it("refuses an admin the jobs, naming system.view, and the retry, naming jobs.retry", async () => {
    const server = await createServer();
    await plant({ id: "job_dead", kind: "report.build", status: "dead" });

    const summary = await server.call("instance.jobs.summary", {}, administrator);
    const list = await server.call("instance.jobs.list", {}, administrator);
    const retry = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      administrator
    );

    // Navigation check 40: by address too, the API answers an admin no System page.
    for (const read of [summary, list]) {
      expect([read.statusCode, errorOf(read).details]).toEqual([
        403,
        { action: "system.view", reason: "no_grant" }
      ]);
    }
    expect([retry.statusCode, errorOf(retry)]).toEqual([
      403,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "Missing the right 'jobs.retry'",
        details: { action: "jobs.retry", reason: "no_grant" }
      })
    ]);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "dead", attempts: 3 });
    // A service principal granted `system.view` reads as a person does. The retry takes a person.
    const service = asCaller({ kind: "service", permissions: auditView });
    await server.call("instance.jobs.list", {}, service);
    await withSql(
      (sql) => sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          ('grant_sp_system', ${clientInstanceId}, 'service_principal', 'sp_test', 'system.view',
           'instance', 'allow', 'usr_root', now())`
    );
    const read = [
      await server.call("instance.jobs.summary", {}, service),
      await server.call("instance.jobs.list", { query: { status: "dead" } }, service)
    ];
    expect(read.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(jobListSchema.parse(read[1]?.json()).items.map((job) => job.id)).toEqual(["job_dead"]);
    const withoutRight = await server.call(
      "instance.jobs.list",
      {},
      asCaller({ kind: "service", id: "sp_other", permissions: auditView })
    );
    expect(withoutRight.statusCode).toBe(403);
    const serviceRetry = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      service
    );
    expect(serviceRetry.statusCode).toBe(403);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "dead", attempts: 3 });
  });

  it("lets a person granted jobs.retry retry a dead job, without being a superadmin (check 40)", async () => {
    const server = await createServer();
    await plant({ id: "job_dead", kind: "report.build", status: "dead" });
    const operator = asCaller({ id: "usr_operator", roles: ["user"], permissions: auditView });
    await withSql(
      (sql) => sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          ('grant_retry', ${clientInstanceId}, 'user', 'usr_operator', 'jobs.retry', 'instance',
           'allow', 'usr_root', now())`
    );

    const retry = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      operator
    );

    expect(retry.statusCode).toBe(200);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "queued", attempts: 0 });
  });

  it("refuses the retry to a superadmin denied jobs.retry on their person", async () => {
    const server = await createServer();
    await plant({ id: "job_dead", kind: "report.build", status: "dead" });
    // A deny written on the person reaches a superadmin (ADR-0028, amended 2026-10-21).
    await withSql(
      (sql) => sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          ('grant_no_retry', ${clientInstanceId}, 'user', 'usr_root', 'jobs.retry', 'instance',
           'deny', 'usr_root', now())`
    );

    const retry = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      superadmin
    );

    expect([retry.statusCode, errorOf(retry).details]).toEqual([
      403,
      { action: "jobs.retry", reason: "denied" }
    ]);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "dead", attempts: 3 });
  });
});

jobAdminQueryPlanTests(50_000);
