import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_MAX_PARALLEL_CALLS,
  ConnectionCallSlots,
  createConnectionOperationSource,
  createConnectionToolSource,
  fingerprintOperation
} from "@vivd-catalyst/connections";
import type {
  ConnectionCatalog,
  ConnectorOperationDescriptor,
  JsonValue
} from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import {
  DEFAULT_LIMITS,
  URL_OF_HOST,
  agentOrigin,
  appOrigin,
  echo,
  fixture,
  lookup,
  operationOf
} from "./support/connection-operations";
import { connection } from "./support/connections";
import { withTestSql } from "./support/test-sql";

// A Connection's accepted operations as operations of the platform, on real rows: who may
// call one, in which order a call goes, and what stops it before an outside system is
// contacted.
//
// Every test here fails without the change: before it no operation `connection.<name>.<op>`
// resolved, so each call below answered NOT_FOUND, no agent was offered a Connection's tool,
// and nothing bounded the calls of one Connection.

afterEach(() => {
  vi.restoreAllMocks();
});
describe("a call of a Connection's operation", () => {
  it("takes one order: resolve, run, right, policy, read again, egress, credential, connector, record", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });

    const outcome = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" });

    expect(outcome.result).toMatchObject({ status: "done", output: { text: "hello" } });
    expect(t.sequence).toEqual([
      "read connection",
      "create run",
      "authorize connection.use",
      "resolve policy",
      "read connection",
      "check egress",
      "resolve credential",
      "execute",
      "record done"
    ]);
    // The connector was handed the validated input and the credential of the Connection.
    expect(t.executed).toEqual([{ operation: "echo", input: { text: "hello" }, secret: t.secret }]);
    // A read of a customer's system leaves a run, every time.
    const [run] = await t.runs();
    expect(await t.runs()).toHaveLength(1);
    expect(run).toMatchObject({
      operation: "connection.crm.echo",
      effect: "reading",
      status: "done",
      actor: { kind: "user", id: t.kai.id },
      origin: { kind: "user" }
    });
  });

  it("validates the input after resolving and before a run exists", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });

    for (const input of [{}, { text: 7 }, { text: "x", further: true }, { text: "x".repeat(41) }]) {
      await expect(t.invoke(t.kai, "connection.crm.echo", input)).rejects.toMatchObject({
        code: "VALIDATION_FAILED"
      });
      expect(t.sequence).toEqual(["read connection"]);
    }
    expect(await t.runs()).toEqual([]);
  });

  it("refuses a person without connection.use before anything is contacted, and names the right", async () => {
    const t = await fixture();
    await t.seed("crm");

    const outcome = await t.invoke(t.lena, "connection.crm.echo", { text: "hello" });

    expect(outcome.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection.use", reason: "no_grant" }
    });
    expect(t.sequence).toEqual([
      "read connection",
      "create run",
      "authorize connection.use",
      "record denied"
    ]);
    expect(t.executed).toEqual([]);
    expect(await t.runs()).toMatchObject([{ status: "denied", actor: { id: t.lena.id } }]);
  });

  it("asks the exposure before the right and the policy: a workflow-only operation files no approval for an App", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [
        operationOf("write", { effect: "changing", exposure: ["workflow"], policy: "approval" })
      ]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });

    const outcome = await t.invoke(
      t.kai,
      "connection.crm.write",
      {},
      { origin: appOrigin, effect: "changing", idempotencyKey: "key-app-1" }
    );

    expect(outcome.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection_exposure:bridge", reason: "no_grant" }
    });
    // Neither the right nor the policy was asked, so nothing could file an approval.
    expect(t.sequence).toEqual(["read connection", "create run", "record denied"]);
    const approvals = await withTestSql(
      (sql) => sql<{ count: number }[]>`select count(*)::int as count from approval_requests`
    );
    expect(approvals).toEqual([{ count: 0 }]);

    // The same operation is in no agent's tool list, and an agent that names it is refused.
    const tools = createConnectionToolSource(t.sourceDeps);
    expect(await tools.describe(["connection.crm.write"], {})).toEqual([]);
    t.state.agentTools.set("assistant", ["connection.crm.write"]);
    const byAgent = await t.invoke(
      t.kai,
      "connection.crm.write",
      {},
      { origin: agentOrigin("connection.crm.write"), effect: "changing" }
    );
    expect(byAgent.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection_exposure:agent" }
    });
    // A person is admitted by any one exposure, and an operation with none by nobody.
    const byPerson = await t.invoke(t.kai, "connection.crm.write", {}, { effect: "changing" });
    expect(byPerson.result).toMatchObject({ status: "pending_approval" });
    expect(t.executed).toEqual([]);
  });

  it("is callable by nobody where the operation has no exposure", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { operations: [operationOf("echo", { exposure: [] })] });
    await t.grant(t.kai.id, "connection.use", { assetId });

    const outcome = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" });

    expect(outcome.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection_exposure:any" }
    });
    expect(t.executed).toEqual([]);
  });

  it("runs an agent's call as one Operation Run for the person, and only for a tool the agent lists", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    const origin = agentOrigin("connection.crm.echo");

    const unlisted = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" }, { origin });
    expect(unlisted.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "agent_tool:connection.crm.echo" }
    });
    expect(t.executed).toEqual([]);

    t.state.agentTools.set("assistant", ["connection.crm.echo"]);
    const outcome = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" }, { origin });

    expect(outcome.result).toMatchObject({ status: "done", output: { text: "hello" } });
    const done = (await t.runs()).filter((run) => run.status === "done");
    expect(done).toMatchObject([
      {
        operation: "connection.crm.echo",
        actor: { kind: "user", id: t.kai.id },
        origin: { kind: "agent", agentName: "assistant", toolName: "connection.crm.echo" }
      }
    ]);
    // The agent's right is the person's: without connection.use the agent reaches nothing.
    const forLena = await t.invoke(t.lena, "connection.crm.echo", { text: "hello" }, { origin });
    expect(forLena.result).toMatchObject({
      status: "denied",
      reason: { action: "connection.use" }
    });
  });

  it("does not let a connection.use grant on one Connection cover another", async () => {
    const t = await fixture();
    const granted = await t.seed("crm");
    await t.seed("erp");
    await t.grant(t.kai.id, "connection.use", { assetId: granted });

    const other = await t.invoke(t.kai, "connection.erp.echo", { text: "hello" });

    expect(other.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "connection.use", reason: "no_grant" }
    });
    expect(t.sequence).toEqual([
      "read connection",
      "create run",
      "authorize connection.use",
      "record denied"
    ]);
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);
    // The same holds for the agent that calls for the person.
    t.state.agentTools.set("assistant", ["connection.erp.echo", "connection.crm.echo"]);
    const byAgent = await t.invoke(
      t.kai,
      "connection.erp.echo",
      { text: "hello" },
      { origin: agentOrigin("connection.erp.echo") }
    );
    expect(byAgent.result).toMatchObject({ status: "denied", reason: { kind: "forbidden" } });
    expect(t.executed).toEqual([]);

    // The grant does what it says on the Connection it names.
    const own = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" });
    expect(own.result).toMatchObject({ status: "done", output: { text: "hello" } });
    expect(t.executed).toMatchObject([{ operation: "echo" }]);
  });

  it("refuses an agent's changing call as policy unless the operation asks for an approval", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [
        operationOf("write", { effect: "changing" }),
        operationOf("echo", { policy: "deny" })
      ]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.agentTools.set("assistant", ["connection.crm.write", "connection.crm.echo"]);

    const changing = await t.invoke(
      t.kai,
      "connection.crm.write",
      {},
      { origin: agentOrigin("connection.crm.write"), effect: "changing" }
    );
    expect(changing.result).toMatchObject({
      status: "denied",
      reason: { kind: "policy", operation: "connection.crm.write" }
    });
    expect(t.sequence).not.toContain("check egress");
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);

    // The policy an operation carries only tightens: `deny` stops a read for everybody.
    const denied = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" });
    expect(denied.result).toMatchObject({ status: "denied", reason: { kind: "policy" } });
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);

    // The person's own changing call is its confirmation and runs.
    const own = await t.invoke(t.kai, "connection.crm.write", { a: 1 }, { effect: "changing" });
    expect(own.result).toMatchObject({ status: "done", output: { a: 1 } });
  });

  it("holds an agent's changing call for an approval where the operation says so", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [operationOf("write", { effect: "changing", policy: "approval" })]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.agentTools.set("assistant", ["connection.crm.write"]);

    const outcome = await t.invoke(
      t.kai,
      "connection.crm.write",
      {},
      { origin: agentOrigin("connection.crm.write"), effect: "changing" }
    );

    expect(outcome.result).toMatchObject({ status: "pending_approval" });
    expect(t.sequence).not.toContain("check egress");
    expect(t.executed).toEqual([]);
  });

  it("refuses each of these in the call, with its reason, before egress, credential and connector", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [operationOf("echo"), operationOf("write", { enabled: false })]
    });
    const offId = await t.seed("off", { enabled: false });
    const typelessId = await t.seed("typeless", { connectorType: "gone" });
    const unreadableId = await t.seed("unreadable");
    await t.stores.connections.putConnectionState({
      clientInstanceId,
      connectionAssetId: unreadableId,
      health: "secret_unreadable"
    });
    for (const id of [assetId, offId, typelessId, unreadableId]) {
      await t.grant(t.kai.id, "connection.use", { assetId: id });
    }

    const refused = [
      ["connection.crm.write", "CONFLICT", "operation_disabled"],
      ["connection.off.echo", "CONFLICT", "connection_unavailable"],
      ["connection.typeless.echo", "CONFLICT", "connection_unavailable"],
      ["connection.unreadable.echo", "CONFLICT", "connection_unavailable"]
    ] as const;
    for (const [operation, code, reason] of refused) {
      const failed = await t.failure(t.invoke(t.kai, operation, { text: "hello" }));
      expect(failed, operation).toMatchObject({ code, reason });
      // The call was authorized and recorded, and then stopped at the second read.
      expect(t.sequence, operation).toEqual([
        "read connection",
        "create run",
        "authorize connection.use",
        "resolve policy",
        "read connection",
        "record failed"
      ]);
      expect(t.executed).toEqual([]);
    }
    // A name no Connection or no accepted operation stands behind is no operation at all.
    for (const name of ["connection.none.echo", "connection.crm.none", "connection.crm"]) {
      await expect(t.invoke(t.kai, name, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(t.executed).toEqual([]);
  });

  it("refuses a call whose Connection changed between the checks and the call", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    // The revision the right and the policy were decided on is replaced before the call reads.
    t.state.beforeSecondRead = async () => {
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
    };

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "hello" }));

    expect(failed.reason).toBe("connection_unavailable");
    expect(t.sequence).not.toContain("check egress");
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);
  });

  it("checks egress before the credential: a refused host resolves none and calls nothing", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.hostAllowed = false;

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "hello" }));

    expect(failed).toMatchObject({ code: "FORBIDDEN", reason: "egress_denied" });
    expect(t.sequence.slice(-2)).toEqual(["check egress", "record failed"]);
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);
  });

  it("answers connection_unavailable, not egress_denied, when the listed host does not resolve", async () => {
    // Fails without the change: the call failed with "egress_denied: ... is not allowed by
    // the instance's egress list" although the host is on the list.
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.hostResolves = false;

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "hello" }));

    expect(failed).toMatchObject({ code: "CONFLICT", reason: "connection_unavailable" });
    expect(failed.message).toMatch(
      /^connection_unavailable: the host [a-z0-9.-]+:443 did not resolve to an address$/u
    );
    // Still refused before anything else: no credential is resolved and nothing is called.
    expect(t.sequence.slice(-2)).toEqual(["check egress", "record failed"]);
    expect(t.sequence).not.toContain("resolve credential");
    expect(t.executed).toEqual([]);
    expect(await t.health(assetId)).toBe("failed");
  });

  it("never validates against, and never tells, a schema nobody accepted", async () => {
    const t = await fixture();
    const changed: ConnectorOperationDescriptor = { ...lookup, description: "Changed outside." };
    const catalogOf = (pinned: Record<string, string>): ConnectionCatalog => ({
      version: 1,
      discoveredAt: "2026-10-01T00:00:00.000Z",
      entries: [{ ...changed, fingerprint: fingerprintOperation(changed) }],
      pinned
    });
    const seedDiscovered = async (name: string, catalog: ConnectionCatalog | undefined) => {
      const assetId = await t.seed(name, {
        connectorType: "discovering",
        operations: [operationOf("lookup")]
      });
      if (catalog) {
        const stored: JsonValue = JSON.parse(JSON.stringify(catalog));
        await t.stores.connections.putConnectionState({
          clientInstanceId,
          connectionAssetId: assetId,
          health: "ok",
          catalog: stored
        });
      }
      await t.grant(t.kai.id, "connection.use", { assetId });
      return assetId;
    };
    await seedDiscovered("review", catalogOf({ lookup: fingerprintOperation(lookup) }));
    await seedDiscovered("unseen", undefined);
    await seedDiscovered("unpinned", catalogOf({}));
    await seedDiscovered("ready", catalogOf({ lookup: fingerprintOperation(changed) }));

    // An input the unaccepted schema would refuse is answered like any other: with the reason
    // of the operation and with no issue that names a field or a rule.
    for (const [name, reason] of [
      ["review", "operation_needs_review"],
      ["unseen", "operation_unknown"],
      ["unpinned", "operation_unknown"]
    ] as const) {
      for (const input of [{ customerNumber: "not a number" }, { anything: 1 }, "text"]) {
        const failed = await t.failure(t.invoke(t.kai, `connection.${name}.lookup`, input));
        expect(failed.reason, name).toBe(reason);
        expect(failed.message).not.toMatch(/customerNumber|pattern|\^C/u);
        expect(t.executed).toEqual([]);
      }
      // A person without the right learns the same nothing: the refusal names the right.
      const stranger = await t.invoke(t.lena, `connection.${name}.lookup`, { anything: 1 });
      expect(stranger.result).toMatchObject({
        status: "denied",
        reason: { action: "connection.use" }
      });
    }
    // No agent is offered one of them, whoever lists it.
    const names = ["review", "unseen", "unpinned", "ready"].map(
      (name) => `connection.${name}.lookup`
    );
    const offered = await createConnectionToolSource(t.sourceDeps).describe(names, {});
    expect(offered.map((tool) => tool.name)).toEqual(["connection.ready.lookup"]);
    expect(offered[0]?.description).toBe("Changed outside.");

    // The accepted one validates: its schema is what every agent that carries it sends.
    await expect(
      t.invoke(t.kai, "connection.ready.lookup", { customerNumber: "nope" })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ready = await t.invoke(t.kai, "connection.ready.lookup", { customerNumber: "C123456" });
    expect(ready.result).toMatchObject({ status: "done" });
  });
});

