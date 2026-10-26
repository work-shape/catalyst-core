import { setTimeout } from "node:timers/promises";
import {
  AppError,
  JOB_WORKER_SILENT_MS,
  KNOWLEDGE_JOB_KINDS,
  type JobWorker
} from "@work-shape/catalyst-core";
import { registerModuleOperations } from "@work-shape/catalyst-server";
import { createClientInstanceExecutionAssembly, type CreateClientInstanceAppInput } from "./app";
import { readClientInstanceEnv } from "./env";
import { createJobWorker } from "./job-worker";
import { createLogger } from "./logger";

/** Keeps ingestion's platform connections below the operated server's connection budget. */
const DEFAULT_KNOWLEDGE_WORKER_POOL_SIZE = 6;
/** A deploy fails promptly if the new process never reports, instead of accepting a crash loop. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1_000;

export type { KnowledgeWorkerPlacement } from "./knowledge";

export type CreateClientInstanceKnowledgeWorkerInput = Omit<
  CreateClientInstanceAppInput,
  "agentRunWorker" | "allowedOrigins"
>;

export interface ClientInstanceKnowledgeWorker {
  readonly worker: JobWorker;
  runUntilStopped(): Promise<void>;
  /** Stops claiming and gives active jobs back through the executor's 20 second grace. */
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceKnowledgeWorker(
  input: CreateClientInstanceKnowledgeWorkerInput
): Promise<ClientInstanceKnowledgeWorker> {
  return createKnowledgeService(input);
}

async function createKnowledgeService(input: CreateClientInstanceKnowledgeWorkerInput) {
  if (input.knowledgeWorker !== "separate") {
    throw new AppError(
      "VALIDATION_FAILED",
      'The knowledge worker requires knowledgeWorker: "separate" in defineClientInstance'
    );
  }
  const env = readClientInstanceEnv(input.env);
  const rawPoolSize = env.KNOWLEDGE_WORKER_POOL_SIZE;
  const poolSize =
    rawPoolSize === undefined ? DEFAULT_KNOWLEDGE_WORKER_POOL_SIZE : Number(rawPoolSize);
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "KNOWLEDGE_WORKER_POOL_SIZE must be a positive integer"
    );
  }
  const execution = await createClientInstanceExecutionAssembly(input, { poolSize });
  registerModuleOperations(execution.operationCalls.registry, execution.modulesStarted.routes);
  const kinds = new Set<string>(Object.values(KNOWLEDGE_JOB_KINDS));
  const worker = createJobWorker({
    stores: execution.store,
    clientInstanceId: execution.clientInstanceId,
    workerId: env.KNOWLEDGE_WORKER_ID,
    logger: execution.logger,
    modules: execution.modules,
    handlers: execution.modulesStarted.jobHandlers.filter((handler) =>
      kinds.has(handler.kind.kind)
    ),
    schedules: execution.modulesStarted.schedules.filter((schedule) =>
      kinds.has(schedule.kind.kind)
    )
  });
  let stopped: (() => void) | undefined;
  const untilStopped = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  return {
    worker,
    runUntilStopped() {
      worker.start();
      return untilStopped;
    },
    async stop() {
      try {
        await worker.stop();
      } finally {
        stopped?.();
      }
    },
    async close() {
      try {
        await worker.stop();
        await execution.close();
      } finally {
        stopped?.();
      }
    },
    async waitUntilReporting() {
      if (!execution.modules.isEnabled("knowledge")) {
        execution.logger.info("Knowledge module is off; no ingestion worker report is required");
        return;
      }
      // After the old container has stopped, only the new release can report after this check.
      const since = Date.now();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      do {
        const activity = await execution.store.jobs.readKindActivity({
          clientInstanceId: execution.clientInstanceId,
          kind: KNOWLEDGE_JOB_KINDS.index
        });
        const seen = activity.report && Date.parse(activity.report.seenAt);
        if (seen !== undefined && seen >= since && Date.now() - seen < JOB_WORKER_SILENT_MS) return;
        await setTimeout(READY_POLL_MS);
      } while (Date.now() < deadline);
      throw new AppError(
        "INTERNAL",
        "The new knowledge worker did not report knowledge_base.index within 60 seconds"
      );
    }
  };
}

export async function runClientInstanceKnowledgeWorker(
  input: CreateClientInstanceKnowledgeWorkerInput
): Promise<void> {
  const service = await createKnowledgeService(input);
  if (process.argv.includes("--check-ready")) {
    try {
      await service.waitUntilReporting();
    } finally {
      await service.close();
    }
    return;
  }
  const stop = (signal: NodeJS.Signals) => {
    createLogger().info({ signal }, "Knowledge worker is stopping");
    service.stop().catch((error: unknown) => {
      createLogger().error({ error }, "Knowledge worker shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await service.runUntilStopped();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await service.close();
  }
}
