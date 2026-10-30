import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectionConfigSchema,
  releaseConnectionConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_TRANSIENT_CALL_REASONS,
  connectionCallReasonOf,
  createConnectorTypeRegistry,
  type JsonObject,
  type OperationLimits
} from "@work-shape/catalyst-core";
import {
  ConnectionCallSlots,
  callConnectionOperation,
  createDocumentSourceOpener,
  createFixtureDocumentSource,
  readConnection,
  type ConnectionOperationSourceDeps
} from "@work-shape/catalyst-connections";
import { setupConnectionInstance, connection } from "./support/connections";
import { clientInstanceId } from "./support/access-instance";
import { withTestSql } from "./support/test-sql";
import { deferred } from "./support/assertions";
import { fixture, operationOf } from "./support/connection-operations";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function sourceWorld(limits: OperationLimits) {
  const t = await setupConnectionInstance();
  const source = createFixtureDocumentSource({ secret: "fixture-secret" });
  const assetId = await t.seed("documents", { settings: {}, operations: [], limits });
  const target = {
    protocol: "https",
    host: "fixture.invalid",
    port: 443,
    address: "93.184.216.34",
    family: 4,
    network: "public"
  } as const;
  const deps: ConnectionOperationSourceDeps = {
    stores: t.stores,
    clientInstanceId,
    connectorTypes: createConnectorTypeRegistry([source.connectorType]),
    egress: { admits: () => true, check: async () => target },
    credentials: { resolve: async () => "fixture-secret", resolveSignIn: async () => "unused" },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      }
    }
  };
  const open = (signal: AbortSignal = new AbortController().signal) =>
    createDocumentSourceOpener(deps, new ConnectionCallSlots())("documents", signal);
  return { ...t, source, assetId, open };
}
const boundary = { folderIds: ["approved"] };

