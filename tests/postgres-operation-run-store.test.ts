import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_RUN_ERROR,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
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

    expect((await runs.markExpired({ clientInstanceId, limit: 100 })).map((run) => run.id)).toEqual(
      [overdue]
    );
    expect(await runs.markExpired({ clientInstanceId, limit: 100 })).toEqual([]);
    expect((await runs.get({ clientInstanceId, id: waiting }))?.status).toBe("pending_approval");

    expect(await runs.markInterrupted({ clientInstanceId, id: running.id })).toMatchObject({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR
    });
  });

  // The transitions of a run that waits for an approval. Each fails without the change: the
  // store had no way to take a waiting run, and none to end it.
  const hold = async (
    runs: Awaited<ReturnType<typeof createStore>>,
    overrides: Partial<NewOperationRun> = {},
    expiresAt = "2999-01-01T00:00:00.000Z"
  ) => {
    const run = await runs.create(newRun(overrides));
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
  const decision = (mode: "approved" | "declined", by: string) => ({
    mode,
    by,
    byLabel: by,
    at: new Date().toISOString()
  });

  it("lets one of many takers resume a waiting run, and none a run that waits no more", async () => {
    const runs = await createStore();
    const id = await hold(runs);
    const startedAt = new Date().toISOString();
    const taken = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runs.resume({
          clientInstanceId,
          id,
          startedAt,
          decision: decision("approved", `usr_${index}`)
        })
      )
    );
    const winners = taken.filter((run) => run !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: "running", decision: { mode: "approved" } });
    // The approval request stays named on the run that executes.
    expect(winners[0]?.approvalRequestId).toBe(`apr_${id}`);
    expect((await runs.get({ clientInstanceId, id }))?.decision?.by).toBe(winners[0]?.decision?.by);

    // A run of another instance, an expired run and a declined run cannot be taken.
    const other = asClientInstanceId("other_instance");
    const foreign = await hold(runs);
    expect(
      await runs.resume({
        clientInstanceId: other,
        id: foreign,
        startedAt,
        decision: decision("approved", "x")
      })
    ).toBeUndefined();
    const overdue = await hold(runs, {}, "2020-01-01T00:00:00.000Z");
    await runs.markExpired({ clientInstanceId, limit: 10 });
    expect(
      await runs.resume({
        clientInstanceId,
        id: overdue,
        startedAt,
        decision: decision("approved", "x")
      })
    ).toBeUndefined();
    expect((await runs.get({ clientInstanceId, id: overdue }))?.status).toBe("expired");
  });

  it("ends a waiting run once without executing it, and never a run that was taken", async () => {
    const runs = await createStore();
    const id = await hold(runs);
    const end = {
      status: "denied" as const,
      finishedAt: new Date().toISOString(),
      denial: { kind: "declined" as const, by: "usr_9" },
      error: { code: "DECLINED", message: "Declined" }
    };
    const both = await Promise.all([
      runs.endWaiting({ clientInstanceId, id, end, decision: decision("declined", "usr_9") }),
      runs.endWaiting({ clientInstanceId, id, end, decision: decision("declined", "usr_8") })
    ]);
    expect(both.filter((run) => run !== undefined)).toHaveLength(1);
    expect(await runs.get({ clientInstanceId, id })).toMatchObject({
      status: "denied",
      denial: { kind: "declined" },
      decision: { mode: "declined" }
    });
    expect(
      await runs.resume({
        clientInstanceId,
        id,
        startedAt: new Date().toISOString(),
        decision: decision("approved", "x")
      })
    ).toBeUndefined();

    const taken = await hold(runs);
    await runs.resume({
      clientInstanceId,
      id: taken,
      startedAt: new Date().toISOString(),
      decision: decision("approved", "x")
    });
    expect(await runs.endWaiting({ clientInstanceId, id: taken, end })).toBeUndefined();
    expect((await runs.get({ clientInstanceId, id: taken }))?.status).toBe("running");
  });

  it("marks expired runs oldest first and no more than the limit", async () => {
    const runs = await createStore();
    const first = await hold(runs, {}, "2020-01-01T00:00:00.000Z");
    const second = await hold(runs, {}, "2020-01-02T00:00:00.000Z");
    const third = await hold(runs, {}, "2020-01-03T00:00:00.000Z");
    expect((await runs.markExpired({ clientInstanceId, limit: 2 })).map((run) => run.id)).toEqual([
      first,
      second
    ]);
    expect((await runs.markExpired({ clientInstanceId, limit: 2 })).map((run) => run.id)).toEqual([
      third
    ]);
  });

  it("lists what has been running since before a moment, oldest first", async () => {
    const runs = await createStore();
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const old = await runs.create(newRun({ startedAt: at(120) }));
    const older = await runs.create(newRun({ startedAt: at(180) }));
    await runs.create(newRun({ startedAt: at(1) }));
    const ended = await runs.create(newRun({ startedAt: at(240) }));
    if (!ended) throw new Error("The call must start a run");
    await runs.finish({
      clientInstanceId,
      id: ended.id,
      end: { status: "done", finishedAt: new Date().toISOString() }
    });
    await hold(runs, { startedAt: at(300) });

    const listed = await runs.listRunningSince({
      clientInstanceId,
      startedBefore: at(60),
      limit: 10
    });
    expect(listed.map((run) => run.id)).toEqual([older?.id, old?.id]);
    expect(
      await runs.listRunningSince({ clientInstanceId, startedBefore: at(60), limit: 1 })
    ).toHaveLength(1);
  });

  it("deletes the runs of conversations, and of no conversation only ended and old ones", async () => {
    const runs = await createStore();
    const agent = (conversationId: string) =>
      ({
        kind: "agent",
        agentName: "agent",
        conversationId: asConversationId(conversationId),
        agentRunId: asAgentRunId("run_1"),
        toolCallId: asToolCallId(`call_${serial}`),
        toolName: "items.create"
      }) as const;
    const ofConversation = (id: string) =>
      runs.create(newRun({ origin: agent(id), conversationId: asConversationId(id) }));
    const ofFirst = await ofConversation("conv_1");
    const ofSecond = await ofConversation("conv_2");
    const direct = await runs.create(newRun());
    if (!direct) throw new Error("The call must start a run");
    await runs.finish({
      clientInstanceId,
      id: direct.id,
      end: { status: "done", finishedAt: new Date().toISOString() }
    });
    const stillRunning = await runs.create(newRun());

    expect(
      await runs.deleteOfConversations({
        clientInstanceId,
        conversationIds: [asConversationId("conv_1")]
      })
    ).toBe(1);
    expect(await runs.deleteOfConversations({ clientInstanceId, conversationIds: [] })).toBe(0);
    expect(await runs.get({ clientInstanceId, id: ofFirst?.id ?? "" })).toBeUndefined();

    // Nothing is old enough yet. Then, with no days of retention, what ended goes.
    expect(
      await runs.deleteWithoutConversationOlderThan({ clientInstanceId, days: 30, limit: 100 })
    ).toBe(0);
    expect(
      await runs.deleteWithoutConversationOlderThan({ clientInstanceId, days: 0, limit: 100 })
    ).toBe(1);
    const left = (await runs.list({ clientInstanceId })).map((run) => run.id).sort();
    expect(left).toEqual([ofSecond?.id, stillRunning?.id].sort());
  });
});
