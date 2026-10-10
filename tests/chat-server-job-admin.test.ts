import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiErrorResponseSchema } from "@vivd-catalyst/api-contract";
import {
  StoreBackedAuditRecorder,
  asClientInstanceId,
  legacyPermissionFor
} from "@vivd-catalyst/core";
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
const administrator = asCaller({ id: "usr_admin", roles: ["admin"], permissions: auditView });
const member = asCaller({ id: "usr_member", roles: ["user"] });

function createServer() {
  return createTestInstanceWith((stores) => ({
    authAdapter: createCallerAuthAdapter(),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit })
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
  items: z.array(z.object({ id: z.string() }).loose()),
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

    const response = await server.call("instance.jobs.summary", {}, administrator);

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
      administrator
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
          finishedAt: PAST
        },
        {
          id: "job_1",
          kind: "report.build",
          status: "dead",
          attempts: 3,
          maxAttempts: 3,
          errorCode: "INTERNAL",
          createdAt: "2024-05-01T08:00:00.000Z",
          finishedAt: PAST
        }
      ]
    });
    const ofKind = await server.call(
      "instance.jobs.list",
      { query: { kind: "report.build" } },
      administrator
    );
    expect(jobListSchema.parse(ofKind.json()).items.map((job) => job.id)).toEqual([
      "job_3",
      "job_1"
    ]);
    for (const response of [ended, ofKind]) {
      expect(response.body).not.toContain(PAYLOAD_MARKER);
      expect(response.body).not.toContain(MESSAGE_MARKER);
    }

    const unknownStatus = await server.call(
      "instance.jobs.list",
      { query: { status: "failed,lost" } },
      administrator
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
        administrator
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
    // A kind the API process serves. Without the schedule's dedupe key it is no tick.
    await plant({ id: "job_dead", kind: "platform_jobs.prune", status: "dead" });
    await withSql((sql) => sql`update platform_jobs set payload = '{}' where id = 'job_dead'`);

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
      errorCode: "INTERNAL"
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
        kind: "platform_jobs.prune",
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
      { id: "job_elsewhere", kind: "report.build", status: "dead", instance: "another-instance" },
      { id: "job_old", kind: "report.build", status: "dead", dedupeKey: "report:7" },
      { id: "job_new", kind: "report.build", status: "queued", dedupeKey: "report:7" }
    );
    const retry = (jobId: string) =>
      server.call("instance.jobs.retry", { params: { jobId } }, superadmin);

    const queued = await retry("job_queued");
    expect([queued.statusCode, errorOf(queued).code]).toEqual([409, "CONFLICT"]);
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

  it("lets an administrator read and leaves the retry to a superadmin", async () => {
    const server = await createServer();
    await plant({ id: "job_dead", kind: "report.build", status: "dead" });

    const summary = await server.call("instance.jobs.summary", {}, administrator);
    const list = await server.call("instance.jobs.list", {}, administrator);
    const retry = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      administrator
    );

    expect([summary.statusCode, list.statusCode]).toEqual([200, 200]);
    expect([retry.statusCode, errorOf(retry)]).toEqual([
      403,
      expect.objectContaining({
        code: "FORBIDDEN",
        details: { action: "instance.jobs.retry", reason: "no_grant" }
      })
    ]);
    await expect(storedJob("job_dead")).resolves.toMatchObject({ status: "dead", attempts: 3 });
    // A service principal is no superadmin either: the retry takes a person.
    const service = await server.call(
      "instance.jobs.retry",
      { params: { jobId: "job_dead" } },
      asCaller({ kind: "service", permissions: auditView })
    );
    expect(service.statusCode).toBe(403);
  });
});

describe("Instance > Jobs: the summary on a large queue", () => {
  const explainSchema = z.tuple([
    z.object({ "QUERY PLAN": z.tuple([z.object({ Plan: z.unknown() }).loose()]) })
  ]);
  const nodeSchema = z
    .object({
      "Node Type": z.string(),
      "Index Name": z.string().optional(),
      "Relation Name": z.string().optional(),
      "Shared Hit Blocks": z.number().default(0),
      "Shared Read Blocks": z.number().default(0),
      Plans: z.array(z.unknown()).default([])
    })
    .loose();
  type PlanNode = z.infer<typeof nodeSchema>;
  function nodesOf(plan: unknown): PlanNode[] {
    const node = nodeSchema.parse(plan);
    return [node, ...node.Plans.flatMap(nodesOf)];
  }

  it("is answered from the claim index without reading the table of 500,000 jobs", async () => {
    const server = await createServer();
    await withSql(async (sql) => {
      // Mostly succeeded jobs, as after a week of work, over ten kinds.
      await sql`
        insert into platform_jobs (
          id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
          correlation_id, created_at
        )
        select
          'job_' || n, ${clientInstanceId}, 'kind.number_' || (n % 10),
          '{"conversationId": "conv_0000000000000000", "userId": "usr_0000000000000000"}',
          case when n % 49 = 0 then (array['queued', 'running', 'failed', 'dead'])[1 + (n / 49) % 4]
               else 'succeeded' end,
          timestamptz '2024-01-01' + make_interval(secs => n), 1, 3, 'corr_' || n,
          timestamptz '2024-01-01' + make_interval(secs => n)
        from generate_series(1, 500000) n`;
      await sql`vacuum analyze platform_jobs`;
    });

    const summary = await server.stores.jobs.summarizeByKind({ clientInstanceId });
    expect(summary).toHaveLength(10);
    expect(
      summary.reduce((sum, row) => sum + row.queued + row.running + row.failed + row.dead, 0)
    ).toBe(10_204);

    // The statement the store just ran, as the server recorded it, explained with its values.
    const nodes = await withSql(async (sql) => {
      const [ran] = await sql<{ query: string }[]>`
        select query from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and query like '%with recursive kinds%'`;
      // The server keeps the first 1,023 bytes of a statement by default. A longer summary
      // statement would be explained cut off, so its length is held here.
      expect(ran?.query.length).toBeLessThan(1000);
      const explained = await sql.unsafe(
        `explain (analyze, buffers, format json) ${ran?.query ?? ""}`,
        [
          clientInstanceId,
          clientInstanceId,
          ["queued", "running", "failed", "dead"],
          clientInstanceId
        ]
      );
      return nodesOf(explainSchema.parse(explained)[0]["QUERY PLAN"][0].Plan);
    });

    const scans = nodes.filter((node) => node["Relation Name"] === "platform_jobs");
    expect(new Set(scans.map((node) => `${node["Node Type"]} ${node["Index Name"]}`))).toEqual(
      new Set(["Index Only Scan platform_jobs_claim_idx"])
    );
    // The work is bounded by the jobs counted: a read of the table touches about 12,500 pages
    // and a read of the whole index about 4,000. Time is not asserted, the machine is shared.
    const pages = (nodes[0]?.["Shared Hit Blocks"] ?? 0) + (nodes[0]?.["Shared Read Blocks"] ?? 0);
    expect(pages).toBeLessThan(SUMMARY_MAX_PAGES);
  }, 120_000);
});

/** Counting 10,204 of 500,000 jobs through the index touches about 300 pages. */
const SUMMARY_MAX_PAGES = 1_000;