describe("the parallel calls of one Connection", () => {
  it("lets a ninth call wait for a slot and then answers connection_busy", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    const otherId = await t.seed("erp");
    await t.grant(t.kai.id, "connection.use", { assetId });
    await t.grant(t.kai.id, "connection.use", { assetId: otherId });
    // The shape of the product's bounds, in less time: a call may take longer than a wait.
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 20_000 };
    const held: (() => void)[] = [];
    let running = 0;
    t.setBehaviour(
      (_operation, input) =>
        new Promise((resolve) => {
          running += 1;
          held.push(() => resolve(input));
        })
    );
    const eight = Array.from({ length: CONNECTION_MAX_PARALLEL_CALLS }, (_unused, index) =>
      t.invoke(t.kai, "connection.crm.echo", { text: `call ${index}` })
    );
    await vi.waitFor(() => expect(running).toBe(CONNECTION_MAX_PARALLEL_CALLS), {
      timeout: 10_000
    });

    // The bound is one Connection's. Another has slots of its own while this one is full.
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 300 };
    const other = t.invoke(t.kai, "connection.erp.echo", { text: "other" });
    await vi.waitFor(() => expect(running).toBe(CONNECTION_MAX_PARALLEL_CALLS + 1), {
      timeout: 10_000
    });
    held.pop()?.();
    expect((await other).result).toMatchObject({ status: "done" });
    running -= 1;

    const startedAt = Date.now();
    const ninth = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "ninth" }));
    const waited = Date.now() - startedAt;

    expect(ninth).toMatchObject({ code: "CONFLICT", reason: "connection_busy" });
    expect(waited).toBeGreaterThanOrEqual(290);
    // It never got as far as the egress check, the credential or the connector.
    expect(t.sequence).not.toContain("check egress");
    expect(t.sequence).not.toContain("resolve credential");
    expect(running).toBe(CONNECTION_MAX_PARALLEL_CALLS);

    // A tenth call waits too, and takes the slot of the first call that ends.
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 20_000 };
    const tenth = t.invoke(t.kai, "connection.crm.echo", { text: "tenth" });
    held[0]?.();
    await vi.waitFor(() => expect(running).toBe(CONNECTION_MAX_PARALLEL_CALLS + 1), {
      timeout: 10_000
    });
    for (const release of held) release();
    const outcomes = await Promise.all([...eight, tenth]);
    expect(outcomes.map((outcome) => outcome.result.status)).toEqual(
      Array.from({ length: CONNECTION_MAX_PARALLEL_CALLS + 1 }, () => "done")
    );
    expect(outcomes.at(-1)?.result).toMatchObject({ output: { text: "tenth" } });
    // Eight, the other Connection's, the ninth and the tenth: every one left a run.
    expect(await t.runs()).toHaveLength(CONNECTION_MAX_PARALLEL_CALLS + 3);
  });

  it("hands a freed slot to the call that waited longest and keeps no entry for an idle Connection", async () => {
    const slots = new ConnectionCallSlots();
    const limits = { maxParallelCalls: 2, slotWaitMs: 5_000 };
    const { release: first } = await slots.acquire("a", limits);
    const { release: second } = await slots.acquire("a", limits);
    const order: string[] = [];
    const third = slots.acquire("a", limits).then(({ release }) => (order.push("third"), release));
    const fourth = slots
      .acquire("a", limits)
      .then(({ release }) => (order.push("fourth"), release));
    // Another Connection is not held up.
    (await slots.acquire("b", limits)).release();

    first();
    first();
    const releaseThird = await third;
    expect(order).toEqual(["third"]);
    second();
    const releaseFourth = await fourth;
    releaseThird();
    releaseFourth();

    await expect(slots.acquire("a", { maxParallelCalls: 0, slotWaitMs: 20 })).rejects.toMatchObject(
      {
        details: { reason: "connection_busy" }
      }
    );
  });
});

