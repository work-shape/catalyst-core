import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, runWorkerUntilStopped } from "@work-shape/catalyst-client-assembly";
import { deferred } from "./support/assertions";

describe("worker lifecycle", () => {
  let signals: EventEmitter;
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    signals = new EventEmitter();
    exitCode = process.exitCode;
    // Exercise Node's once/on/off semantics without sending signals to the test runner.
    const on = process.on.bind(process);
    const once = process.once.bind(process);
    const off = process.off.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event !== "SIGTERM" && event !== "SIGINT") return on(event, listener);
      signals.on(event, listener);
      return process;
    });
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event !== "SIGTERM" && event !== "SIGINT") return once(event, listener);
      signals.once(event, listener);
      return process;
    });
    vi.spyOn(process, "off").mockImplementation((event, listener) => {
      if (event !== "SIGTERM" && event !== "SIGINT") return off(event, listener);
      signals.off(event, listener);
      return process;
    });
    vi.spyOn(createLogger(), "info").mockImplementation(() => {});
    vi.spyOn(createLogger(), "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  function serviceFixture() {
    const stopped = deferred<void>();
    const service = {
      runUntilStopped: vi.fn(() => stopped.promise),
      stop: vi.fn(async (_input?: { drainMs?: number }) => {}),
      close: vi.fn(async () => {
        expect(signals.listenerCount("SIGTERM")).toBe(0);
        expect(signals.listenerCount("SIGINT")).toBe(0);
      })
    };
    return { service, stopped };
  }

  it.each(["SIGTERM", "SIGINT"])(
    "stops once on %s and closes after the worker ends",
    async (signal) => {
      const { service, stopped } = serviceFixture();
      const running = runWorkerUntilStopped(service, { stoppingMessage: "Worker is stopping" });
      expect(service.runUntilStopped).toHaveBeenCalledOnce();
      signals.emit(signal, signal);
      signals.emit("SIGTERM", "SIGTERM");
      signals.emit("SIGINT", "SIGINT");
      expect(service.stop).toHaveBeenCalledExactlyOnceWith();
      expect(createLogger().info).toHaveBeenCalledExactlyOnceWith({ signal }, "Worker is stopping");
      expect(service.close).not.toHaveBeenCalled();
      stopped.resolve();
      await running;
      expect(service.close).toHaveBeenCalledOnce();
    }
  );

  it("can stop once per signal for the knowledge worker", async () => {
    const { service, stopped } = serviceFixture();
    const running = runWorkerUntilStopped(service, {
      stoppingMessage: "Knowledge worker is stopping",
      stopOnEachSignal: true
    });
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    signals.emit("SIGINT", "SIGINT");
    expect(service.stop.mock.calls).toEqual([[], []]);
    expect(vi.mocked(createLogger().info).mock.calls).toEqual([
      [{ signal: "SIGTERM" }, "Knowledge worker is stopping"],
      [{ signal: "SIGINT" }, "Knowledge worker is stopping"]
    ]);
    stopped.resolve();
    await running;
  });

  it.each([0, 900_000])("waits for the first signal's drain with drainMs %i", async (drainMs) => {
    const { service, stopped } = serviceFixture();
    const drain = deferred<void>();
    service.stop.mockImplementation(async () => {
      await drain.promise;
      stopped.resolve();
    });
    const running = runWorkerUntilStopped(service, {
      stoppingMessage: "Agent run worker is stopping",
      drainMs
    });
    signals.emit("SIGTERM", "SIGTERM");
    expect(service.stop).toHaveBeenCalledExactlyOnceWith({ drainMs });
    expect(createLogger().info).toHaveBeenCalledExactlyOnceWith(
      { signal: "SIGTERM", draining: true },
      "Agent run worker is stopping"
    );
    expect(service.close).not.toHaveBeenCalled();
    drain.resolve();
    await running;
    expect(service.close).toHaveBeenCalledOnce();
  });

  it.each(["SIGTERM", "SIGINT"])("interrupts a pending drain on a second %s", async (second) => {
    const { service, stopped } = serviceFixture();
    const drain = deferred<void>();
    service.stop.mockImplementation(async (input) => {
      if (input?.drainMs !== undefined) await drain.promise;
      else drain.resolve();
      stopped.resolve();
    });
    const running = runWorkerUntilStopped(service, {
      stoppingMessage: "Agent run worker is stopping",
      drainMs: 900_000
    });
    signals.emit("SIGTERM", "SIGTERM");
    expect(service.close).not.toHaveBeenCalled();
    signals.emit(second, second);
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    expect(service.stop.mock.calls).toEqual([[{ drainMs: 900_000 }], [{}]]);
    expect(vi.mocked(createLogger().info).mock.calls).toEqual([
      [{ signal: "SIGTERM", draining: true }, "Agent run worker is stopping"],
      [{ signal: second, draining: false }, "Agent run worker is stopping"]
    ]);
    await running;
    expect(service.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "Knowledge worker shutdown failed"])(
    "logs a failed stop with message %s",
    async (shutdownFailureMessage) => {
      const { service, stopped } = serviceFixture();
      const error = new Error("stop failed");
      service.stop.mockImplementation(async () => {
        stopped.resolve();
        throw error;
      });
      const running = runWorkerUntilStopped(service, {
        stoppingMessage: "Worker is stopping",
        shutdownFailureMessage
      });
      signals.emit("SIGINT", "SIGINT");
      await running;
      expect(process.exitCode).toBe(1);
      expect(createLogger().error).toHaveBeenCalledExactlyOnceWith(
        { error },
        shutdownFailureMessage ?? "Worker shutdown failed"
      );
      expect(service.close).toHaveBeenCalledOnce();
    }
  );

  it("cleans up after a run failure and preserves the rejection", async () => {
    const { service, stopped } = serviceFixture();
    const error = new Error("run failed");
    const running = runWorkerUntilStopped(service, { stoppingMessage: "Worker is stopping" });
    const rejected = expect(running).rejects.toThrow(error);
    stopped.reject(error);
    await rejected;
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it("propagates a close failure after removing the signal handlers", async () => {
    const { service, stopped } = serviceFixture();
    const error = new Error("close failed");
    service.close.mockRejectedValue(error);
    const running = runWorkerUntilStopped(service, { stoppingMessage: "Worker is stopping" });
    const rejected = expect(running).rejects.toThrow(error);
    stopped.resolve();
    await rejected;
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
