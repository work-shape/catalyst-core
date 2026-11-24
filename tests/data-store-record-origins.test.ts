import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { asUserId, createPlatformId, type OperationOrigin } from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

describe("records proposals on an assembled instance", () => {
  const { start, put, publish, person, settle } = useDataStoreInstance();

  it("refuses chat row writes on a published records table, and proposals from an agent, an App or the CLI before table checks or store changes", async () => {
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
    const actor = await person(instance, "records-row-admin", ["user", "admin", "superadmin"]);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
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
          instance.execution.operationCalls.deps
        );
        expect(answer.result).toMatchObject({
          status: "failed",
          error: { details: { reason: "record_managed_table" } }
        });
        expect([...(await sql`select id, amount::integer from findings`)]).toEqual([
          { id: 1, amount: 42 }
        ]);
      }

      // An agent's call names a real chat without personal data: a conversation the store
      // does not know counts as personal and asks a confirmation first (CS-9d).
      const chat = async () =>
        (
          await instance.stores.conversations.createConversation({
            visibility: "workspace",
            clientInstanceId,
            collaborationWorkspaceId: (
              await instance.stores.workspaces.ensurePersonalWorkspace({
                clientInstanceId,
                userId: asUserId(actor.id)
              })
            ).id,
            createdByUserId: actor.id,
            createdByExternalUserId: actor.externalUserId,
            title: "Records proposal",
            retainedUntil: "2099-01-01T00:00:00.000Z"
          })
        ).id;
      const snapshot = async () => ({
        columns:
          await sql`select table_schema, table_name, column_name, data_type from information_schema.columns where table_schema in ('public', 'catalyst') order by table_schema, table_name, ordinal_position`,
        rows: await sql`select * from findings order by id`,
        candidates: await sql`select * from catalyst.record_fields`,
        loads: await sql`select * from catalyst.loads`
      });
      // Emulate the legacy store whose additive setup a direct call used to run.
      await sql`alter table catalyst.record_fields drop column if exists content_sha256`;
      const before = await snapshot();
      for (const kind of ["agent", "app", "cli"] as const) {
        const origin: OperationOrigin =
          kind === "agent"
            ? {
                kind,
                agentRunId: createPlatformId("agr"),
                conversationId: await chat(),
                agentName: "test",
                toolCallId: createPlatformId("tc"),
                toolName: "data_store.findings.records.propose"
              }
            : kind === "app"
              ? { kind, appRevisionId: "revision", actionName: "propose", pageSessionId: "session" }
              : { kind };
        for (const table of ["unknown", "findings"]) {
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
              idempotencyKey: `direct-${kind}-${table}`
            },
            {
              ...instance.execution.operationCalls.deps,
              // A stale agent tool list must still reach the Workflow-only refusal.
              agentToolNames: async () => ["data_store.findings.records.propose"]
            }
          );
          expect(answered.result, `${kind} ${table}`).toMatchObject({
            status: "failed",
            error: {
              code: "VALIDATION_FAILED",
              details: { reason: "workflow_dataset_owner_required" }
            }
          });
          expect(await snapshot()).toEqual(before);
        }
      }
    } finally {
      await sql.end();
    }
  });
});
