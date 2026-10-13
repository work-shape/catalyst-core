import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionCallSlots,
  JSON_SCHEMA_MAX_BYTES,
  JSON_SCHEMA_MAX_DEPTH,
  JSON_SCHEMA_WORKER_ROLE,
  OUTSIDE_SCHEMA_MAX_PATTERNS,
  OUTSIDE_SCHEMA_MAX_REFS,
  OUTSIDE_SCHEMA_PATTERN_MAX_CHARS,
  callConnectionOperation,
  compileJsonSchema,
  createOutsideSchemaChecker,
  fingerprintOperation,
  measureOutsideJsonSchema,
  outsideJsonSchemaAsZod,
  readConnection,
  type JsonSchemaCheckAnswer,
  type JsonSchemaCheckRequest,
  type JsonSchemaWorkerData,
  type OutsideSchemaChecker
} from "@vivd-catalyst/connections";
import {
  connectionCallReasonOf,
  type ConnectionCatalog,
  type ConnectorOperationDescriptor,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import { required } from "./support/assertions";
import { fixture, operationOf } from "./support/connection-operations";

// A schema an outside system wrote is compiled and used in a worker thread with a deadline.
//
// Every test of the first two groups fails without the change: before it the schema was
// compiled and the value checked where requests are served, so the pattern below held the
// process for as long as the expression backtracks, which for this input is longer than
// anyone waits, and nothing else was answered meanwhile.

const started = vi.hoisted((): { workers: { terminate(): Promise<number> }[] } => ({
  workers: []
}));
vi.mock("node:worker_threads", async (original) => {
  const real = await original<typeof import("node:worker_threads")>();
  class Recorded extends real.Worker {
    constructor(...parameters: ConstructorParameters<typeof real.Worker>) {
      super(...parameters);
      started.workers.push(this);
    }
  }
  return { ...real, Worker: Recorded };
});

/** An expression that backtracks without end on a text of `a` that ends otherwise. */
const STALLING: JsonObject = { type: "string", pattern: "^(a+)+$" };
/** What it never finishes with: two to the power of forty ways to split the text. */
const STALLS_ON = `${"a".repeat(40)}!`;
const ORDINARY: JsonObject = {
  type: "object",
  properties: {
    customerNumber: { type: "string", pattern: "^C[0-9]{6}$" },
    months: { type: "array", items: { type: "integer", minimum: 1, maximum: 12 }, maxItems: 12 }
  },
  required: ["customerNumber"],
  additionalProperties: false
};
const FITS = JSON.stringify({ customerNumber: "C123456", months: [1, 2, 3] });

const checkers: OutsideSchemaChecker[] = [];
function checker(options: Parameters<typeof createOutsideSchemaChecker>[0] = {}) {
  const made = createOutsideSchemaChecker(options);
  checkers.push(made);
  return made;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(checkers.splice(0).map((made) => made.close()));
  started.workers.length = 0;
});

const reasonOf = (work: Promise<unknown>) =>
  work.then(
    () => "answered",
    (error: unknown) => connectionCallReasonOf(error) ?? "another error"
  );

/** The longest the loop of this thread went without a turn while `work` ran, in milliseconds. */
async function longestStall(work: Promise<unknown>): Promise<number> {
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await work;
  } finally {
    clearInterval(timer);
  }
  return longest;
}