describe("the names of a Connection's tools", () => {
  it("stay when the display name changes, and are gone when the operation leaves the accepted list", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    const tools = createConnectionToolSource(t.sourceDeps);
    const listed = ["known.tool", "connection.crm.echo"];
    expect(await tools.describe(listed, {})).toEqual([
      {
        name: "connection.crm.echo",
        description: echo.description,
        inputJsonSchema: echo.inputSchema,
        effect: "reading"
      }
    ]);

    await t.seed("crm", { displayName: "Customer system, renamed" });
    expect((await tools.describe(listed, {})).map((tool) => tool.name)).toEqual([
      "connection.crm.echo"
    ]);
    expect((await t.invoke(t.kai, "connection.crm.echo", { text: "a" })).result).toMatchObject({
      status: "done"
    });

    // The operation leaves the accepted list: the agent's name stands for nothing now. The
    // source leaves it out, so a run goes on with the agent's other tools.
    await t.seed("crm", { operations: [operationOf("write", { effect: "changing" })] });
    expect(await tools.describe(listed, {})).toEqual([]);
    await expect(t.invoke(t.kai, "connection.crm.echo", { text: "a" })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("cost an agent without one no read, and an instance without a Connection no operation", async () => {
    const t = await fixture();
    // An instance without a Connection contributes no operation.
    const source = createConnectionOperationSource(t.sourceDeps);
    expect(await source.list({})).toEqual([]);
    await t.seed("crm");
    const listActive = vi.spyOn(t.stores.configAssets, "listActiveConfigAssets");
    const tools = createConnectionToolSource(t.sourceDeps);

    expect(await tools.describe(["known.tool", "second.tool", "connectionless"], {})).toEqual([]);
    expect(listActive).not.toHaveBeenCalled();
    // However many names an agent lists, all Connections are read once.
    await tools.describe(["connection.crm.echo", "connection.erp.echo", "connection.x.y"], {});
    expect(listActive).toHaveBeenCalledTimes(1);

    // A name that is no Connection's costs the operation source no read either.
    const getAsset = vi.spyOn(t.stores.configAssets, "getConfigAsset");
    getAsset.mockClear();
    expect(await source.resolve("known.tool")).toBeUndefined();
    expect(getAsset).not.toHaveBeenCalled();
  });
});
