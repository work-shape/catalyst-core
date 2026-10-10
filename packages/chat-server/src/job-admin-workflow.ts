import {
  AppError,
  auditActorFromIdentity,
  type JobKindSummary,
  type JobListFilters,
  type JobOverview,
  type OperationExecutionContext,
  type RetryJobResult,
  type StorePage
} from "@vivd-catalyst/core";
import { jobRetriesByKind } from "./job-retries";
import type { ChatServerOptions } from "./types";

/** A job as the page shows it: with whether a person may retry it and why it waits. */
export type ListedJob = JobOverview & { retryable: boolean; waitingForModule?: string };

/**
 * What an operator sees and does about background jobs. The caller's right is checked before
 * a method here runs: by the operation's `requires` for the reads, by the operation's own
 * check for the retry.
 */
export class JobAdminWorkflow {
  private readonly retries: ReturnType<typeof jobRetriesByKind>;

  constructor(
    private readonly options: Pick<
      ChatServerOptions,
      "clientInstanceId" | "stores" | "jobRetries" | "modules"
    >
  ) {
    this.retries = jobRetriesByKind(options.jobRetries);
  }

  summary(): Promise<JobKindSummary[]> {
    return this.options.stores.jobs.summarizeByKind({
      clientInstanceId: this.options.clientInstanceId
    });
  }

  async list(filters: JobListFilters, page: StorePage | undefined): Promise<ListedJob[]> {
    const jobs = await this.options.stores.jobs.listOverview({
      clientInstanceId: this.options.clientInstanceId,
      filters,
      page
    });
    return jobs.map((job) => this.listed(job));
  }

  private listed(job: JobOverview): ListedJob {
    // A queued job of a module that is off is not claimed until the module is on again.
    const waitingForModule =
      job.status === "queued" ? this.options.modules.offModuleOf("jobKind", job.kind) : undefined;
    return {
      ...job,
      retryable: (job.status === "failed" || job.status === "dead") && this.retries.has(job.kind),
      ...(waitingForModule === undefined ? {} : { waitingForModule })
    };
  }

  /**
   * Queues a failed or dead job again, puts its subject back into the state the job works
   * from, and records who did it. The job and its subject change together or not at all.
   */
  async retry(
    jobId: string,
    {
      actor,
      correlationId,
      audit: auditRecorder
    }: Pick<OperationExecutionContext, "actor" | "correlationId" | "audit">
  ): Promise<ListedJob> {
    const { clientInstanceId, stores } = this.options;
    const job = await stores.transaction(async (tx) => {
      const result = await tx.jobs.retry({ clientInstanceId, id: jobId });
      if (result.outcome !== "requeued") throw retryRefusal(result);
      // A refusal from here on rolls the job back to how it ended.
      const { kind, subject } = result.job;
      const retry = this.retries.get(kind);
      if (!retry)
        throw new AppError("CONFLICT", "Jobs of this kind are not retried by hand", {
          reason: "kind_not_retried"
        });
      if (
        retry.restoreSubject &&
        !(await retry.restoreSubject({ clientInstanceId, kind, subject }, tx))
      )
        throw new AppError("CONFLICT", "What the job worked on can no longer be worked on", {
          reason: "subject_not_restorable"
        });
      return result.job;
    });
    await auditRecorder.record({
      type: "job.retried",
      status: "success",
      actor: auditActorFromIdentity(actor),
      subject: job.id,
      correlationId,
      metadata: { kind: job.kind }
    });
    return this.listed(job);
  }
}

function retryRefusal(result: Exclude<RetryJobResult, { outcome: "requeued" }>): AppError {
  switch (result.outcome) {
    case "not_found":
      return new AppError("NOT_FOUND", "Job not found");
    case "not_ended":
      return new AppError("CONFLICT", "Only a failed or dead job can be retried", {
        status: result.status
      });
    case "superseded":
      return new AppError(
        "CONFLICT",
        "A newer job for the same subject is already queued or running",
        { reason: "superseded" }
      );
  }
}
