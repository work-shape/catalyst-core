import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  toErrorEnvelope,
  createOperationRegistry,
  createPlatformId,
  dataStoreOperationName,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type JsonObject
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { accessOf } from "./support/access";
import { manifest, refusal, useDataStoreWorld } from "./support/data-store-world";

// A connection lost while a write was being kept: the next change commits, then fails.
const commit = vi.hoisted(() => ({ failsNext: false }));
vi.mock("@work-shape/catalyst-postgres-connector", async (importOriginal) => {
  const original = await importOriginal<typeof import("@work-shape/catalyst-postgres-connector")>();
  return {
    ...original,
    createPostgresExecutor: (
      ...input: Parameters<typeof original.createPostgresExecutor>
    ): ReturnType<typeof original.createPostgresExecutor> => {
      const executor = original.createPostgresExecutor(...input);
      const change: typeof executor.change = async (...call) => {
        const result = await executor.change(...call);
        if (!commit.failsNext) return result;
        commit.failsNext = false;
        throw new original.PostgresExecutorError("unavailable");
      };
      return { ...executor, change };
    }
  };
});

const MARKER = "private-row-value";
const migration = {
  path: "migrations/0001_refusals.sql",
  text: `create table parents (id integer primary key);
    insert into parents values (1);
    create table refusals (
      id integer generated always as identity primary key,
      code uuid, short_text varchar(3), whole integer, amount numeric,
      done boolean, due date, moment timestamptz, period int4range,
      texts text[], wholes integer[], amounts numeric[], flags boolean[], dates date[], moments timestamptz[],
      required integer not null default 1,
      unique_number integer unique,
      parent integer references parents(id)
    );`
};

// A trigger raises the state a database outage or a changed schema would, inside the real write.
const outageMigration = {
  path: "migrations/0002_outages.sql",
  text: `create table outages (id integer primary key, state text, pause integer);
    create function raise_outage() returns trigger language plpgsql as $$
    begin
      perform pg_sleep(coalesce(new.pause, 0));
      raise exception 'private-row-value' using errcode = new.state;
    end $$;
    create trigger outages_raise before insert on outages for each row execute function raise_outage();
    create table codes (id integer primary key, code text unique);
    create table code_uses (id integer primary key, code text references codes(code));
    insert into codes values (1, 'A');
    insert into code_uses values (1, 'A');`
};