describe("a check by a schema an outside system wrote", () => {
  it("is cut off at the deadline while a second check and this thread go on", async () => {
    const checks = checker({ timeoutMs: 400 });
    // The thread is started and holds the validator before the clock of the test runs.
    expect(await checks.check(ORDINARY, FITS)).toEqual([]);

    const began = performance.now();
    const stalled = reasonOf(checks.check(STALLING, JSON.stringify(STALLS_ON)));
    const second = checks.check(ORDINARY, FITS).then((issues) => ({
      issues,
      afterMs: performance.now() - began
    }));
    const stall = await longestStall(stalled);

    expect(await stalled).toBe("schema_check_timeout");
    const cutOffAfterMs = performance.now() - began;
    expect(cutOffAfterMs).toBeGreaterThanOrEqual(390);
    expect(cutOffAfterMs).toBeLessThan(2_000);
    // The second check was answered before the first was cut off, by the other thread. A
    // fixed limit below the deadline failed on a loaded runner; one thread would answer it
    // only after the cut-off.
    const answered = await second;
    expect(answered.issues).toEqual([]);
    expect(answered.afterMs).toBeLessThan(cutOffAfterMs);
    // And the thread that serves requests never waited for either.
    expect(stall).toBeLessThan(200);
    // The thread that was stopped is replaced: the same schema checks a short text at once.
    const again = checker({ timeoutMs: 400 });
    expect(await again.check(STALLING, JSON.stringify("aaa"))).toEqual([]);
  });

  it("refuses a schema that passed the deadline without a new check while it cools off", async () => {
    const checks = checker({ timeoutMs: 200, threads: 1 });
    expect(await reasonOf(checks.check(STALLING, JSON.stringify(STALLS_ON)))).toBe(
      "schema_check_timeout"
    );
    const threads = started.workers.length;

    const began = performance.now();
    expect(await reasonOf(checks.check(STALLING, JSON.stringify("aaa")))).toBe(
      "schema_check_timeout"
    );
    expect(performance.now() - began).toBeLessThan(50);
    // No thread was started for it, and another schema is checked as ever.
    expect(started.workers).toHaveLength(threads);
    expect(await checks.check(ORDINARY, FITS)).toEqual([]);

    const forgiving = checker({ timeoutMs: 200, threads: 1, slowCoolOffMs: 0 });
    await reasonOf(forgiving.check(STALLING, JSON.stringify(STALLS_ON)));
    expect(await forgiving.check(STALLING, JSON.stringify("aaa"))).toEqual([]);
  });

  it("answers what the validator of this thread answers", async () => {
    const checks = checker();
    const local = compileJsonSchema(ORDINARY);
    if (!local.ok) throw new Error("the schema compiles");
    for (const value of [
      { customerNumber: "C123456" },
      { customerNumber: "nope" },
      { customerNumber: "C123456", months: [13] },
      { other: 1 },
      "text",
      null
    ]) {
      expect(await checks.check(ORDINARY, JSON.stringify(value)), JSON.stringify(value)).toEqual(
        local.validate(value)
      );
    }
    // A schema that does not compile is an answer, with or without a value.
    const remote: JsonObject = { $ref: "https://schemas.example.test/input.json" };
    expect(await checks.check(remote, "{}")).toBe("uncompilable");
    expect(await checks.refusalOf(remote)).toBe("schema_uncompilable");
    expect(await checks.refusalOf({ type: "string", pattern: "(" })).toBe("schema_uncompilable");
    expect(await checks.refusalOf(ORDINARY)).toBeUndefined();
  });

  it("costs an ordinary check well under a millisecond more than checking it here", async () => {
    const checks = checker();
    const local = compileJsonSchema(ORDINARY);
    if (!local.ok) throw new Error("the schema compiles");
    const value: JsonValue = JSON.parse(FITS);
    await checks.check(ORDINARY, FITS);
    const rounds = 2_000;

    const hereBegan = performance.now();
    for (let round = 0; round < rounds; round += 1) local.validate(value);
    const hereMs = (performance.now() - hereBegan) / rounds;

    const threadBegan = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      // The JSON of the value is made per call, as a call makes it.
      await checks.check(ORDINARY, JSON.stringify(value));
    }
    const threadMs = (performance.now() - threadBegan) / rounds;

    // Measured on the build machine: about 0.0005 ms here and about 0.03 ms through the
    // thread. The bound leaves room for a machine under load.
    expect(threadMs - hereMs).toBeLessThan(2);
    if (process.env.SCHEMA_CHECK_MEASURE) {
      process.stderr.write(
        `schema check: here ${hereMs.toFixed(4)} ms, thread ${threadMs.toFixed(4)} ms\n`
      );
    }
  });

  it("survives a thread that ends under a check", async () => {
    const checks = checker({ timeoutMs: 10_000, threads: 1 });
    expect(await checks.check(ORDINARY, FITS)).toEqual([]);
    expect(started.workers).toHaveLength(1);

    const lost = reasonOf(checks.check(STALLING, JSON.stringify(STALLS_ON)));
    const waiting = checks.check(ORDINARY, FITS);
    // The thread ends as one that ran out of memory does: without an answer.
    await required(started.workers[0]).terminate();

    expect(await lost).toBe("schema_check_unavailable");
    // The check that waited behind it is taken by a new thread, and so is every later one.
    expect(await waiting).toEqual([]);
    expect(started.workers).toHaveLength(2);
    expect(await checks.check(ORDINARY, JSON.stringify({ other: 1 }))).not.toEqual([]);
  });

  // Fails without the change to where the thread is told not to hold the process: a thread
  // that waited for its next check kept a process running that had nothing else to do.
  it("does not keep the process running while its threads wait", async () => {
    const held = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length;
    const before = held();
    const checks = checker();
    expect(await checks.check(ORDINARY, FITS)).toEqual([]);
    expect(started.workers).toHaveLength(1);

    expect(held()).toBe(before);
  });

  it("refuses at once what it has no room for, and everything once it is closed", async () => {
    const checks = checker({ timeoutMs: 300, threads: 1, maxWaiting: 1, slowCoolOffMs: 0 });
    await checks.check(ORDINARY, FITS);
    const running = reasonOf(checks.check(STALLING, JSON.stringify(STALLS_ON)));
    const waits = checks.check(ORDINARY, FITS);
    // One runs and one waits. A third has no place.
    expect(await reasonOf(checks.check(ORDINARY, FITS))).toBe("schema_check_unavailable");
    expect(await running).toBe("schema_check_timeout");
    expect(await waits).toEqual([]);

    await checks.close();
    expect(await reasonOf(checks.check(ORDINARY, FITS))).toBe("schema_check_unavailable");
  });

  it("keeps no more compiled schemas in a thread than its bound", async () => {
    // The thread itself, spoken to as the checker speaks to it, with room for two schemas.
    const data: JsonSchemaWorkerData = { role: JSON_SCHEMA_WORKER_ROLE, cacheMaxEntries: 2 };
    const thread = new Worker(
      new URL("../packages/connections/src/json-schema.ts", import.meta.url),
      { workerData: data }
    );
    const answers: JsonSchemaCheckAnswer[] = [];
    let arrived: (() => void) | undefined;
    thread.on("message", (answer: JsonSchemaCheckAnswer) => {
      answers.push(answer);
      arrived?.();
    });
    const ask = async (request: JsonSchemaCheckRequest): Promise<JsonSchemaCheckAnswer> => {
      thread.postMessage(request);
      while (!answers.some((answer) => "id" in answer && answer.id === request.id)) {
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
      return required(answers.find((answer) => "id" in answer && answer.id === request.id));
    };
    const schemaOf = (minimum: number) => JSON.stringify({ type: "integer", minimum });
    try {
      expect((await ask({ id: 1, key: "a", schema: schemaOf(1), value: "0" })).kind).toBe(
        "checked"
      );
      expect(answers[0]).toEqual({ kind: "ready" });
      await ask({ id: 2, key: "b", schema: schemaOf(2) });
      // Both are held: neither needs its schema again. `a` is now the one used last.
      expect(await ask({ id: 3, key: "b", value: "5" })).toEqual({
        kind: "checked",
        id: 3,
        issues: []
      });
      expect((await ask({ id: 4, key: "a", value: "5" })).kind).toBe("checked");
      // A third takes the place of the one used longest ago, which is `b`.
      await ask({ id: 5, key: "c", schema: schemaOf(3) });
      expect(await ask({ id: 6, key: "b", value: "5" })).toEqual({ kind: "missing", id: 6 });
      expect((await ask({ id: 7, key: "a", value: "5" })).kind).toBe("checked");
      expect((await ask({ id: 8, key: "c", value: "5" })).kind).toBe("checked");
    } finally {
      await thread.terminate();
    }

    // The checker sends a dropped schema again without its caller noticing.
    const checks = checker({ threads: 1, cacheMaxEntries: 2 });
    for (let round = 0; round < 3; round += 1) {
      for (const minimum of [1, 2, 3, 4, 5]) {
        expect(await checks.check({ type: "integer", minimum }, "3")).toEqual(
          minimum <= 3 ? [] : [{ path: [], message: `must be >= ${minimum}` }]
        );
      }
    }
  });

  it("measures a schema against its bounds without compiling it", () => {
    const refusalOf = (schema: JsonObject) => {
      const measured = measureOutsideJsonSchema(schema);
      return measured.ok ? undefined : measured.refusal;
    };
    const refs = (count: number): JsonObject => ({
      $defs: { text: { type: "string" } },
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [`p${index}`, { $ref: "#/$defs/text" }])
      )
    });
    const patterns = (count: number): JsonObject => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [
          `p${index}`,
          { type: "string", pattern: "^a$" }
        ])
      )
    });
    const nested = (depth: number): JsonObject => {
      let schema: JsonObject = { type: "string" };
      for (let level = 0; level < depth; level += 1) schema = { items: schema };
      return schema;
    };

    expect(refusalOf(refs(OUTSIDE_SCHEMA_MAX_REFS))).toBeUndefined();
    expect(refusalOf(refs(OUTSIDE_SCHEMA_MAX_REFS + 1))).toBe("schema_too_many_refs");
    expect(refusalOf(patterns(OUTSIDE_SCHEMA_MAX_PATTERNS))).toBeUndefined();
    expect(refusalOf(patterns(OUTSIDE_SCHEMA_MAX_PATTERNS + 1))).toBe("schema_too_many_patterns");
    // The keys of `patternProperties` are expressions too.
    expect(
      refusalOf({
        patternProperties: Object.fromEntries(
          Array.from({ length: OUTSIDE_SCHEMA_MAX_PATTERNS + 1 }, (_unused, index) => [
            `^k${index}$`,
            {}
          ])
        )
      })
    ).toBe("schema_too_many_patterns");
    expect(
      refusalOf({ type: "string", pattern: "a".repeat(OUTSIDE_SCHEMA_PATTERN_MAX_CHARS) })
    ).toBeUndefined();
    expect(
      refusalOf({ type: "string", pattern: "a".repeat(OUTSIDE_SCHEMA_PATTERN_MAX_CHARS + 1) })
    ).toBe("schema_pattern_too_long");
    expect(refusalOf(nested(JSON_SCHEMA_MAX_DEPTH + 1))).toBe("schema_too_deep");
    expect(refusalOf(nested(200_000))).toBe("schema_too_deep");
    expect(refusalOf({ type: "string", description: "d".repeat(JSON_SCHEMA_MAX_BYTES) })).toBe(
      "schema_too_large"
    );
    expect(refusalOf({ type: "object", $async: true })).toBe("schema_uncompilable");
    // A schema of the release is not measured by these bounds: it compiles as before.
    expect(compileJsonSchema(refs(OUTSIDE_SCHEMA_MAX_REFS + 1)).ok).toBe(true);
    expect(compileJsonSchema(patterns(OUTSIDE_SCHEMA_MAX_PATTERNS + 1)).ok).toBe(true);
  });

  it("rejects the parse of an input whose check gave no answer, with the reason", async () => {
    const checks = checker({ timeoutMs: 200 });
    const told: unknown[] = [];
    const schema = outsideJsonSchemaAsZod(STALLING, checks, (reason) => told.push(reason));

    expect((await schema.safeParseAsync("aaa")).success).toBe(true);
    const refused = await schema.safeParseAsync(7);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toMatchObject([{ path: [], message: "must be string" }]);
    expect(told).toEqual([]);

    expect(await reasonOf(schema.safeParseAsync(STALLS_ON))).toBe("schema_check_timeout");
    expect(told).toEqual(["schema_check_timeout"]);
  });
});

