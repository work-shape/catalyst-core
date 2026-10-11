import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS,
  CONNECTION_DISCOVERY_MAX_OPERATIONS,
  CONNECTION_DISCOVERY_TIMEOUT_MS,
  fingerprintOperation
} from "@vivd-catalyst/connections";
import { type ConnectorOperationDescriptor } from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import {
  auditEvents,
  discoverDirectly,
  lookup,
  runJobs,
  statuses,
  storedState,
  world
} from "./support/connection-discovery-world";
import { listedOperation } from "./support/discovering-test-connector";
import { dumpDatabaseText, findLeak } from "./support/test-connector";

// What a discovery takes from an outside system, on an assembled instance over real rows. The
// answer of a connector type is untrusted: its count, bytes, time and content are bounded
// before anything of it is stored.

describe("what a discovery takes from an outside system", () => {
  it("leaves out what it cannot check or store, cuts a long description and keeps the rest", async () => {
    const long = "d".repeat(CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS + 500);
    const w = world([
      lookup,
      listedOperation("list", { description: long }),
      // A schema that refers to another document is never fetched and does not compile.
      listedOperation("remote", { inputSchema: { $ref: "https://other.example/schema.json" } }),
      listedOperation("deep", { outputSchema: { $schema: "https://example.test/own-dialect" } }),
      listedOperation("not a name"),
      listedOperation("nul", { description: "a\u0000b" }),
      listedOperation("half", { description: "a\ud83d" }),
      // The second tool of a name is not the one that was accepted.
      listedOperation("lookup", { description: "Another lookup." })
    ]);
    const instance = await w.start();

    expect(await discoverDirectly(w)).toEqual({
      status: "discovered",
      operationCount: 2,
      leftOutCount: 6
    });

    const { catalog } = await storedState(instance);
    expect(required(catalog).entries.map((entry) => entry.name)).toEqual(["lookup", "list"]);
    const stored = required(required(catalog).entries[1]);
    expect(stored.description).toHaveLength(CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS);
    // What is pinned is what is stored: the cut description.
    expect(stored.fingerprint).toBe(
      fingerprintOperation(listedOperation("list", { description: stored.description }))
    );
    expect(await statuses(instance)).toEqual({ lookup: "ready", list: "ready" });
  });

  it("refuses an answer over the bound of count or of bytes and keeps the stored catalog", async () => {
    const w = world();
    const instance = await w.start();
    await runJobs(instance);
    const before = await storedState(instance);

    w.connector.discover = () =>
      Promise.resolve(
        Array.from({ length: CONNECTION_DISCOVERY_MAX_OPERATIONS + 1 }, (_unused, index) =>
          listedOperation(`tool_${index}`)
        )
      );
    expect(await discoverDirectly(w)).toEqual({ status: "failed", reason: "output_invalid" });

    // Twenty tools whose schemas each pass the validator's bound and together pass 4 MiB.
    const heavy = { type: "object", description: "s".repeat(240 * 1024) };
    w.connector.discover = () =>
      Promise.resolve(
        Array.from({ length: 20 }, (_unused, index) =>
          listedOperation(`heavy_${index}`, { inputSchema: heavy })
        )
      );
    expect(await discoverDirectly(w)).toEqual({ status: "failed", reason: "output_invalid" });

    const after = await storedState(instance);
    expect(after.catalog).toEqual(before.catalog);
    expect(after.state).toMatchObject({ lastErrorCode: "output_invalid" });
    expect(await statuses(instance)).toEqual({ lookup: "ready", list: "ready" });
  });

  // Fails without the change: a schema was compiled, and left out where it did not compile,
  // before the bytes of the answer were counted. Such an answer was stored as an empty catalog.
  it("counts the bytes of an answer before it compiles a schema of it", async () => {
    const w = world();
    const instance = await w.start();
    await runJobs(instance);
    const before = await storedState(instance);

    const uncompilable = {
      $schema: "https://example.test/own-dialect",
      description: "s".repeat(240 * 1024)
    };
    w.connector.discover = () =>
      Promise.resolve(
        Array.from({ length: 20 }, (_unused, index) =>
          listedOperation(`heavy_${index}`, { inputSchema: uncompilable })
        )
      );
    expect(await discoverDirectly(w)).toEqual({ status: "failed", reason: "output_invalid" });
    expect((await storedState(instance)).catalog).toEqual(before.catalog);
  });

  // Fails without the change: the deadline ended with the type's answer, so an answer that
  // arrived in time was worked on for as long as it took.
  it("ends under its deadline while it works on an answer that arrived in time", async () => {
    const w = world();
    const instance = await w.start();
    await runJobs(instance);
    const before = await storedState(instance);

    const slow = (name: string): ConnectorOperationDescriptor => ({
      ...listedOperation(name),
      // Reading the operation takes real time, as compiling a large schema does.
      get description() {
        const until = performance.now() + 700;
        while (performance.now() < until);
        return `Reads ${name}.`;
      }
    });
    w.connector.discover = () => Promise.resolve([slow("lookup"), slow("list"), slow("third")]);
    expect(await discoverDirectly(w, undefined, { timeoutMs: 1_000 })).toEqual({
      status: "failed",
      reason: "upstream_timeout"
    });
    expect((await storedState(instance)).catalog).toEqual(before.catalog);
  });

  // Fails without the change: a descriptor that echoed the credential was stored in the clear
  // and its description was sent to the model of every agent that carries the tool.
  it("leaves out an operation that holds the credential and records a fixed code for it", async () => {
    const w = world();
    const instance = await w.start();
    const encoded = Buffer.from(w.token, "utf8").toString("base64");
    w.connector.discover = () =>
      Promise.resolve([
        listedOperation("lookup", { description: `Send the header Bearer ${w.token}.` }),
        listedOperation("list", {
          inputSchema: { type: "object", properties: { key: { const: encoded } } }
        }),
        listedOperation("third")
      ]);

    await runJobs(instance);

    const { state, catalog } = await storedState(instance);
    expect(required(catalog).entries.map((entry) => entry.name)).toEqual(["third"]);
    expect(state).toMatchObject({ health: "ok", lastErrorCode: "output_rejected" });
    expect(await statuses(instance)).toEqual({ lookup: "unknown", list: "unknown" });
    expect(await auditEvents(instance)).toMatchObject([
      {
        type: "connection.discovered",
        metadata: { operationCount: 1, leftOutCount: 2, rejectedCount: 2 }
      }
    ]);
    expect(findLeak(await dumpDatabaseText(), w.token)).toBeUndefined();
  });

  // Fails without the change: every schema of an answer was compiled in one turn of the
  // process, which answered no request for as long as that took.
  it("gives the process a turn before each operation of an answer", async () => {
    const w = world();
    const instance = await w.start();
    const count = CONNECTION_DISCOVERY_MAX_OPERATIONS;
    let turns = 0;
    let counting = true;
    const turn = () => {
      turns += 1;
      if (counting) setImmediate(turn);
    };
    /** The turn of the process in which each operation was first read, in order. */
    const readInTurn: number[] = [];
    w.connector.discover = () =>
      Promise.resolve(
        Array.from({ length: count }, (_unused, index) => ({
          ...listedOperation(`tool_${index}`, {
            // Each schema is its own, so each one is compiled.
            inputSchema: { type: "object", properties: { [`field_${index}`]: { type: "string" } } }
          }),
          get name() {
            readInTurn.push(turns);
            return `tool_${index}`;
          }
        }))
      );
    setImmediate(turn);
    try {
      expect(await discoverDirectly(w)).toMatchObject({
        status: "discovered",
        operationCount: count
      });
    } finally {
      counting = false;
    }
    expect(readInTurn).toHaveLength(count);
    // No two operations were worked on in the same turn.
    expect(new Set(readInTurn).size).toBe(count);
    expect(required((await storedState(instance)).catalog).entries).toHaveLength(count);
  });

  // The deadline itself, on a clock the test moves. Fails without a deadline: the discovery
  // of a type that never answers would never end.
  it("ends after CONNECTION_DISCOVERY_TIMEOUT_MS and not a millisecond before", async () => {
    const w = world();
    const instance = await w.start();
    w.connector.discover = () => new Promise(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let ended = false;
      const discovering = discoverDirectly(w).finally(() => {
        ended = true;
      });
      await expect.poll(() => w.connector.discoveries, { timeout: 10_000 }).toBe(1);

      await vi.advanceTimersByTimeAsync(CONNECTION_DISCOVERY_TIMEOUT_MS - 1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await discovering).toEqual({ status: "failed", reason: "upstream_timeout" });
    } finally {
      vi.useRealTimers();
    }
    expect((await storedState(instance)).state).toMatchObject({
      lastErrorCode: "upstream_timeout"
    });
  });
});
