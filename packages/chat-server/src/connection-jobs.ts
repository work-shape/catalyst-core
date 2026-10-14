import {
  AppError,
  NonRetryableJobError,
  defineJobHandler,
  defineJobKind,
  subjectDedupeKey,
  type ClientInstanceId,
  type Job,
  type JobsStore,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { ChatServerOptions } from "./types";

// Discovery as a job. The API process enqueues one job per Connection whose operations are
// read from the outside system, after each seed. Nothing here runs during startup and nothing
// here makes an operation callable: the job stores what was read, and the accepted list of
// the Connection decides.

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * How often one discovery is tried. The waits between the attempts double from 15 seconds up
 * to 5 minutes, so an outside system that starts after the instance has close to eight
 * minutes to come up. After the last attempt the job is dead; the next start of the API
 * enqueues a new one, and an operator can retry the dead one.
 */
const CONNECTION_DISCOVERY_MAX_ATTEMPTS = 6;
const CONNECTION_DISCOVERY_BACKOFF_BASE_MS = 15 * SECOND_MS;
const CONNECTION_DISCOVERY_BACKOFF_MAX_MS = 5 * MINUTE_MS;

/**
 * The lease of a running discovery. A discovery ends by itself within a minute
 * (`CONNECTION_DISCOVERY_TIMEOUT_MS`), so a job whose lease is this old lost its process.
 */
const CONNECTION_DISCOVERY_LEASE_MS = 3 * MINUTE_MS;

/**
 * How many discoveries run at once across the instance, and in one API process. A discovery
 * holds one outgoing connection and at most 4 MiB of an answer, so this bounds both whatever
 * the number of Connections that are due after a start.
 */
const CONNECTION_DISCOVERY_MAX_RUNNING = 4;
const CONNECTION_DISCOVERY_SLOTS = 2;

/**
 * Reads the operations of one Connection from its outside system. One job per Connection is
 * queued or running at a time, and one attempt of it. The payload names the Connection and
 * holds nothing of it.
 */
export const connectionDiscoverJob = defineJobKind({
  kind: "connection.discover",
  payloadSchema: z.object({ connectionName: z.string().min(1).max(200) }),
  maxAttempts: CONNECTION_DISCOVERY_MAX_ATTEMPTS,
  backoff: {
    baseMs: CONNECTION_DISCOVERY_BACKOFF_BASE_MS,
    maxMs: CONNECTION_DISCOVERY_BACKOFF_MAX_MS
  },
  leaseMs: CONNECTION_DISCOVERY_LEASE_MS,
  concurrency: { global: CONNECTION_DISCOVERY_MAX_RUNNING, perKey: 1 }
});

/**
 * Queues the discovery of one Connection. While one is queued or running for the Connection
 * this inserts nothing and answers that job, so a second start, or a second API process, adds
 * no second job.
 *
 * `behind` names a job that is running now and has read the Connection already. The
 * discovery is then queued under the other of the Connection's two keys, so it is not taken
 * for the running one, and it runs once that one ended. A Connection so has at most two live
 * jobs: one running and one queued behind it.
 */
function enqueueConnectionDiscovery(
  jobs: Pick<JobsStore, "enqueue">,
  input: {
    clientInstanceId: ClientInstanceId;
    connectionName: string;
    behind?: Pick<Job, "dedupeKey">;
  }
): Promise<Job<{ connectionName: string }>> {
  const first = subjectDedupeKey(connectionDiscoverJob.kind, input.connectionName);
  const second = `${first}:next`;
  return jobs.enqueue(
    connectionDiscoverJob,
    { connectionName: input.connectionName },
    {
      clientInstanceId: input.clientInstanceId,
      subject: input.connectionName,
      dedupeKey: input.behind?.dedupeKey === first ? second : first,
      concurrencyKey: input.connectionName
    }
  );
}

/**
 * Asks for a discovery that starts after this call: one is queued, and where one runs now,
 * which may have read the Connection before the change that asks, one is queued behind it.
 */
export async function requestConnectionDiscovery(
  jobs: Pick<JobsStore, "enqueue">,
  input: { clientInstanceId: ClientInstanceId; connectionName: string }
): Promise<void> {
  const job = await enqueueConnectionDiscovery(jobs, input);
  if (job.status === "running") {
    await enqueueConnectionDiscovery(jobs, { ...input, behind: job });
  }
}

/**
 * The failures another attempt cannot mend: they change with the Connection's config, its
 * secret or the instance's egress list, and each of those is followed by a new discovery.
 */
const FAILURES_NOT_RETRIED: ReadonlySet<string> = new Set([
  "egress_denied",
  "connection_not_configured",
  "secret_unreadable",
  "upstream_unauthorized",
  "output_invalid"
]);

type ConnectionDiscoveryJobOptions = Pick<ChatServerOptions, "connections" | "auditRecorder">;

/**
 * The handler of `connection.discover`, for the API process. An instance whose assembly
 * brings no discovery serves no such job.
 */
export function createConnectionDiscoveryJobs(options: ConnectionDiscoveryJobOptions): {
  handlers: RegisteredJobHandler[];
} {
  const connections = options.connections;
  if (!connections?.discover) return { handlers: [] };
  const discover = connections.discover.bind(connections);

  return {
    handlers: [
      defineJobHandler({
        kind: connectionDiscoverJob,
        slots: CONNECTION_DISCOVERY_SLOTS,
        async run(job, control) {
          const { connectionName } = job.payload;
          // Every write of the discovery is one of this attempt: an attempt that lost its
          // lease stores nothing over what the attempt after it found.
          const outcome = await discover(connectionName, {
            signal: control.signal,
            transaction: (write) => control.transaction(write)
          });
          if (outcome.superseded === true) {
            // The Connection changed while it was read. A new discovery reads it as it is
            // now. This job is still running, so the new one is queued behind it.
            await control.transaction((stores) =>
              enqueueConnectionDiscovery(stores.jobs, {
                clientInstanceId: job.clientInstanceId,
                connectionName,
                behind: job
              })
            );
            return;
          }
          if (outcome.status === "skipped") return;
          // The worker stops or the lease is gone: nothing was decided and nothing written.
          // The attempt is given back.
          if (outcome.stopped === true || (outcome.status === "failed" && control.signal.aborted)) {
            throw new AppError("CONFLICT", "The discovery of a Connection was stopped");
          }
          if (outcome.status === "discovered") {
            // What was found is counted. No name, description or schema of it is recorded.
            // An operation left out for the credential gives the event its fixed reason, by
            // which the timeline shows it. One left out for its schema gives the code of that.
            const rejected = (outcome.rejectedCount ?? 0) > 0;
            const reason = rejected ? "output_rejected" : outcome.schemaRefusal;
            await options.auditRecorder.record({
              type: "connection.discovered",
              status: "success",
              ...(reason === undefined ? {} : { reason }),
              subject: connectionName,
              correlationId: job.correlationId,
              metadata: {
                connectionName,
                operationCount: outcome.operationCount ?? 0,
                leftOutCount: outcome.leftOutCount ?? 0,
                rejectedCount: outcome.rejectedCount ?? 0,
                schemaRefusedCount: outcome.schemaRefusedCount ?? 0
              }
            });
            return;
          }
          const reason = outcome.reason ?? "discovery_failed";
          const retried =
            !FAILURES_NOT_RETRIED.has(reason) &&
            control.attempt < connectionDiscoverJob.maxAttempts;
          if (!retried) {
            await options.auditRecorder.record({
              type: "connection.discovery_failed",
              status: "failed",
              subject: connectionName,
              reason,
              correlationId: job.correlationId,
              metadata: { connectionName, attempts: control.attempt }
            });
          }
          // The reason is a code of this product. The job row holds nothing else of the failure.
          const message = `The discovery of a Connection failed: ${reason}`;
          if (FAILURES_NOT_RETRIED.has(reason)) throw new NonRetryableJobError(message, { reason });
          throw new AppError("CONFLICT", message, { reason });
        }
      })
    ]
  };
}
