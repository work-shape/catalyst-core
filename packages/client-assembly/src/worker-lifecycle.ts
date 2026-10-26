import { createLogger } from "./logger";

interface WorkerService {
  runUntilStopped(): Promise<void>;
  stop(input?: { drainMs?: number }): Promise<void>;
  close(): Promise<void>;
}

interface WorkerLifecycleOptions {
  stoppingMessage: string;
  shutdownFailureMessage?: string;
  /** First signal drains for this long; the second stops immediately. */
  drainMs?: number;
  /** Without draining, handle each signal once instead of stopping only once in total. */
  stopOnEachSignal?: boolean;
}

export async function runWorkerUntilStopped(
  service: WorkerService,
  options: WorkerLifecycleOptions
): Promise<void> {
  const drains = options.drainMs !== undefined;
  let signals = 0;
  const stop = (signal: NodeJS.Signals) => {
    signals += 1;
    if (drains ? signals > 2 : !options.stopOnEachSignal && signals > 1) return;
    createLogger().info(
      { signal, ...(drains ? { draining: signals === 1 } : {}) },
      options.stoppingMessage
    );
    const stopping = drains
      ? service.stop(signals === 1 ? { drainMs: options.drainMs } : {})
      : service.stop();
    stopping.catch((error: unknown) => {
      createLogger().error({ error }, options.shutdownFailureMessage ?? "Worker shutdown failed");
      process.exitCode = 1;
    });
  };
  if (drains) {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } else {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  try {
    await service.runUntilStopped();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await service.close();
  }
}
