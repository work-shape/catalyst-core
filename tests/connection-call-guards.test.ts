import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_HEALTH_WRITE_TIMEOUT_MS,
  ConnectionCallSlots,
  callConnectionOperation,
  readConnection
} from "@vivd-catalyst/connections";
import { AppError, connectionCallError, type JsonValue } from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import { connection } from "./support/connections";
import { DEFAULT_LIMITS, URL_OF_HOST, fixture, operationOf } from "./support/connection-operations";

// What a call of a Connection's operation guards against inside `execute`, called the way
// `runOperation` calls it once the right and the policy are decided.

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The call itself, on the Connection as it is stored now. */
async function direct(
  t: Fixture,
  operationName: string,
  input: unknown,
  further: { slots?: ConnectionCallSlots; signal?: AbortSignal } = {}
): Promise<JsonValue> {
  const connection = await readConnection(t.sourceDeps, "crm");
  if (!connection) throw new Error("the Connection is stored");
  t.sequence.length = 0;
  t.executed.length = 0;
  return callConnectionOperation(
    t.sourceDeps,
    further.slots ?? new ConnectionCallSlots(),
    {
      connectionName: "crm",
      operationName,
      assetId: connection.assetId,
      revision: connection.revision
    },
    input,
    { runtime: further.signal ? { signal: further.signal } : {} }
  );
}

/** The reason and the code a refused call carries. */
async function refusal(work: Promise<unknown>): Promise<{ code: string; reason: string }> {
  const error: unknown = await work.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  if (!(error instanceof AppError)) throw new Error(`no refusal: ${String(error)}`);
  return { code: error.code, reason: error.message.split(":")[0] ?? "" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an input the call cannot hand on", () => {
  // Fails without the change: serializing such an input threw a RangeError inside the call,
  // after the slot was taken, and the call ended as an internal error.
  it("is refused as input_invalid before a slot, egress or the credential", async () => {
    const t = await fixture();
    await t.seed("crm", {
      operations: [operationOf("echo"), operationOf("write", { effect: "changing" })]
    });
    let deep: JsonValue = [];
    for (let level = 0; level < 200_000; level += 1) deep = [deep];

    expect(await refusal(direct(t, "write", { deep }))).toMatchObject({ reason: "input_invalid" });
    expect(t.sequence).toEqual(["read connection"]);
    expect(t.executed).toEqual([]);
  });
});

describe("the order inside a call", () => {
  // Fails without the change: the call read the Connection before it waited, so it ran on a
  // revision that was replaced while it stood in line.
  it("reads the Connection again once a call that waited has its slot", async () => {
    const t = await fixture();
    await t.seed("crm");
    t.state.limits = { ...DEFAULT_LIMITS, maxParallelCalls: 1, callTimeoutMs: 20_000 };
    const slots = new ConnectionCallSlots();
    let end: (() => void) | undefined;
    t.setBehaviour((_operation, input) => new Promise((resolve) => (end = () => resolve(input))));
    const running = direct(t, "echo", { text: "first" }, { slots });
    await vi.waitFor(() => expect(end).toBeDefined(), { timeout: 10_000 });

    const connectionRow = await readConnection(t.sourceDeps, "crm");
    const waiting = direct(t, "echo", { text: "second" }, { slots });
    await vi.waitFor(() => expect(slots.waiting(connectionRow?.assetId ?? "")).toBe(1), {
      timeout: 10_000
    });
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "crm",
          config: connection("crm", {
            connectorType: "test",
            settings: { url: URL_OF_HOST },
            operations: [operationOf("echo", { exposure: ["workflow"] })]
          })
        }
      ]
    });
    end?.();

    expect(await refusal(waiting)).toMatchObject({ reason: "connection_unavailable" });
    expect(t.sequence).toEqual(["read connection", "read connection"]);
    expect(t.executed).toEqual([]);
    await running;
  });

  // Fails without the change: the context went on opening after the call had ended, and
  // resolved the credential of a call nobody waited for.
  it("resolves no credential for a call that ended while its target was checked", async () => {
    const t = await fixture();
    await t.seed("crm");
    const stop = new AbortController();
    const check = t.sourceDeps.egress.check.bind(t.sourceDeps.egress);
    vi.spyOn(t.sourceDeps.egress, "check").mockImplementation(async (target) => {
      const grant = await check(target);
      stop.abort();
      return grant;
    });

    const failed = await refusal(direct(t, "echo", { text: "a" }, { signal: stop.signal }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(failed.reason).toBe("upstream_timeout");
    expect(t.sequence).toEqual(["read connection", "check egress"]);
    expect(t.executed).toEqual([]);
  });

  // Fails without the change: `acquire` took no signal, so the waiter of a call its caller
  // had stopped stayed in line until the wait ran out, and was handed a slot nobody used.
  it("takes a stopped call out of the line for a slot at once", async () => {
    const slots = new ConnectionCallSlots();
    const limits = { maxParallelCalls: 1, slotWaitMs: 20_000 };
    const { release } = await slots.acquire("a", limits);
    const stop = new AbortController();
    const stopped = slots.acquire("a", limits, stop.signal);
    const next = slots.acquire("a", limits);
    expect(slots.waiting("a")).toBe(2);

    stop.abort();
    await expect(stopped).rejects.toMatchObject({ details: { reason: "connection_busy" } });
    expect(slots.waiting("a")).toBe(1);
    // The slot goes to the call that still waits, not to the one that left.
    release();
    const { release: releaseNext, waited } = await next;
    expect(waited).toBe(true);
    releaseNext();
    expect(slots.waiting("a")).toBe(0);
    // A call that is stopped already never joins the line.
    await expect(slots.acquire("a", limits, stop.signal)).rejects.toMatchObject({
      details: { reason: "connection_busy" }
    });
  });

  // Fails without the change: the call waited for the write as long as the store took, and
  // held its slot for all of it.
  it("does not hold its slot for a health write the store never answers", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    t.state.limits = { ...DEFAULT_LIMITS, maxParallelCalls: 1 };
    const slots = new ConnectionCallSlots();
    const write = vi
      .spyOn(t.stores.connections, "putConnectionState")
      .mockImplementation(() => new Promise(() => undefined));
    t.setBehaviour(() => Promise.reject(connectionCallError("upstream_unauthorized")));

    const startedAt = Date.now();
    const failed = await refusal(direct(t, "echo", { text: "a" }, { slots }));
    const took = Date.now() - startedAt;

    expect(failed.reason).toBe("upstream_unauthorized");
    expect(write).toHaveBeenCalledTimes(1);
    expect(took).toBeGreaterThanOrEqual(CONNECTION_HEALTH_WRITE_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(CONNECTION_HEALTH_WRITE_TIMEOUT_MS + 1_500);
    // The slot is free again: the next call runs at once.
    write.mockRestore();
    t.setBehaviour((_operation, input) => Promise.resolve(input));
    expect(await direct(t, "echo", { text: "b" }, { slots })).toEqual({ text: "b" });
    expect(slots.waiting(assetId)).toBe(0);
  });
});
