import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionCallSlots,
  callConnectionOperation,
  readConnection
} from "@vivd-catalyst/connections";
import { AppError, type JsonValue } from "@vivd-catalyst/core";
import { fixture, operationOf } from "./support/connection-operations";

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
