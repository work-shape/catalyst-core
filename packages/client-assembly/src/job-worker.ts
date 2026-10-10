import type {
  ClientInstanceId,
  JobSchedule,
  JobWorker,
  Logger,
  ModuleSnapshot,
  PlatformStores,
  RegisteredJobHandler
} from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";

export interface CreateJobWorkerInput {
  stores: PlatformStores;
  clientInstanceId: ClientInstanceId;
  /** The job kinds this process serves. */
  handlers: readonly RegisteredJobHandler[];
  /** Schedules of kinds this process serves. */
  schedules?: readonly JobSchedule[];
  /** Which modules are on: a kind of a module that is off is not served. */
  modules?: ModuleSnapshot;
  logger: Logger;
}

/**
 * The worker of the one job executor. Every process entry starts its worker through this and
 * stops it on shutdown, which gives back the jobs it still holds.
 */
export function createJobWorker(input: CreateJobWorkerInput): JobWorker {
  return createPostgresJobWorker(input);
}