describe("a call of an operation an outside system described", () => {
  const slow: ConnectorOperationDescriptor = {
    name: "lookup",
    description: "Looks a customer up.",
    inputSchema: {
      type: "object",
      properties: { customerNumber: STALLING },
      required: ["customerNumber"]
    },
    outputSchema: { type: "object", properties: { note: STALLING } },
    proposedEffect: "reading"
  };

  async function outsideConnection(descriptor: ConnectorOperationDescriptor) {
    const t = await fixture();
    t.sourceDeps.schemaChecker = checker({ timeoutMs: 300, slowCoolOffMs: 0 });
    const catalog: ConnectionCatalog = {
      version: 1,
      discoveredAt: "2026-10-01T00:00:00.000Z",
      entries: [{ ...descriptor, fingerprint: fingerprintOperation(descriptor) }],
      pinned: { lookup: fingerprintOperation(descriptor) }
    };
    const assetId = await t.seed("outside", {
      connectorType: "discovering",
      operations: [operationOf("lookup")]
    });
    const stored: JsonValue = JSON.parse(JSON.stringify(catalog));
    await t.stores.connections.putConnectionState({
      clientInstanceId,
      connectionAssetId: assetId,
      health: "ok",
      catalog: stored
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    // A Connection of the release's own type beside it, which no thread checks.
    const crm = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId: crm });
    return t;
  }

  it("refuses an input whose check stalls and answers a second request meanwhile", async () => {
    const t = await outsideConnection(slow);
    // An input that fits is called as ever.
    const fits = await t.invoke(t.kai, "connection.outside.lookup", { customerNumber: "aaa" });
    expect(fits.result).toMatchObject({ status: "done" });

    const began = performance.now();
    const stalled = reasonOf(
      t.invoke(t.kai, "connection.outside.lookup", { customerNumber: STALLS_ON })
    );
    const health = t.instance.call("health.get").then((response) => ({
      status: response.statusCode,
      afterMs: performance.now() - began
    }));
    const stall = await longestStall(stalled);

    // Refused by name before a run exists, like any input that is not accepted.
    expect(await stalled).toBe("schema_check_timeout");
    expect(performance.now() - began).toBeLessThan(2_000);
    const answered = await health;
    expect(answered.status).toBe(200);
    expect(answered.afterMs).toBeLessThan(250);
    expect(stall).toBeLessThan(200);
    expect(t.executed).toEqual([]);

    // The operation of the release's own type runs beside it, checked where it is called.
    const own = await t.invoke(t.kai, "connection.crm.echo", { text: "hello" });
    expect(own.result).toMatchObject({ status: "done", output: { text: "hello" } });
    await expect(t.invoke(t.kai, "connection.crm.echo", { text: 7 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { issues: [{ path: ["text"], message: "must be string" }] }
    });
  });

  it("refuses inside the call too, and records an answer whose check stalls as failed", async () => {
    const t = await outsideConnection(slow);
    const stored = required(await readConnection(t.sourceDeps, "outside"));
    const target = {
      connectionName: "outside",
      operationName: "lookup",
      assetId: stored.assetId,
      revision: stored.revision
    };
    // The call itself checks the input again and is refused before anything is sent.
    t.executed.length = 0;
    expect(
      await reasonOf(
        callConnectionOperation(
          t.sourceDeps,
          new ConnectionCallSlots(),
          target,
          { customerNumber: STALLS_ON },
          { runtime: {} }
        )
      )
    ).toBe("schema_check_timeout");
    expect(t.executed).toEqual([]);

    // An answer the schema stalls on is discarded, and the run says why.
    t.setBehaviour(() => Promise.resolve({ note: STALLS_ON }));
    const failed = await t.failure(
      t.invoke(t.kai, "connection.outside.lookup", { customerNumber: "aaa" })
    );
    expect(failed).toMatchObject({ code: "TIMEOUT", reason: "schema_check_timeout" });
    expect(failed.message).not.toContain(STALLS_ON);
    expect((await t.runs()).map((run) => run.error?.reason)).toContain("schema_check_timeout");
    // An answer that fits is returned, and one that does not is `output_invalid` as before.
    t.setBehaviour(() => Promise.resolve({ note: "aaa" }));
    const done = await t.invoke(t.kai, "connection.outside.lookup", { customerNumber: "aaa" });
    expect(done.result).toMatchObject({ status: "done", output: { note: "aaa" } });
    t.setBehaviour(() => Promise.resolve({ note: 7 }));
    expect(
      await t.failure(t.invoke(t.kai, "connection.outside.lookup", { customerNumber: "aaa" }))
    ).toMatchObject({ reason: "output_invalid" });
  });

  // Fails without the change: a catalog stored before the bounds of `$ref` and expressions
  // existed made its operation `unknown` without a word, and a call answered NOT_FOUND
  // "does not offer this action", as if the outside system had dropped it.
  it("says which limit a stored schema is over, in the status and in the call", async () => {
    const fields = (count: number, field: JsonObject) =>
      Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [`field_${index}`, field])
      );
    const stored: [string, JsonObject, string][] = [
      [
        "schema_too_many_patterns",
        {
          type: "object",
          properties: fields(OUTSIDE_SCHEMA_MAX_PATTERNS + 1, { type: "string", pattern: "^a$" })
        },
        `at most ${OUTSIDE_SCHEMA_MAX_PATTERNS} text patterns`
      ],
      [
        "schema_too_many_refs",
        {
          $defs: { text: { type: "string" } },
          type: "object",
          properties: fields(OUTSIDE_SCHEMA_MAX_REFS + 1, { $ref: "#/$defs/text" })
        },
        `at most ${OUTSIDE_SCHEMA_MAX_REFS} references`
      ],
      [
        "schema_pattern_too_long",
        {
          type: "object",
          properties: {
            text: { type: "string", pattern: "a".repeat(OUTSIDE_SCHEMA_PATTERN_MAX_CHARS + 1) }
          }
        },
        `at most ${OUTSIDE_SCHEMA_PATTERN_MAX_CHARS.toLocaleString("en-US")} characters`
      ]
    ];
    for (const [reason, inputSchema, limit] of stored) {
      // Every one of them compiled and was callable before the bound existed.
      expect(compileJsonSchema(inputSchema).ok, reason).toBe(true);
      const t = await outsideConnection({ ...slow, inputSchema, outputSchema: { type: "object" } });

      // The operation keeps its entry and its description, and the status names the bound.
      const response = await t.expectOk(t.root.id, "connections.get", {
        params: { name: "outside" }
      });
      expect(response.json()).toMatchObject({
        operations: [
          {
            name: "lookup",
            status: "unknown",
            description: "Looks a customer up.",
            schemaRefusal: reason
          }
        ]
      });

      const failed = await t.failure(t.invoke(t.kai, "connection.outside.lookup", {}));
      expect(failed).toMatchObject({ code: "CONFLICT", reason });
      expect(failed.message, reason).toContain("over a limit of the platform");
      expect(failed.message, reason).toContain(limit);
      expect(t.executed).toEqual([]);
    }
  });

  it("names the field of an input that does not fit, and calls nothing a thread cannot compile", async () => {
    const t = await outsideConnection({
      ...slow,
      inputSchema: {
        type: "object",
        properties: { customerNumber: { type: "string", pattern: "^C[0-9]{6}$" } },
        required: ["customerNumber"],
        additionalProperties: false
      }
    });
    // As for an operation of the release: refused before a run, with the place and the rule.
    await expect(
      t.invoke(t.kai, "connection.outside.lookup", { customerNumber: "x" })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { issues: [{ path: ["customerNumber"] }] }
    });
    expect(t.executed).toEqual([]);

    // A stored descriptor whose output schema no thread compiles: nothing is sent for it.
    const remote = await outsideConnection({
      ...slow,
      inputSchema: { type: "object" },
      outputSchema: { $ref: "https://schemas.example.test/output.json" }
    });
    expect(
      await remote.failure(remote.invoke(remote.kai, "connection.outside.lookup", {}))
    ).toMatchObject({ reason: "operation_unknown" });
    expect(remote.executed).toEqual([]);
  });
});
