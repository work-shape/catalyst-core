import {
  AppError,
  auditActorFromIdentity,
  type JobKindSummary,
  type JobListFilters,
  type JobOverview,
  type OperationExecutionContext,
  type StorePage
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/**
 * What an operator sees and does about background jobs. The caller's right is checked before
 * a method here runs: by the operation's `requires` for the reads, by the operation's own
 * check for the retry.
 */
export class JobAdminWorkflow {
  constructor(private readonly options: Pick<ChatServerOptions, "clientInstanceId" | "stores">) {}

  summary(): Promise<JobKindSummary[]> {
    return this.options.stores.jobs.summarizeByKind({
      clientInstanceId: this.options.clientInstanceId
    });
  }

  list(filters: JobListFilters, page: StorePage | undefined): Promise<JobOverview[]> {
    return this.options.stores.jobs.listOverview({
      clientInstanceId: this.options.clientInstanceId,
      filters,
      page
    });
  }

  /** Queues a failed or dead job again and records who did it. */
  async retry(
    jobId: string,
    {
      actor,
      correlationId,
      audit: auditRecorder
    }: Pick<OperationExecutionContext, "actor" | "correlationId" | "audit">
  ): Promise<JobOverview> {
    const result = await this.options.stores.jobs.retry({
      clientInstanceId: this.options.clientInstanceId,
      id: jobId
    });
    switch (result.outcome) {
      case "not_found":
        throw new AppError("NOT_FOUND", "Job not found");
      case "not_ended":
        throw new AppError("CONFLICT", "Only a failed or dead job can be retried", {
          status: result.status
        });
      case "superseded":
        throw new AppError(
          "CONFLICT",
          "A newer job for the same subject is already queued or running",
          { reason: "superseded" }
        );
      case "requeued":
        await auditRecorder.record({
          type: "job.retried",
          status: "success",
          actor: auditActorFromIdentity(actor),
          subject: result.job.id,
          correlationId,
          metadata: { kind: result.job.kind }
        });
        return result.job;
    }
  }
}
