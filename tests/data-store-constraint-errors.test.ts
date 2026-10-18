import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createOperationRegistry,
  NoopAuditRecorder,
  type AuthenticatedUser,
  type JsonObject
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { manifest, useDataStoreWorld } from "./support/data-store-world";
import { accessOf } from "./support/access";

const MARKER = "private-row-value-in-trigger-diagnostics";

const cases: { kind: string; code: string; name: string | undefined; row: JsonObject }[] = [
  { kind: "unique", code: "23505", name: "unique_address", row: { adresse: "held" } },
  { kind: "check", code: "23514", name: "bounded_price", row: { price: -1 } },
  { kind: "not-null", code: "23502", name: "NOT NULL (year)", row: { year: null } },
  { kind: "foreign-key", code: "23503", name: "known_year", row: { year: 1999 } },
  { kind: "exclusion", code: "23P01", name: "distinct_period", row: { period: "[1,3)" } },
  { kind: "raised-check", code: "23514", name: undefined, row: { adresse: MARKER } },
  { kind: "raised-unique", code: "23505", name: undefined, row: { adresse: MARKER } }
];

describe("constraint diagnostics through a Data Store operation", () => {
  const { db, published, connect } = useDataStoreWorld("constraint_errors");

  it.each(cases)(
    "$kind retains only real object names in the answer and Operation Run",
    async ({ kind, code, name, row }) => {
      const raised = kind.startsWith("raised-");
      const rows = [{ id: 2, adresse: "new", year: 2000, price: 1, period: "[4,5)", ...row }];
      const w = await published(
        kind,
        [
          manifest(),
          {
            path: "migrations/0001_objects.sql",
            text: `create table years (year integer primary key);
              insert into years values (2000);
              create table objekt (
                id integer primary key,
                adresse text constraint unique_address unique,
                year integer not null constraint known_year references years(year),
                price integer constraint bounded_price check (price > 0),
                period int4range,
                constraint distinct_period exclude using gist (period with &&)
              );
              insert into objekt values (1, 'held', 2000, 1, '[1,2)');
              ${
                raised
                  ? `create function refuse_row() returns trigger language plpgsql as $$
                      begin
                        raise exception using errcode = '${code}', message = NEW.adresse,
                          constraint = NEW.adresse, table = NEW.adresse, column = NEW.adresse;
                      end $$;
                      create trigger refuse_row before insert on objekt
                        for each row execute function refuse_row();`
                  : ""
              }`
          }
        ],
        {
          async *read() {
            yield rows;
          }
        }
      );
      const target = connect(w.record.location.database);
      const before = await target`select * from objekt order by id`;
      const registry = createOperationRegistry();
      registry.addSource(w.dataStores.operationSource);
      const actor: AuthenticatedUser = {
        id: "constraint-admin",
        externalUserId: "constraint-admin",
        displayLabel: "Constraint admin",
        roles: ["admin"],
        permissionRefs: [],
        authSource: "test",
        clientInstanceId: w.clientInstanceId
      };
      for (const locale of ["en", "de"] as const) {
        const outcome = await runOperation(
          {
            operation: "data_store.findings.load",
            effect: "changing",
            input: {
              table: "objekt",
              dataset: { $dataset: "rows", rowCount: 1, bytes: JSON.stringify(rows).length }
            },
            actor,
            origin: { kind: "workflow", workflowRunId: "constraints", stepRunId: locale },
            idempotencyKey: locale,
            correlationId: "constraint-errors"
          },
          {
            clientInstanceId: w.clientInstanceId,
            registry,
            runs: db.store.operationRuns,
            authorizer: { forActor: async () => accessOf(actor) },
            events: { emit: async () => ({ outcome: "allow", guardrails: [] }) },
            audit: new NoopAuditRecorder(),
            policy: {
              instanceDefaults: { reading: "allow", changing: "allow" },
              centralSettings: () => []
            },
            logger: w.logger
          },
          { locale }
        );
        expect(outcome.result).toMatchObject({
          status: "failed",
          error: { code: "VALIDATION_FAILED", details: { sqlState: code } }
        });
        if (outcome.result.status !== "failed") throw new Error("Expected constraint refusal");
        const stored = await db.store.operationRuns.get({
          clientInstanceId: w.clientInstanceId,
          id: outcome.run.id
        });
        expect(stored).toMatchObject({
          status: "failed",
          error: { code: outcome.result.error.code, message: outcome.result.error.message }
        });
        if (name) {
          expect(outcome.result.error.message).toContain(name);
          expect(outcome.result.error.message).toContain("objekt");
          expect(outcome.result.error.message).toContain(
            locale === "de" ? "verletzt die Einschränkung" : "violates constraint"
          );
        } else {
          expect(outcome.result.error.message).toBe(
            `The load ${code === "23514" ? "breaks a check of its table" : "would store a value twice that must be unique"} (SQLSTATE ${code}).`
          );
        }
        expect(
          inspect({ result: outcome.result, run: stored, logs: w.logged }, { depth: null })
        ).not.toContain(MARKER);
        expect(await target`select * from objekt order by id`).toEqual(before);
        expect(await target`select count(*)::int as n from catalyst.loads`).toEqual([{ n: 0 }]);
      }
    }
  );
});
