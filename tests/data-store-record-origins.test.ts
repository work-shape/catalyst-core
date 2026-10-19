import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createPlatformId, type OperationOrigin } from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

describe("records proposals on an assembled instance", () => {
  const { start, put, publish, person, settle } = useDataStoreInstance();

  it.each(["en", "de"] as const)(
    "refuses all chat row writes on a published records table in %s",
    async (locale) => {
      const instance = await start(true, "allow");
      expect(
        (
          await put(instance, [
            {
              path: "store.yaml",
              text: "id: findings\nrecords:\n  - table: findings\n    key: { column: id, fromField: id }\n    precedence: [deed]\n    review: { always: [] }\n"
            },
            {
              path: "migrations/0001_init.sql",
              text: "create table findings (id integer primary key, amount numeric);"
            }
          ])
        ).statusCode
      ).toBe(200);
      expect((await publish(instance, 1)).statusCode).toBe(200);
      const record = await settle(instance, 1);
      const actor = await person(instance, "records-row-admin", ["user", "admin", "superadmin"]);
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${record.location.database}`;
      const sql = postgres(url.toString(), { max: 1 });
      try {
        await sql`insert into findings values (1, 42)`;
        for (const [verb, input] of [
          ["insert", { table: "findings", rows: [{ id: 2, amount: 99 }] }],
          ["update", { table: "findings", rows: [{ key: { id: 1 }, set: { amount: 99 } }] }],
          ["delete_rows", { table: "findings", keys: [{ id: 1 }] }]
        ] as const) {
          const answer = await runOperation(
            {
              operation: `data_store.findings.${verb}`,
              effect: "changing",
              input,
              actor,
              origin: { kind: "user" },
              correlationId: "records-row-guard"
            },
            instance.execution.operationCalls.deps,
            { locale }
          );
          expect(answer.result).toMatchObject({
            status: "failed",
            error: {
              details: { reason: "record_managed_table" },
              message:
                locale === "de"
                  ? "Diese Tabelle wird aus extrahierten Feldern befüllt. Reiche Korrekturen über die Prüfung der extrahierten Felder ein."
                  : "This table is managed by records. Submit corrections through the records review."
            }
          });
          expect([...(await sql`select id, amount::integer from findings`)]).toEqual([
            { id: 1, amount: 42 }
          ]);
        }
      } finally {
        await sql.end();
      }
    }
  );

  it.each(["agent", "app", "cli"] as const)(
    "refuses records proposals from %s before table checks or store changes",
    async (kind) => {
      const instance = await start(true, "allow");
      expect(
        (
          await put(instance, [
            {
              path: "store.yaml",
              text: "id: findings\nrecords:\n  - table: findings\n    key: { column: id, fromField: id }\n    precedence: [deed]\n    review: { always: [] }\n"
            },
            {
              path: "migrations/0001_init.sql",
              text: "create table findings (id integer primary key, amount numeric); insert into findings values (1, 42);"
            }
          ])
        ).statusCode
      ).toBe(200);
      expect((await publish(instance, 1)).statusCode).toBe(200);
      const record = await settle(instance, 1);
      const actor = await person(instance, `proposal-${kind}`, ["user", "admin", "superadmin"]);
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${record.location.database}`;
      const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      const origin: OperationOrigin =
        kind === "agent"
          ? {
              kind,
              agentRunId: createPlatformId("agr"),
              conversationId: createPlatformId("conv"),
              agentName: "test",
              toolCallId: createPlatformId("tc"),
              toolName: "data_store.findings.records.propose"
            }
          : kind === "app"
            ? { kind, appRevisionId: "revision", actionName: "propose", pageSessionId: "session" }
            : { kind };
      const snapshot = async () => ({
        columns:
          await sql`select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema in ('public', 'catalyst') order by table_schema, table_name, ordinal_position`,
        rows: await sql`select * from findings order by id`,
        candidates: await sql`select * from catalyst.record_fields`,
        loads: await sql`select * from catalyst.loads`
      });
      try {
        // Emulate the legacy store whose additive setup a direct call used to run.
        await sql`alter table catalyst.record_fields drop column if exists content_sha256`;
        const before = await snapshot();
        for (const table of ["unknown", "findings"]) {
          for (const locale of ["en", "de"] as const) {
            const answered = await runOperation(
              {
                operation: "data_store.findings.records.propose",
                effect: "changing",
                input: {
                  table,
                  items: [
                    {
                      knowledgeBaseId: "missing-kb",
                      documentId: "missing-document",
                      kind: "deed",
                      documentDate: null,
                      fields: [{ name: "amount", value: 99, page: 1, quote: "99" }]
                    }
                  ]
                },
                actor,
                origin,
                correlationId: "proposal-origin",
                idempotencyKey: `direct-${table}-${locale}`
              },
              {
                ...instance.execution.operationCalls.deps,
                // A stale agent tool list must still reach the Workflow-only refusal.
                agentToolNames: async () => ["data_store.findings.records.propose"]
              },
              { locale }
            );
            expect(answered.result).toMatchObject({
              status: "failed",
              error: {
                code: "VALIDATION_FAILED",
                details: { reason: "workflow_dataset_owner_required" },
                message:
                  locale === "de"
                    ? "`records.propose` läuft nur als Schritt eines Workflow Runs."
                    : "`records.propose` runs only as a step of a Workflow Run."
              }
            });
            expect(await snapshot()).toEqual(before);
          }
        }
      } finally {
        await sql.end();
      }
    }
  );
});
