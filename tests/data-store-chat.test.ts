import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { asAgentRunId, type AgentRun } from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { eventually, required } from "./support/assertions";
import { getTestJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

describe("row tools in the platform agent's real conversation path", () => {
  const { startWithAgent, put, publish, settle } = useDataStoreInstance();

  it("pauses every write by default, resumes with frozen input, and a declined write changes nothing", async () => {
    const world = await startWithAgent();
    expect(
      (
        await put(world, [
          { path: "store.yaml", text: "id: findings\nname: Holiday requests\n" },
          {
            path: "migrations/0001_init.sql",
            text: "create table holidays (person text primary key, ends date);"
          }
        ])
      ).statusCode
    ).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    const record = await settle(world, 1);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1 });
    const created = await world.api.call("conversations.create", {
      payload: { title: "Holiday requests", subject: { kind: "data_store", name: "findings" } }
    });
    const conversationId = created.json<{ id: string }>().id;
    async function until(runId: string, status: string) {
      let run: AgentRun | undefined;
      await eventually(async () => {
        await getTestJobs(world.api).runDue();
        run = await world.stores.agentRuns.getAgentRun({
          clientInstanceId,
          runId: asAgentRunId(runId)
        });
        expect(run?.status).toBe(status);
      });
      return required(run);
    }
    const snapshot = async () => [
      ...(await sql`select person, ends::text from holidays order by person`)
    ];
    try {
      for (const [verb, input, decision, expected] of [
        [
          "insert",
          { table: "holidays", rows: [{ person: "Alex", ends: "2026-11-06" }] },
          "confirm",
          [{ person: "Alex", ends: "2026-11-06" }]
        ],
        [
          "update",
          { table: "holidays", rows: [{ key: { person: "Alex" }, set: { ends: "2026-11-05" } }] },
          "decline",
          [{ person: "Alex", ends: "2026-11-06" }]
        ],
        [
          "update",
          { table: "holidays", rows: [{ key: { person: "Alex" }, set: { ends: "2026-11-05" } }] },
          "confirm",
          [{ person: "Alex", ends: "2026-11-05" }]
        ],
        ["delete_rows", { table: "holidays", keys: [{ person: "Alex" }] }, "confirm", []]
      ] as const) {
        const before = await snapshot();
        const said = await injectStartConversationRun(
          world.api,
          conversationId,
          `/tool data_store.findings.${verb} ${JSON.stringify(input)}`
        );
        const waiting = await until(said.run.id, "waiting_for_decision");
        expect(await snapshot()).toEqual(before);
        const held = required(
          (await world.stores.operationRuns.list({ clientInstanceId })).find(
            (run) =>
              run.origin.kind === "agent" &&
              run.origin.agentRunId === waiting.id &&
              run.status === "pending_confirmation"
          )
        );
        const observations = await world.stores.agentRuns.listRunObservations({
          clientInstanceId,
          runId: waiting.id
        });
        const requested = observations
          .map((observation) => observation.payload)
          .find((event) => event.type === "tool_decision_requested");
        expect(requested).toMatchObject({
          type: "tool_decision_requested",
          targetTitle: "Holiday requests",
          inputPreview: input
        });
        const operation = required(
          await world.execution.operationCalls.registry.resolve(held.operation)
        );
        expect(operation.changeClass).toBe(verb === "insert" ? "reversible" : "irreversible");
        const answered = await world.api.call("operations.decide", {
          params: { runId: held.id },
          payload: { decision }
        });
        expect(answered.statusCode, answered.body).toBe(200);
        await until(said.run.id, "completed");
        const ended = await world.stores.operationRuns.get({ clientInstanceId, id: held.id });
        expect(ended, JSON.stringify(ended)).toMatchObject({
          status: decision === "decline" ? "denied" : "done"
        });
        expect(await snapshot()).toEqual(expected);
        if (decision === "decline") {
          expect(
            await world.stores.operationRuns.get({ clientInstanceId, id: held.id })
          ).toMatchObject({ status: "denied", decision: { mode: "declined" } });
        }
      }
    } finally {
      await sql.end();
    }
  });
});