describe("Connection source limits (CS-6 acceptance 61)", () => {
  it("keeps source limits in runtime and release schemas and refuses invalid values", () => {
    const limits = { concurrency: 2, perPeriod: { calls: 5, seconds: 60 } };
    expect(connectionConfigSchema.parse(connection("source", { limits })).limits).toEqual(limits);
    expect(
      releaseConnectionConfigSchema.parse({
        connectorType: "box",
        authScheme: "client_credentials",
        limits
      }).limits
    ).toEqual(limits);
    const invalidLimits: JsonObject[] = [
      { concurrency: 0 },
      { perPeriod: { calls: -1, seconds: 1 } },
      { perPeriod: { calls: 1, seconds: 0 } }
    ];
    for (const invalid of invalidLimits) {
      expect(
        connectionConfigSchema.safeParse(connection("source", { limits: invalid })).success
      ).toBe(false);
    }
  });
  it("shares concurrency across independent openers and releases a completed call", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    let unblock = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = t.source.capability.list;
    t.source.capability.list = async (input, context) => {
      started();
      await held;
      return original(input, context);
    };
    const first = await t.open();
    const second = await t.open();
    const running = first.capability.list({ boundary }, first.context);
    await ready;
    try {
      await expect(second.capability.changes({ boundary }, second.context)).rejects.toMatchObject({
        sourceCode: "rate_limited",
        retryAfterMs: expect.any(Number)
      });
    } finally {
      unblock();
      await running;
    }
    await expect(second.capability.changes({ boundary }, second.context)).resolves.toMatchObject({
      kind: "changes"
    });
  });
  it("shares per-period starts across list, changes and fetch, and recovers expired admission state", async () => {
    const t = await sourceWorld({ concurrency: 2, perPeriod: { calls: 2, seconds: 60 } });
    const id = t.source.world.put({
      folderId: "approved",
      name: "source.txt",
      mime: "text/plain",
      bytes: new Uint8Array([65])
    });
    const one = await t.open();
    await one.capability.list({ boundary }, one.context);
    const two = await t.open();
    await two.capability.changes({ boundary }, two.context);
    const three = await t.open();
    const fetch = async () => {
      for await (const _chunk of three.capability.fetch(
        { itemId: id, version: "v1", maxBytes: 10, boundary },
        three.context
      )) {
      }
    };
    await expect(fetch()).rejects.toMatchObject({
      sourceCode: "rate_limited",
      retryAfterMs: expect.any(Number)
    });
    await withTestSql(
      (sql) =>
        sql`update connection_source_calls set expires_at=now()-interval '1 second', active_until=now()-interval '1 second' where connection_asset_id=${t.assetId}`
    );
    const restarted = await t.open();
    await expect(restarted.capability.list({ boundary }, restarted.context)).resolves.toMatchObject(
      { items: [{ id }] }
    );
  });
  it("serializes simultaneous database admissions and recovers a crashed caller's lease", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    const claim = () =>
      t.stores.transaction((stores) =>
        stores.connections.admitSourceCall({
          clientInstanceId,
          connectionAssetId: t.assetId,
          leaseId: randomUUID(),
          leaseMs: 5000,
          limits: { concurrency: 1 }
        })
      );
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    await withTestSql(
      (sql) =>
        sql`update connection_source_calls set active_until=now()-interval '1 second', expires_at=now()-interval '1 second' where connection_asset_id=${t.assetId}`
    );
    await expect(claim()).resolves.toEqual({ admitted: true });
  });
  it("holds a fetch admission until its stream is closed", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    const id = t.source.world.put({
      folderId: "approved",
      name: "source.txt",
      mime: "text/plain",
      bytes: new Uint8Array(2048)
    });
    const first = await t.open();
    const second = await t.open();
    const stream = first.capability
      .fetch({ itemId: id, version: "v1", maxBytes: 3000, boundary }, first.context)
      [Symbol.asyncIterator]();
    await stream.next();
    await expect(second.capability.list({ boundary }, second.context)).rejects.toMatchObject({
      sourceCode: "rate_limited"
    });
    await stream.return?.();
    await expect(second.capability.list({ boundary }, second.context)).resolves.toMatchObject({
      items: [{ id }]
    });
  });
  it("releases admission when a broken adapter's stream creation or close fails", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    t.source.capability.fetch = () => {
      throw new Error("broken adapter");
    };
    const first = await t.open();
    await expect(async () => {
      for await (const _chunk of first.capability.fetch(
        { itemId: "file", version: "1", maxBytes: 10, boundary },
        first.context
      )) {
      }
    }).rejects.toThrow("broken adapter");
    const closing = deferred<void>();
    const cancellation = new AbortController();
    t.source.capability.fetch = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: new Uint8Array([1]) }),
        return: () => {
          closing.resolve();
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        }
      })
    });
    const second = await t.open(cancellation.signal);
    const stream = second.capability
      .fetch({ itemId: "file", version: "1", maxBytes: 10, boundary }, second.context)
      [Symbol.asyncIterator]();
    await stream.next();
    const returned = stream.return?.();
    await closing.promise;
    cancellation.abort();
    await returned;
    const third = await t.open();
    await expect(third.capability.list({ boundary }, third.context)).resolves.toMatchObject({
      items: []
    });
  });
  it("cancels a fetch during admission without dispatching or leaking its admission", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    const cancellation = new AbortController();
    const source = await t.open(cancellation.signal);
    const admitted = deferred<void>();
    const response = deferred<void>();
    const transaction = t.stores.transaction.bind(t.stores);
    t.stores.transaction = async (work) => {
      t.stores.transaction = transaction;
      const result = await transaction(work);
      admitted.resolve();
      await response.promise;
      return result;
    };
    let fetches = 0;
    const fetch = t.source.capability.fetch;
    t.source.capability.fetch = (input, context) => {
      fetches++;
      return fetch(input, context);
    };
    const stream = source.capability
      .fetch({ itemId: "file", version: "1", maxBytes: 10, boundary }, source.context)
      [Symbol.asyncIterator]();
    // Attach the caller's rejection handler before cancelling. The product's internal
    // abort promise must also be handled while the database response is still pending.
    const reading = Promise.allSettled([stream.next()]);
    const reason = new Error("cancelled during source admission");
    try {
      await admitted.promise;
      cancellation.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.resolve();
      expect(await reading).toEqual([{ status: "rejected", reason }]);
      expect(fetches).toBe(0);
    } finally {
      response.resolve();
      t.stores.transaction = transaction;
      await reading;
    }
    const next = await t.open();
    await expect(next.capability.list({ boundary }, next.context)).resolves.toMatchObject({
      items: []
    });
  });
  it("lets a person browse folders on the same limits, and offers no browsing a type lacks", async () => {
    const t = await sourceWorld({ concurrency: 1 });
    const plain = await t.open();
    expect(plain.capability.folders).toBeUndefined();
    let unblock = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.source.capability.folders = async ({ parentId }) => {
      started();
      await held;
      return {
        folder: { id: parentId ?? "top", name: "Top", path: "/" },
        folders: [{ id: "approved", name: "Approved" }]
      };
    };
    const first = await t.open();
    const second = await t.open();
    const browsing = first.capability.folders?.({}, first.context);
    await ready;
    try {
      await expect(second.capability.list({ boundary }, second.context)).rejects.toMatchObject({
        sourceCode: "rate_limited"
      });
    } finally {
      unblock();
    }
    await expect(browsing).resolves.toEqual({
      folder: { id: "top", name: "Top", path: "/" },
      folders: [{ id: "approved", name: "Approved" }]
    });
  });
});

