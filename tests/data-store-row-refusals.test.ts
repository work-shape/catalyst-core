import { describe, expect, it } from "vitest";
import {
  createOperationRegistry,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type JsonObject
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { accessOf } from "./support/access";
import { manifest, refusal, useDataStoreWorld } from "./support/data-store-world";

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

describe("ACCEPT-FIX-13 E-1: localized database refusals after confirmation", () => {
  const { db, published, call } = useDataStoreWorld("row_refusals");

  it.each(["de", "en"] as const)(
    "names the column and type for every scalar and array refusal in %s",
    async (locale) => {
      const world = await published(`types-${locale}`, [manifest(), migration]);
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
      const cases: { column: string; value: JsonObject[string]; de: string; en: string }[] = [
        { column: "code", value: MARKER, de: "Text", en: "Text" },
        { column: "whole", value: MARKER, de: "Ganzzahl", en: "Integer" },
        { column: "amount", value: MARKER, de: "Zahl", en: "Number" },
        { column: "done", value: MARKER, de: "Ja/Nein", en: "Yes/No" },
        { column: "due", value: "2027-02-31", de: "Datum", en: "Date" },
        { column: "moment", value: MARKER, de: "Datum und Uhrzeit", en: "Date and time" },
        { column: "period", value: MARKER, de: "Wert", en: "Value" },
        { column: "texts", value: { private: MARKER }, de: "Text, Liste", en: "Text, list" },
        { column: "wholes", value: [MARKER], de: "Ganzzahl, Liste", en: "Integer, list" },
        { column: "amounts", value: [MARKER], de: "Zahl, Liste", en: "Number, list" },
        { column: "flags", value: [MARKER], de: "Ja/Nein, Liste", en: "Yes/No, list" },
        { column: "dates", value: ["2027-02-31"], de: "Datum, Liste", en: "Date, list" },
        {
          column: "moments",
          value: [MARKER],
          de: "Datum und Uhrzeit, Liste",
          en: "Date and time, list"
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
        expect(outcome.result.error.message).toContain(
          locale === "de" ? "Ein Wert passt nicht" : "A value does not fit"
        );
        expect(JSON.stringify(outcome.result)).not.toMatch(
          /SQLSTATE|22P02|22008|private-row-value/u
        );
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
    }
  );

  it("names required, unique, foreign-key, length and range refusals in German without database codes", async () => {
    const world = await published("constraints-de", [manifest(), migration]);
    await call(world, "insert", { table: "refusals", rows: [{ unique_number: 1, parent: 1 }] });
    const cases = [
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
    for (const entry of cases) {
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
});
