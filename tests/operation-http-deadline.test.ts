import { afterEach, expect, it, vi } from "vitest";
import type { OperationCallRuntime } from "@work-shape/catalyst-core";
import { change, createServer, errorOf, person } from "./support/operation-server";
import { registeredTestOperations as operations } from "./support/operations";
import { settleOnFakeClock, useFakeClockBesidePostgres } from "./support/fake-clock";

afterEach(() => vi.useRealTimers());

it.each([true, false])(
  "ends an over-long HTTP call before the sweep and replays its stored timeout (honours abort: %s)",
  async (honoursAbort) => {
    const timeoutMs = 5 * 60 * 1000;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let runtime: OperationCallRuntime | undefined;
    let dispatches = 0;
    const { server, runs, auditTypes } = await createServer({
      register: (route) =>
        route.operation(operations.testRunChange, {
          timeoutMs,
          execute: async (item, context) => {
            dispatches += 1;
            runtime = context.runtime;
            if (honoursAbort) runtime.signal?.addEventListener("abort", release, { once: true });
            entered();
            await held;
            return { name: item.name };
          }
        })
    });
    // Start the server before installing the clock; all database work under it is driven.
    await server.call("operations.list_runs", {}, person());
    useFakeClockBesidePostgres();
    const call = () => server.call("testRunChange", change("slow", "ok", "deadline"), person());
    const first = call();
    try {
      await settleOnFakeClock(started);
      const dispatchedAt = Date.now();
      await vi.advanceTimersByTimeAsync(timeoutMs + 123);
      const response = await settleOnFakeClock(first);
      const [stored] = await settleOnFakeClock(runs());
      expect(stored).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
      expect(response.statusCode).toBe(504);
      expect(errorOf(response)).toMatchObject(stored?.error ?? {});
      expect(response.headers["operation-run-id"]).toBe(stored?.id);
      expect(runtime?.signal?.aborted).toBe(true);
      expect(runtime?.deadline?.getTime()).toBeLessThanOrEqual(dispatchedAt + timeoutMs);

      const replay = await settleOnFakeClock(call());
      expect(replay.statusCode).toBe(response.statusCode);
      expect(errorOf(replay)).toMatchObject(stored?.error ?? {});
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.headers["operation-run-id"]).toBe(stored?.id);
      expect(dispatches).toBe(1);

      // An implementation that ignores abort cannot replace the timeout with its late output.
      release();
      await settleOnFakeClock(held);
      expect(await settleOnFakeClock(runs())).toEqual([stored]);
      expect(await settleOnFakeClock(auditTypes(stored?.id ?? ""))).toEqual([
        "operation.authorization_checked:success",
        "operation.failed:failed",
        "operation.started:success"
      ]);
    } finally {
      release();
      await settleOnFakeClock(first);
    }
  }
);
