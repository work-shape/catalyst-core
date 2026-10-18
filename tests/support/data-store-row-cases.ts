import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { type JsonObject, type AuditEvent } from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./data-store-instance";
import { fileTestDatabaseUrl } from "./test-database";

const holidayFiles = [
  { path: "store.yaml", text: "id: findings\nname: Holiday requests\n" },
  {
    path: "migrations/0001_init.sql",
    text: `
    create table holidays (person text, starts date, ends date, days integer generated always as (ends - starts + 1) stored, primary key (person, starts));
    create table unkeyed (person text, ends date);
    create table typed_keys (id integer primary key, value text);
  `
  }
];
const alex = { person: "Alex", starts: "2026-11-02", ends: "2026-11-06" };
const key = { person: alex.person, starts: alex.starts };

/** Registered from data-store-api.test.ts so every row case uses the real assembled API. */
export function testDataStoreRowWrites(): void {
  describe("Rows from chat: atomic primary-key mutations", () => {
    const { start, put, publish, settle, person } = useDataStoreInstance();
    async function setup() {
      const instance = await start(true, "allow");
      expect((await put(instance, holidayFiles)).statusCode).toBe(200);
      expect((await publish(instance, 1)).statusCode).toBe(200);
      const record = await settle(instance, 1);
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${record.location.database}`;
      const sql = postgres(url.toString(), { max: 1, onnotice() {} });
      const actor = await person(instance, "row-admin", ["user", "admin", "superadmin"]);
      const call = async (
        verb: "insert" | "update" | "delete_rows",
        input: unknown,
        locale: "en" | "de" = "en",
        idempotencyKey?: string
      ) =>
        (
          await runOperation(
            {
              operation: `data_store.findings.${verb}`,
              effect: "changing",
              input,
              actor,
              origin: { kind: "user" },
              correlationId: "rows-chat",
              ...(idempotencyKey ? { idempotencyKey } : {})
            },
            instance.execution.operationCalls.deps,
            { locale }
          )
        ).result;
      const snapshot = async () => [
        ...(await sql`select person, starts::text, ends::text, days from holidays order by person, starts`)
      ];
      return { instance, sql, call, snapshot };
    }

    it("inserts, updates, queries and deletes Alex over HTTP, confirmed by the database", async () => {
      const { instance, sql, snapshot } = await setup();
      try {
        const call = (verb: "insert" | "update" | "delete_rows", payload: JsonObject) =>
          instance.api.call(`data_stores.${verb}`, { params: { store: "findings" }, payload });
        expect((await call("insert", { table: "holidays", rows: [alex] })).json()).toEqual({
          table: "holidays",
          inserted: 1,
          skipped: 0
        });
        expect(await snapshot()).toEqual([{ ...alex, days: 5 }]);
        const updated = await call("update", {
          table: "holidays",
          rows: [{ key, set: { ends: "2026-11-05" } }]
        });
        expect(await snapshot()).toEqual([{ ...alex, ends: "2026-11-05", days: 4 }]);
        expect(updated.json()).toEqual({ table: "holidays", updated: 1 });
        const found = await instance.api.call("data_stores.query", {
          params: { store: "findings" },
          payload: {
            sql: "select person, ends::text from holidays where person = $1",
            parameters: ["Alex"]
          }
        });
        expect(found.json()).toMatchObject({
          rows: [{ person: "Alex", ends: "2026-11-05" }],
          truncated: false
        });
        expect((await call("delete_rows", { table: "holidays", keys: [key] })).json()).toEqual({
          table: "holidays",
          deleted: 1
        });
        expect(await snapshot()).toEqual([]);
      } finally {
        await sql.end();
      }
    });

    it.each(["en", "de"] as const)(
      "refuses invalid mutations in %s and leaves the table unchanged",
      async (locale) => {
        const { sql, call, snapshot } = await setup();
        try {
          expect(await call("insert", { table: "holidays", rows: [alex] })).toMatchObject({
            status: "done"
          });
          const before = await snapshot();
          const cases: {
            verb: "update" | "delete_rows";
            input: JsonObject;
            reason: string;
            word: string;
          }[] = [];
          for (const verb of ["update", "delete_rows"] as const) {
            const input = (keys: JsonObject[], table = "holidays"): JsonObject =>
              verb === "update"
                ? { table, rows: keys.map((key) => ({ key, set: { ends: "2026-11-05" } })) }
                : { table, keys };
            cases.push(
              {
                verb,
                input: input([key], "unkeyed"),
                reason: "primary_key_required",
                word: locale === "de" ? "Migration" : "migration"
              },
              {
                verb,
                input: input([{ ...key, person: "Missing" }]),
                reason: "key_not_found",
                word: locale === "de" ? "nichts" : "Nothing"
              },
              {
                verb,
                input: input([key, { starts: key.starts, person: key.person }]),
                reason: "duplicate_key",
                word: locale === "de" ? "doppelt" : "twice"
              },
              {
                verb,
                input: input([{ person: "Alex" }]),
                reason: "primary_key_incomplete",
                word: locale === "de" ? "alle" : "every"
              },
              {
                verb,
                input: input([{ ...key, typo: 1 }]),
                reason: "column_unknown",
                word: locale === "de" ? "unbekannte" : "unknown"
              },
              {
                verb,
                input: input([{ ...key, days: 5 }]),
                reason: "column_unknown",
                word: locale === "de" ? "berechnete" : "generated"
              },
              {
                verb,
                input: input(Array.from({ length: 1001 }, () => key)),
                reason: "rows_too_many",
                word: "1000"
              },
              {
                verb,
                input: input([{ ...key, person: "x".repeat(1_048_577) }]),
                reason: "rows_too_large",
                word: "1048576"
              }
            );
          }
          const invalidSets: JsonObject[] = [{ person: "New" }, { typo: 1 }, { days: 9 }];
          for (const set of invalidSets)
            cases.push({
              verb: "update",
              input: { table: "holidays", rows: [{ key, set }] },
              reason: "person" in set ? "key_column_in_set" : "column_unknown",
              word:
                locale === "de"
                  ? "person" in set
                    ? "Primärschlüssel"
                    : "Spalte"
                  : "person" in set
                    ? "primary-key"
                    : "column"
            });
          for (const { verb, input, reason, word } of cases) {
            expect(await call(verb, input, locale), `${verb}: ${reason}`).toMatchObject({
              status: "failed",
              error: { details: { reason }, message: expect.stringContaining(word) }
            });
            expect(await snapshot(), `${verb}: ${reason}`).toEqual(before);
          }
          // Typed keys collide even when their JSON encodings differ.
          expect(
            await call("insert", { table: "typed_keys", rows: [{ id: 1, value: "before" }] })
          ).toMatchObject({ status: "done" });
          expect(
            await call(
              "update",
              {
                table: "typed_keys",
                rows: [
                  { key: { id: 1 }, set: { value: "after" } },
                  { key: { id: "1" }, set: { value: "again" } }
                ]
              },
              locale
            )
          ).toMatchObject({ status: "failed", error: { details: { reason: "duplicate_key" } } });
          expect([...(await sql`select * from typed_keys`)]).toEqual([{ id: 1, value: "before" }]);
          expect(
            await call(
              "update",
              {
                table: "typed_keys",
                rows: [{ key: { id: "not-an-integer" }, set: { value: "after" } }]
              },
              locale
            )
          ).toMatchObject({ status: "failed", error: { code: "VALIDATION_FAILED" } });
        } finally {
          await sql.end();
        }
      }
    );

    it("refuses a two-row call with one missing key atomically", async () => {
      const { sql, call, snapshot } = await setup();
      try {
        await call("insert", { table: "holidays", rows: [alex, { ...alex, person: "Blair" }] });
        const before = await snapshot();
        for (const verb of ["update", "delete_rows"] as const) {
          const keys = [key, { ...key, person: "Missing" }];
          const input: JsonObject =
            verb === "update"
              ? {
                  table: "holidays",
                  rows: keys.map((key) => ({ key, set: { ends: "2026-11-05" } }))
                }
              : { table: "holidays", keys };
          const answer = await call(verb, input);
          expect(await snapshot()).toEqual(before);
          expect(answer).toMatchObject({
            status: "failed",
            error: { details: { reason: "key_not_found" } }
          });
        }
      } finally {
        await sql.end();
      }
    });

    it("delivers a repeated update and delete once under the existing call key", async () => {
      const { instance, sql, call, snapshot } = await setup();
      try {
        // A trigger makes repeating an UPDATE observable, even when it sets the same values.
        await sql`create table writes (count integer not null)`;
        await sql`insert into writes values (0)`;
        await sql.unsafe(
          "create function count_write() returns trigger language plpgsql security definer set search_path = public as $$ begin update writes set count = count + 1; return new; end $$; create trigger count_write after update on holidays for each row execute function count_write()"
        );
        await call("insert", { table: "holidays", rows: [alex] });
        const input = { table: "holidays", rows: [{ key, set: { ends: "2026-11-05" } }] };
        const first = await call("update", input, "en", "alex-update");
        expect(first).toMatchObject({ status: "done", output: { table: "holidays", updated: 1 } });
        // Remove the outer run record: the store's keyed writer must still replay its result.
        const platform = postgres(await fileTestDatabaseUrl(), { max: 1 });
        try {
          await platform`delete from operation_runs where operation = 'data_store.findings.update'`;
        } finally {
          await platform.end();
        }
        expect(await call("update", input, "en", "alex-update")).toMatchObject({
          status: first.status,
          output: first.status === "done" ? first.output : undefined
        });
        expect([...(await sql`select count from writes`)]).toEqual([{ count: 1 }]);
        expect(await snapshot()).toEqual([{ ...alex, ends: "2026-11-05", days: 4 }]);
        const deletion = { table: "holidays", keys: [key] };
        const deleted = await call("delete_rows", deletion, "en", "alex-delete");
        expect(await call("delete_rows", deletion, "en", "alex-delete")).toMatchObject(deleted);
        expect(await snapshot()).toEqual([]);
        expect(
          (await instance.stores.operationRuns.list({ clientInstanceId })).some(
            (run) => run.operation === "data_store.findings.delete_rows" && run.status === "done"
          )
        ).toBe(true);
      } finally {
        await sql.end();
      }
    });

    it("keeps keys and values out of write results, Operation Run output, audit and logs", async () => {
      const { instance, sql, call } = await setup();
      const logs: unknown[] = [];
      const spies = [instance.execution.logger].flatMap((logger) =>
        ["debug", "info", "warn", "error"].map((level) => {
          if (level === "debug")
            return vi.spyOn(logger, "debug").mockImplementation((...args) => {
              logs.push(args);
            });
          if (level === "info")
            return vi.spyOn(logger, "info").mockImplementation((...args) => {
              logs.push(args);
            });
          if (level === "warn")
            return vi.spyOn(logger, "warn").mockImplementation((...args) => {
              logs.push(args);
            });
          return vi.spyOn(logger, "error").mockImplementation((...args) => {
            logs.push(args);
          });
        })
      );
      try {
        const marker = "synthetic-sensitive-row-marker-109";
        for (const [verb, input, output] of [
          [
            "insert",
            { table: "typed_keys", rows: [{ id: 109, value: marker }] },
            { table: "typed_keys", inserted: 1, skipped: 0 }
          ],
          [
            "insert",
            { table: "holidays", rows: [{ ...alex, person: marker }] },
            { table: "holidays", inserted: 1, skipped: 0 }
          ],
          [
            "update",
            {
              table: "holidays",
              rows: [{ key: { ...key, person: marker }, set: { ends: "2026-11-05" } }]
            },
            { table: "holidays", updated: 1 }
          ],
          [
            "delete_rows",
            { table: "holidays", keys: [{ ...key, person: marker }] },
            { table: "holidays", deleted: 1 }
          ]
        ] as const) {
          const answer = await call(verb, input);
          expect(answer).toMatchObject({ status: "done", output });
          expect(JSON.stringify(answer)).not.toContain(marker);
        }
        const runs = await instance.stores.operationRuns.list({ clientInstanceId });
        expect(runs.length).toBeGreaterThan(0);
        expect(JSON.stringify(runs.map((run) => run.output))).not.toContain(marker);
        const audit: AuditEvent[] = [];
        let after: readonly (string | number)[] | undefined;
        do {
          const events = await instance.stores.audit.listAuditEvents({
            clientInstanceId,
            page: { limit: 50, ...(after ? { after } : {}) }
          });
          audit.push(...events);
          expect(JSON.stringify(events)).not.toContain(marker);
          const last = events.at(-1);
          after = events.length === 50 && last ? [last.createdAt, last.id] : undefined;
        } while (after);
        expect(
          audit
            .filter((event) => event.type === "data_store.rows_written")
            .map((event) => event.metadata)
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              store: "findings",
              table: "typed_keys",
              inserted: 1,
              skipped: 0
            }),
            expect.objectContaining({
              store: "findings",
              table: "holidays",
              inserted: 1,
              skipped: 0
            }),
            expect.objectContaining({ store: "findings", table: "holidays", updated: 1 }),
            expect.objectContaining({ store: "findings", table: "holidays", deleted: 1 })
          ])
        );
        expect(JSON.stringify(logs)).not.toContain(marker);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        await sql.end();
      }
    });
  });
}