describe("an accepted operation's limits toward its source (EW-13a, acceptance 47)", () => {
  /** A call of `crm` as `runOperation` makes it, through the slots of one process. */
  async function call(t: Fixture, operationName: string, slots: ConnectionCallSlots) {
    const stored = await readConnection(t.sourceDeps, "crm");
    if (!stored) throw new Error("the Connection is stored");
    return callConnectionOperation(
      t.sourceDeps,
      slots,
      {
        connectionName: "crm",
        operationName,
        assetId: stored.assetId,
        revision: stored.revision
      },
      { text: operationName },
      { runtime: {} }
    );
  }

  it("holds concurrency across processes, sends nothing beyond it and leaves other operations free", async () => {
    const t = await fixture();
    await t.seed("crm", {
      operations: [
        operationOf("echo", { limits: { concurrency: 1 } }),
        operationOf("write", { effect: "changing" })
      ]
    });
    const held = deferred<void>();
    let calls = 0;
    t.setBehaviour(async (operation, input) => {
      calls += 1;
      if (operation === "echo" && calls === 1) await held.promise;
      return input;
    });
    // Two processes: each has slots of its own, and only the database sees both.
    const running = call(t, "echo", new ConnectionCallSlots());
    await vi.waitFor(() => expect(calls).toBe(1));
    const refused: unknown = await call(t, "echo", new ConnectionCallSlots()).catch(
      (error: unknown) => error
    );
    expect(refused).toMatchObject({
      code: "RATE_LIMITED",
      details: { reason: "rate_limited", retryAfterSeconds: expect.any(Number) }
    });
    expect(connectionCallReasonOf(refused)).toBe("rate_limited");
    expect(calls).toBe(1);
    // Another operation of the Connection has no limit of its own and is not held up.
    await expect(call(t, "write", new ConnectionCallSlots())).resolves.toEqual({
      text: "write"
    });
    held.resolve();
    await expect(running).resolves.toEqual({ text: "echo" });
    // The room a call held is free once it ended.
    await vi.waitFor(() =>
      expect(call(t, "echo", new ConnectionCallSlots())).resolves.toEqual({ text: "echo" })
    );
  });

  it("counts starts per period, names the seconds until there is room, and refuses every caller retryably", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [operationOf("echo", { limits: { perPeriod: { calls: 2, seconds: 60 } } })]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.setBehaviour(async (_operation, input) => input);
    const slots = new ConnectionCallSlots();
    await call(t, "echo", slots);
    await call(t, "echo", slots);
    const refused: unknown = await call(t, "echo", slots).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "RATE_LIMITED",
      details: { reason: "rate_limited", retryAfterSeconds: expect.any(Number) }
    });
    const { retryAfterSeconds } = z
      .object({ details: z.object({ retryAfterSeconds: z.number() }) })
      .parse(refused).details;
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(CONNECTION_TRANSIENT_CALL_REASONS.has("rate_limited")).toBe(true);
    // A caller other than a Workflow: the run ends rate_limited, with its sentence.
    const outside = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "outside" }));
    expect(outside).toMatchObject({ code: "RATE_LIMITED", reason: "rate_limited" });
    expect(outside.message).toMatch(/Wait a little before trying again/u);
    // The window passed: there is room again.
    await withTestSql(
      (sql) =>
        sql`update connection_source_calls set started_at=now()-interval '2 minutes', active_until=now()-interval '2 minutes', expires_at=now()-interval '1 second' where connection_asset_id=${assetId}`
    );
    await expect(call(t, "echo", slots)).resolves.toEqual({ text: "echo" });
  });
});
