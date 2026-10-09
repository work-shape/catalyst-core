import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_RUN_ERROR,
  asClientInstanceId,
  createPlatformId,
  type NewOperationRun
} from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";

const clientInstanceId = asClientInstanceId("operation_runs_test");
let serial = 0;

function newRun(overrides: Partial<NewOperationRun> = {}): NewOperationRun {
  serial += 1;
  return {
    id: createPlatformId<"OperationRunId">("oprun"),
    clientInstanceId,
    operation: "items.create",
    effect: "changing",
    actor: { kind: "user", id: "usr_1", label: "One" },
    origin: { kind: "user" },
    inputHash: "a".repeat(64),
    correlationId: `corr_${serial}`,
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

async function createStore() {
  return (await createTestInstance({ postgres: {} })).stores.operationRuns;
}

describe("Postgres operation run store", () => {
  it("hands one of many simultaneous calls with one key the run", async () => {
    const runs = await createStore();
    const created = await Promise.all(
      Array.from({ length: 8 }, () => runs.create(newRun({ idempotencyKey: "key-1" })))
    );
    const started = created.filter((run) => run !== undefined);
    expect(started).toHaveLength(1);
    const held = await runs.findByIdempotencyKey({
      clientInstanceId,
      actor: { kind: "user", id: "usr_1" },
      idempotencyKey: "key-1"
    });
    expect(held?.id).toBe(started[0]?.id);
    expect(await runs.list({ clientInstanceId })).toHaveLength(1);
  });

  it("scopes a key to its actor and its instance, and a run without a key to nothing", async () => {
    const runs = await createStore();
    const other = { kind: "user", id: "usr_2", label: "Two" } as const;
    expect(await runs.create(newRun({ idempotencyKey: "key-1" }))).toBeDefined();
    expect(await runs.create(newRun({ idempotencyKey: "key-1", actor: other }))).toBeDefined();
    expect(
      await runs.create(
        newRun({ idempotencyKey: "key-1", clientInstanceId: asClientInstanceId("other_instance") })
      )
    ).toBeDefined();
    expect(await runs.create(newRun())).toBeDefined();
    expect(await runs.create(newRun())).toBeDefined();
    expect(await runs.create(newRun({ idempotencyKey: "key-1" }))).toBeUndefined();
    expect(await runs.list({ clientInstanceId })).toHaveLength(4);
    expect(
      await runs.findByIdempotencyKey({
        clientInstanceId,
        actor: { kind: "user", id: "usr_3" },
        idempotencyKey: "key-1"
      })
    ).toBeUndefined();
  });

  it("keeps the key of a person and of a service principal with the same id apart", async () => {
    const runs = await createStore();
    const service = { kind: "service_principal", id: "usr_1", label: "Key" } as const;
    const byPerson = await runs.create(newRun({ idempotencyKey: "key-1" }));
    const byService = await runs.create(newRun({ idempotencyKey: "key-1", actor: service }));
    expect(byPerson).toBeDefined();
    expect(byService).toBeDefined();
    expect(byService?.id).not.toBe(byPerson?.id);
    const held = await runs.findByIdempotencyKey({
      clientInstanceId,
      actor: service,
      idempotencyKey: "key-1"
    });
    expect(held?.id).toBe(byService?.id);
  });

  it("never takes an interrupted changing run again, and takes an interrupted read", async () => {
    const runs = await createStore();
    const interrupt = async (run: NewOperationRun) => {
      const started = await runs.create(run);
      if (!started) throw new Error("The call must start a run");
      await runs.markInterrupted({ clientInstanceId, id: started.id });
      return started.id;
    };
    await interrupt(newRun({ idempotencyKey: "change" }));
    expect(await runs.create(newRun({ idempotencyKey: "change" }))).toBeUndefined();

    const read = await interrupt(newRun({ idempotencyKey: "read", effect: "reading" }));
    expect(await runs.create(newRun({ idempotencyKey: "read", effect: "reading" }))).toMatchObject({
      id: read,
      status: "running",
      attempt: 2
    });
  });

  it("never takes a changing run again that failed after its implementation started", async () => {
    const runs = await createStore();
    const first = await runs.create(newRun({ idempotencyKey: "key-1" }));
    if (!first) throw new Error("The first call must start a run");
    await runs.finish({
      clientInstanceId,
      id: first.id,
      end: {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: { code: "UNAVAILABLE", message: "Try again" }
      }
    });
    expect(await runs.create(newRun({ idempotencyKey: "key-1" }))).toBeUndefined();
    expect(await runs.get({ clientInstanceId, id: first.id })).toMatchObject({
      status: "failed",
      attempt: 1
    });
  });

  it("takes a run that failed unexecuted for the next attempt of the same call only", async () => {
    const runs = await createStore();
    const first = await runs.create(newRun({ idempotencyKey: "key-1" }));
    if (!first) throw new Error("The first call must start a run");
    const finishedAt = new Date().toISOString();
    await runs.finish({
      clientInstanceId,
      id: first.id,
      end: {
        status: "failed",
        finishedAt,
        error: { code: "UNAVAILABLE", message: "Try again", unexecuted: true }
      }
    });

    // Another input or another operation under the key is another call.
    expect(
      await runs.create(newRun({ idempotencyKey: "key-1", inputHash: "b".repeat(64) }))
    ).toBeUndefined();
    expect(
      await runs.create(newRun({ idempotencyKey: "key-1", operation: "items.delete" }))
    ).toBeUndefined();

    const second = await runs.create(newRun({ idempotencyKey: "key-1", correlationId: "retry" }));
    expect(second).toMatchObject({
      id: first.id,
      status: "running",
      attempt: 2,
      correlationId: "retry"
    });
    expect(second?.error).toBeUndefined();
    expect(second?.finishedAt).toBeUndefined();

    await runs.finish({
      clientInstanceId,
      id: first.id,
      end: { status: "done", finishedAt, output: { value: { ok: true } } }
    });
    // A run that ended any other way keeps its key for good.
    expect(await runs.create(newRun({ idempotencyKey: "key-1" }))).toBeUndefined();
  });

  it("ends a run once and only inside its own instance", async () => {
    const runs = await createStore();
    const run = await runs.create(newRun());
    if (!run) throw new Error("The call must start a run");
    const finishedAt = new Date().toISOString();
    const denial = { kind: "policy", operation: "items.create" } as const;
    expect(
      await runs.finish({
        clientInstanceId: asClientInstanceId("other_instance"),
        id: run.id,
        end: { status: "done", finishedAt }
      })
    ).toBeUndefined();
    expect(
      await runs.finish({
        clientInstanceId,
        id: run.id,
        end: {
          status: "denied",
          finishedAt,
          error: { code: "POLICY_DENIED", message: "Refused" },
          denial
        }
      })
    ).toMatchObject({
      status: "denied",
      error: { code: "POLICY_DENIED", message: "Refused" },
      denial
    });
    expect(
      await runs.finish({ clientInstanceId, id: run.id, end: { status: "done", finishedAt } })
    ).toBeUndefined();
    expect(await runs.markInterrupted({ clientInstanceId, id: run.id })).toBeUndefined();
    expect((await runs.get({ clientInstanceId, id: run.id }))?.status).toBe("denied");
    expect(
      await runs.get({ clientInstanceId: asClientInstanceId("other_instance"), id: run.id })
    ).toBeUndefined();
  });

  it("expires only the waiting runs whose time has passed, and fails an interrupted one", async () => {
    const runs = await createStore();
    const wait = async (expiresAt: string) => {
      const run = await runs.create(newRun());
      if (!run) throw new Error("The call must start a run");
      await runs.finish({
        clientInstanceId,
        id: run.id,
        end: {
          status: "pending_approval",
          finishedAt: new Date().toISOString(),
          approvalRequestId: `apr_${run.id}`,
          inputRef: `approval_request:apr_${run.id}`,
          expiresAt
        }
      });
      return run.id;
    };
    const overdue = await wait("2020-01-01T00:00:00.000Z");
    const waiting = await wait("2999-01-01T00:00:00.000Z");
    const running = await runs.create(newRun());
    if (!running) throw new Error("The call must start a run");

    expect((await runs.markExpired({ clientInstanceId })).map((run) => run.id)).toEqual([overdue]);
    expect(await runs.markExpired({ clientInstanceId })).toEqual([]);
    expect((await runs.get({ clientInstanceId, id: waiting }))?.status).toBe("pending_approval");

    expect(await runs.markInterrupted({ clientInstanceId, id: running.id })).toMatchObject({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR
    });
  });
});
