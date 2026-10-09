import {
  defineJobKind,
  type ClientInstanceId,
  type JobControl,
  type JobSchedule,
  type JobWorker,
  type Logger,
  type PlatformStores,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import { required } from "./assertions";
import type { PostgresSuite } from "./postgres-suite";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const numbered = z.object({ n: z.number() });
export type Numbered = z.infer<typeof numbered>;

export function kindOf(
  kind: string,
  overrides: Partial<
    Omit<ReturnType<typeof defineJobKind<Numbered>>, "kind" | "payloadSchema">
  > = {}
) {
  return defineJobKind({
    kind,
    payloadSchema: numbered,
    maxAttempts: 3,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs: 60_000,
    concurrency: {},
    ...overrides
  });
}

export interface JobRecord {
  id: string;
  status: string;
  attempts: number;
  error_code: string | null;
  lease_token: string | null;
  run_after: Date;
  started_at: Date | null;
  finished_at: Date | null;
  due: boolean;
}

/**
 * Workers and job rows for the tests of the job executor. Call it in the `describe` that holds
 * the tests: it stops the workers and removes the jobs after each.
 */
export function useJobExecutorHarness(db: PostgresSuite) {
  const workers: JobWorker[] = [];
  const hanging: Array<() => void> = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const release of hanging.splice(0)) release();
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    await db.sql`delete from platform_jobs`;
  });

  function worker(
    stores: PlatformStores,
    clientInstanceId: ClientInstanceId,
    handlers: RegisteredJobHandler[],
    schedules: JobSchedule[] = []
  ): JobWorker {
    const created = createPostgresJobWorker({
      stores,
      clientInstanceId,
      handlers,
      schedules,
      logger: silent
    });
    workers.push(created);
    return created;
  }

  /** A handler body that waits until the test lets go or the worker aborts the attempt. */
  function hang(control: JobControl): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      hanging.push(resolve);
      control.signal.addEventListener("abort", () => reject(control.signal.reason));
    });
  }

  function jobs(clientInstanceId: ClientInstanceId) {
    return db.sql<JobRecord[]>`
      select id, status, attempts, error_code, lease_token, run_after, started_at, finished_at,
             run_after <= now() as due
      from platform_jobs
      where client_instance_id = ${clientInstanceId}
      order by created_at, id
    `;
  }

  async function onlyJob(clientInstanceId: ClientInstanceId): Promise<JobRecord> {
    const rows = await jobs(clientInstanceId);
    expect(rows).toHaveLength(1);
    return required(rows[0]);
  }

  /** As if the heartbeats had stopped: the lease is over, by the database's own clock. */
  async function expireLeases(clientInstanceId: ClientInstanceId): Promise<void> {
    await db.sql`
      update platform_jobs set lease_expires_at = now() - interval '1 second'
      where client_instance_id = ${clientInstanceId} and status = 'running'
    `;
  }

  return { worker, hang, jobs, onlyJob, expireLeases };
}