describe("ACCEPT-FIX-13 E-1: localized database refusals after confirmation", () => {
  const { db, published, call } = useDataStoreWorld("row_refusals");

  it("names the column and type for every scalar and array refusal, and every constraint refusal, without database codes", async () => {
    const locale = "de";
    const world = await published("types", [manifest(), migration]);
    const registry = createOperationRegistry();
    registry.addSource(world.dataStores.operationSource);
    const actor: AuthenticatedUser = {
      id: "row-refusal-admin",
      externalUserId: "row-refusal-admin",
      displayLabel: "Row refusal admin",
      roles: ["admin"],
      permissionRefs: [],
      authSource: "test",
      clientInstanceId: world.clientInstanceId
    };
    const cases: { column: string; value: JsonObject[string]; de: string }[] = [
      { column: "code", value: MARKER, de: "Text" },
      { column: "whole", value: MARKER, de: "Ganzzahl" },
      { column: "amount", value: MARKER, de: "Zahl" },
      { column: "done", value: MARKER, de: "Ja/Nein" },
      { column: "due", value: "2027-02-31", de: "Datum" },
      { column: "moment", value: MARKER, de: "Datum und Uhrzeit" },
      { column: "period", value: MARKER, de: "Wert" },
      { column: "texts", value: { private: MARKER }, de: "Text, Liste" },
      { column: "wholes", value: [MARKER], de: "Ganzzahl, Liste" },
      { column: "amounts", value: [MARKER], de: "Zahl, Liste" },
      { column: "flags", value: [MARKER], de: "Ja/Nein, Liste" },
      { column: "dates", value: ["2027-02-31"], de: "Datum, Liste" },
      {
        column: "moments",
        value: [MARKER],
        de: "Datum und Uhrzeit, Liste"
      }
    ];
    for (const entry of cases) {
      const outcome = await runOperation(
        {
          operation: "data_store.findings.insert",
          effect: "changing",
          input: { table: "refusals", rows: [{ [entry.column]: entry.value }] },
          actor,
          origin: { kind: "user" },
          correlationId: "row-refusals"
        },
        {
          clientInstanceId: world.clientInstanceId,
          registry,
          runs: db.store.operationRuns,
          authorizer: { forActor: async () => accessOf(actor) },
          resolveResource: async (resource) => ({ resource }),
          events: { emit: async () => ({ outcome: "allow", guardrails: [] }) },
          audit: new NoopAuditRecorder(),
          policy: {
            instanceDefaults: { reading: "allow", changing: "confirm" },
            centralSettings: () => []
          },
          logger: world.logger
        },
        { locale }
      );
      expect(outcome.result, entry.column).toMatchObject({
        status: "failed",
        error: {
          code: "VALIDATION_FAILED",
          message: expect.stringContaining(`(${entry[locale]})`)
        }
      });
      if (outcome.result.status !== "failed") throw new Error("Expected a database refusal");
      expect(outcome.result.error.message).toContain(
        entry.column[0]?.toUpperCase() + entry.column.slice(1)
      );
      expect(JSON.stringify(outcome.result)).not.toMatch(/SQLSTATE|22P02|22008|private-row-value/u);
      const stored = await db.store.operationRuns.get({
        clientInstanceId: world.clientInstanceId,
        id: outcome.run.id
      });
      expect(stored?.error).toMatchObject({ message: outcome.result.error.message });
      expect(JSON.stringify(stored?.error)).not.toContain(MARKER);
    }
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from refusals" })
    ).toMatchObject({ rows: [{ count: 0 }] });

    await call(world, "insert", { table: "refusals", rows: [{ unique_number: 1, parent: 1 }] });
    const constraints = [
      { row: { required: null }, field: "Required", type: "Ganzzahl", reason: "erforderlich" },
      {
        row: { unique_number: 1 },
        field: "Unique number",
        type: "Ganzzahl",
        reason: "bereits vorhanden"
      },
      {
        row: { parent: 2 },
        field: "Parent",
        type: "Ganzzahl",
        reason: "Datensatz, den es nicht gibt"
      },
      { row: { short_text: MARKER }, field: "Short text", type: "Text", reason: "zu lang" },
      { row: { whole: 2147483648 }, field: "Whole", type: "Ganzzahl", reason: "außerhalb" }
    ];
    for (const entry of constraints) {
      const rejected = await refusal(
        call(world, "insert", { table: "refusals", rows: [entry.row] }, undefined, "de")
      );
      expect(rejected).toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(`„${entry.field}“ (${entry.type})`)
      });
      expect(rejected.message).toContain(entry.reason);
      expect(JSON.stringify(rejected)).not.toMatch(/SQLSTATE|private-row-value/u);
    }
    await expect(
      call(
        world,
        "update",
        { table: "refusals", rows: [{ key: { id: 1 }, set: { due: "2027-02-31" } }] },
        undefined,
        "de"
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("„Due“ (Datum)") });
    await expect(
      call(world, "delete_rows", { table: "refusals", keys: [{ id: MARKER }] }, undefined, "de")
    ).rejects.toMatchObject({ message: expect.stringContaining("„Id“ (Ganzzahl)") });
    await expect(
      call(world, "delete_rows", { table: "parents", keys: [{ id: 1 }] }, undefined, "de")
    ).rejects.toMatchObject({ message: expect.stringContaining("„Parent“ (Ganzzahl)") });
  });

  it("says what to do next when the database, not the rows, failed a write, and tells a still-used value apart from a missing reference", async () => {
    const world = await published("outages", [manifest(), migration, outageMigration]);
    const cases = [
      {
        state: "57014",
        code: "TIMEOUT",
        reason: "timeout",
        de: "zu lange gebraucht"
      },
      { state: "55P03", reason: "busy", de: "gerade ausgelastet" },
      { state: "40P01", reason: "busy", de: "gerade ausgelastet" },
      {
        state: "08006",
        code: "CONFLICT",
        reason: "unavailable",
        de: "nicht erreichbar"
      },
      { state: "42501", reason: "permission", de: "mangels Rechten" },
      {
        state: "42703",
        reason: "schema_changed",
        de: "Tabelle wurde geändert"
      },
      {
        state: "P0001",
        reason: "database_refusal",
        de: "konnte diese Datensätze nicht annehmen"
      }
    ];
    for (const entry of cases) {
      const rejected = await refusal(
        call(
          world,
          "insert",
          { table: "outages", rows: [{ id: 1, state: entry.state }] },
          undefined,
          "de"
        )
      );
      expect(rejected, entry.state).toMatchObject({
        ...(entry.code ? { code: entry.code } : {}),
        message: expect.stringContaining(entry.de),
        details: { reason: entry.reason }
      });
      expect(JSON.stringify(rejected)).not.toMatch(/SQLSTATE|private-row-value|\d{2}[0-9A-Z]{3}/u);
      // PR-382 L4: the sentence reaches the person; an INTERNAL answer would replace it.
      const answered = toErrorEnvelope(
        new AppError(rejected.code, rejected.message, rejected.details, { exposeMessage: true }),
        "row-refusals"
      );
      expect(answered.error.message, entry.state).toContain(entry.de);
    }
    // An abort while the database still works on the write: the executor's own cancellation.
    const operation = await world.dataStores.operationSource.resolve(
      dataStoreOperationName("findings", "insert")
    );
    if (!operation) throw new Error("Expected the insert operation");
    const actor: AuthenticatedUser = {
      id: "row-refusal-admin",
      externalUserId: "row-refusal-admin",
      displayLabel: "Row refusal admin",
      roles: ["admin"],
      permissionRefs: [],
      authSource: "test",
      clientInstanceId: world.clientInstanceId
    };
    const controller = new AbortController();
    const running = operation.execute(
      operation.inputSchema.parse({
        table: "outages",
        rows: [{ id: 2, state: "P0001", pause: 5 }]
      }),
      {
        runId: createPlatformId<"OperationRunId">("opr"),
        actor,
        origin: { kind: "user" },
        correlationId: "row-refusals-cancel",
        runtime: { locale: "de", signal: controller.signal },
        access: accessOf(actor),
        audit: new NoopAuditRecorder()
      }
    );
    setTimeout(() => controller.abort(), 300);
    expect(await refusal(running)).toMatchObject({
      message: expect.stringContaining("abgebrochen"),
      details: { reason: "cancelled" }
    });

    // A changed unique value that another table still uses.
    const update = { table: "codes", rows: [{ key: { id: 1 }, set: { code: "B" } }] };
    expect(await refusal(call(world, "update", update, undefined, "de"))).toMatchObject({
      message: expect.stringContaining("„Code“ (Text)"),
      details: { reason: "reference" }
    });
    // Pointing a row at a value that does not exist keeps its own advice.
    const missing = { table: "code_uses", rows: [{ key: { id: 1 }, set: { code: "Z" } }] };
    expect(await refusal(call(world, "update", missing, undefined, "de"))).toMatchObject({
      message: expect.stringContaining("den es nicht gibt")
    });
  });

  it("PR-382 L4: tells a call without a key whose commit failed to check before writing again", async () => {
    const world = await published("commit-unknown", [manifest(), migration]);
    const advice = { de: "vielleicht schon gespeichert", en: "may already be stored" };
    for (const locale of ["de", "en"] as const) {
      commit.failsNext = true;
      const rejected = await refusal(
        call(
          world,
          "insert",
          { table: "parents", rows: [{ id: locale === "de" ? 2 : 3 }] },
          undefined,
          locale
        )
      );
      expect(rejected, locale).toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining(advice[locale]),
        details: { reason: "outcome_unknown" }
      });
      expect(rejected.message).not.toMatch(/try again|erneut/u);
    }
    // It was right to say so: the rows were kept.
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from parents" })
    ).toMatchObject({ rows: [{ count: 3 }] });
    // Under a key the store itself answers a second call, so trying again stays the advice.
    commit.failsNext = true;
    const keyed = await refusal(
      call(world, "insert", { table: "parents", rows: [{ id: 4 }] }, "commit-unknown-key", "en")
    );
    expect(keyed).toMatchObject({ details: { reason: "unavailable" } });
    expect(keyed.message).toContain("Try again later");
  });
});
