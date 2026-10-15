import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS,
  CONNECTION_DISCOVERY_MAX_OPERATIONS,
  CONNECTION_DISCOVERY_TIMEOUT_MS,
  OUTSIDE_SCHEMA_MAX_PATTERNS,
  OUTSIDE_SCHEMA_MAX_REFS,
  OUTSIDE_SCHEMA_PATTERN_MAX_CHARS,
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
      leftOutCount: 6,
      // The two whose schema no thread compiles are counted by the code of that.
      schemaRefusedCount: 2,
      schemaRefusal: "schema_uncompilable"
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

  // Fails without the change: an operation was compiled before the ones after it were
  // measured, so an answer over the bound cost the time of its schemas before it was refused.
  it("measures the whole answer before it compiles its first schema", async () => {
    const w = world();
    const instance = await w.start();
    let reads = 0;
    const first = listedOperation("first", {
      inputSchema: {
        type: "object",
        get properties() {
          reads += 1;
          return { field: { type: "string" } };
        }
      }
    });
    const heavy = { type: "object", description: "s".repeat(240 * 1024) };
    w.connector.discover = () =>
      Promise.resolve([
        first,
        ...Array.from({ length: 20 }, (_unused, index) =>
          listedOperation(`heavy_${index}`, { inputSchema: heavy })
        )
      ]);

    expect(await discoverDirectly(w)).toEqual({ status: "failed", reason: "output_invalid" });
    // Read to be measured, and never again to be compiled.
    expect(reads).toBe(1);
    expect((await storedState(instance)).catalog).toBeUndefined();
  });

  // Fails without the change: a text was counted by its characters, so an answer whose JSON
  // is twice that, each quote written as two bytes, was stored at well over the bound.
  it("counts an answer by the bytes it is stored as, escapes included", async () => {
    const w = world();
    const instance = await w.start();
    // 100 KiB of quotes are 200 KiB of JSON: under the validator's bound for one schema.
    const escaped = { type: "object", description: '"'.repeat(100 * 1024) };
    const answer = (count: number) => () =>
      Promise.resolve(
        Array.from({ length: count }, (_unused, index) =>
          listedOperation(`quoted_${index}`, { inputSchema: escaped })
        )
      );

    // 2.2 MiB of characters, 4.3 MiB as stored.
    w.connector.discover = answer(22);
    expect(await discoverDirectly(w)).toEqual({ status: "failed", reason: "output_invalid" });
    expect((await storedState(instance)).catalog).toBeUndefined();

    // Under the bound as stored, the same operations are taken.
    w.connector.discover = answer(20);
    expect(await discoverDirectly(w)).toMatchObject({ status: "discovered", operationCount: 20 });
    const stored = JSON.stringify(required((await storedState(instance)).catalog).entries);
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024 + 64 * 1024);
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
        status: "success",
        reason: "output_rejected",
        metadata: { operationCount: 1, leftOutCount: 2, rejectedCount: 2 }
      }
    ]);
    expect(findLeak(await dumpDatabaseText(), w.token)).toBeUndefined();
  });

  // Fails without the change: nothing counted the `$ref` or the expressions of a listed
  // schema, such an operation was registered, and nothing named why another was left out.
  it("refuses a schema over a bound at the discovery, by a named code", async () => {
    const w = world();
    const instance = await w.start();
    const expressions = Object.fromEntries(
      Array.from({ length: OUTSIDE_SCHEMA_MAX_PATTERNS + 1 }, (_unused, index) => [
        `field_${index}`,
        { type: "string", pattern: "^a$" }
      ])
    );
    const references = Object.fromEntries(
      Array.from({ length: OUTSIDE_SCHEMA_MAX_REFS + 1 }, (_unused, index) => [
        `field_${index}`,
        { $ref: "#/$defs/text" }
      ])
    );
    w.connector.discover = () =>
      Promise.resolve([
        listedOperation("lookup", {
          inputSchema: { type: "object", properties: expressions }
        }),
        listedOperation("list", {
          outputSchema: {
            $defs: { text: { type: "string" } },
            type: "object",
            properties: references
          }
        }),
        listedOperation("long", {
          inputSchema: {
            type: "string",
            pattern: "a".repeat(OUTSIDE_SCHEMA_PATTERN_MAX_CHARS + 1)
          }
        }),
        listedOperation("third")
      ]);

    await runJobs(instance);

    const { state, catalog } = await storedState(instance);
    expect(required(catalog).entries.map((entry) => entry.name)).toEqual(["third"]);
    // The code of the first one refused, on the Connection and in the event. No schema.
    expect(state).toMatchObject({ health: "ok", lastErrorCode: "schema_too_many_patterns" });
    expect(await statuses(instance)).toEqual({ lookup: "unknown", list: "unknown" });
    const audited = await auditEvents(instance);
    expect(audited).toMatchObject([
      {
        type: "connection.discovered",
        status: "success",
        reason: "schema_too_many_patterns",
        metadata: { operationCount: 1, leftOutCount: 3, rejectedCount: 0, schemaRefusedCount: 3 }
      }
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/field_|\^a\$/u);
  });

  it("gives the process a turn before each operation of an answer", async () => {
    const w = world();
    const instance = await w.start();
    const count = CONNECTION_DISCOVERY_MAX_OPERATIONS;
    let completedChecks = 0;
    const startedAfter: number[] = [];
    w.connector.discover = () =>
      Promise.resolve(
        Array.from({ length: count }, (_unused, index) => listedOperation(`tool_${index}`))
      );

    expect(
      await discoverDirectly(w, undefined, {
        schemaChecker: {
          check: () => Promise.resolve([]),
          close: () => Promise.resolve(),
          async refusalOf() {
            startedAfter.push(completedChecks);
            // A worker reply yields, but two replies can precede a setImmediate counter's
            // next tick. Control each reply instead: discovery must await this turn before
            // it starts the next operation, even when the runner is busy.
            await new Promise<void>((resolve) => setImmediate(resolve));
            completedChecks += 1;
            return undefined;
          }
        }
      })
    ).toMatchObject({ status: "discovered", operationCount: count });
    expect(startedAfter).toEqual(Array.from({ length: count }, (_unused, index) => index));
    expect(completedChecks).toBe(count);
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
