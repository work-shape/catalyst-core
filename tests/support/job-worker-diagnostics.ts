import { createJobWorker, type CreateJobWorkerInput } from "@work-shape/catalyst-client-assembly";
import { createPlatformId, type JobWorker, type Logger } from "@work-shape/catalyst-core";
import { beforeEach, onTestFailed } from "vitest";
import { withTestSql } from "./test-sql";

// Keep failures useful even when the fixture's normal logger is silent or its tables have
// already been reset by cleanup. Only executor metadata enters this bounded buffer.
const observations: unknown[] = [];
function record(observation: unknown): void {
  observations.push(observation);
  if (observations.length > 20) observations.shift();
}

beforeEach(() => {
  observations.length = 0;
  onTestFailed(() => {
    if (observations.length) console.error("Job worker diagnostics:", JSON.stringify(observations));
  });
});

const executorMessages = new Set([
  "Job lease was lost before the attempt ended",
  "Job onExhausted failed",
  "Job heartbeat failed",
  "Job attempt failed",
  "Job attempt could not be ended; its lease will expire",
  "Job worker report failed",
  "Job poll failed for a kind",
  "Job could not be released",
  "Job poll failed"
]);

function metadata(fields: unknown): Record<string, string | number> {
  if (typeof fields !== "object" || fields === null) return {};
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        [
          "component",
          "workerId",
          "jobId",
          "kind",
          "attempt",
          "errorClass",
          "code",
          "reason"
        ].includes(key) &&
        (typeof value === "string" || typeof value === "number")
    )
  );
}

function diagnosticLogger(logger: Logger, bindings: Record<string, unknown> = {}): Logger {
  const note = (level: string, fields: unknown, message?: string) => {
    if (message && executorMessages.has(message))
      record({ stage: level, ...bindings, ...metadata(fields), message });
  };
  return {
    debug(fields, message) {
      if (message === "Job worker pass ended") record({ stage: "pass", ...bindings, fields });
      logger.debug(fields, message);
    },
    info: (fields, message) => logger.info(fields, message),
    warn(fields, message) {
      note("warn", fields, message);
      logger.warn(fields, message);
    },
    error(fields, message) {
      note("error", fields, message);
      logger.error(fields, message);
    },
    child: (child) => diagnosticLogger(logger.child(child), { ...bindings, ...metadata(child) })
  };
}

async function snapshot(input: CreateJobWorkerInput): Promise<void> {
  try {
    const state = await withTestSql(
      (sql) => sql`
      select now()::text as database_now,
        (select coalesce(json_agg(j), '[]'::json) from (
          select id, kind, status, attempts, max_attempts, error_code, run_after::text,
            run_after <= now() as due, lease_owner, lease_expires_at::text,
            concurrency_key is not null as has_concurrency_key, concurrency_limit,
            (select count(*)::int from platform_jobs running
             where running.client_instance_id = job.client_instance_id
               and running.kind = job.kind and running.status = 'running'
               and running.concurrency_key = job.concurrency_key) as running_with_key
          from platform_jobs job where client_instance_id = ${input.clientInstanceId}
          order by (status in ('queued', 'running')) desc, created_at desc, id limit 50
        ) j) as jobs,
        (select coalesce(json_agg(w), '[]'::json) from (
          select kind, run_after::text, run_after <= now() as due,
            exists (select 1 from platform_jobs job
                    where job.client_instance_id = wake.client_instance_id
                      and job.kind = wake.kind and job.dedupe_key = wake.dedupe_key
                      and job.status = 'running') as retained_by_running_job
          from platform_job_wakes wake where client_instance_id = ${input.clientInstanceId}
          order by run_after, kind limit 50
        ) w) as wakes,
        (select coalesce(json_agg(r), '[]'::json) from (
          select kind, seen_at::text, alive_since::text from job_worker_reports
          where client_instance_id = ${input.clientInstanceId} order by kind limit 100
        ) r) as worker_reports
    `
    );
    record({
      stage: "after_run_due",
      clientInstanceId: input.clientInstanceId,
      workerId: input.workerId,
      state
    });
  } catch {
    // Diagnostics must not replace the worker's failure or make a passing test fail.
    record({ stage: "snapshot_unavailable", clientInstanceId: input.clientInstanceId });
  }
}

/** Manual passes keep their decisions and a payload-free queue snapshot until the test ends. */
export function createDiagnosedJobWorker(input: CreateJobWorkerInput): JobWorker {
  const observed = { ...input, workerId: input.workerId ?? createPlatformId("worker") };
  const worker = createJobWorker({ ...observed, logger: diagnosticLogger(input.logger) });
  return {
    ...worker,
    async runDue() {
      try {
        await worker.runDue();
      } finally {
        await snapshot(observed);
      }
    }
  };
}
