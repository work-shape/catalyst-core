import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  asAgentRunId,
  asConversationId,
  createPlatformId,
  type AgentRun
} from "@work-shape/catalyst-core";
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
        const usage = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(usage.statusCode, usage.body).toBe(200);
        expect(usage.json()).toMatchObject({
          conversationWriters: { agents: 1, conversations: 1, truncated: false }
        });
        expect(JSON.stringify(usage.json())).not.toContain(conversationId);

        if (decision === "decline") {
          expect(
            await world.stores.operationRuns.get({ clientInstanceId, id: held.id })
          ).toMatchObject({ status: "denied", decision: { mode: "declined" } });
        }
      }
      // A busy store bounds the history before filtering for conversation writers. An older
      // chat write beyond that slice is not read or counted, and the page is told it is partial.
      const completed = required(
        (await world.stores.operationRuns.list({ clientInstanceId })).find(
          (run) => run.operation === "data_store.findings.insert" && run.status === "done"
        )
      );
      const oldId = createPlatformId<"OperationRunId">("oprun");
      const oldAt = "2020-01-01T00:00:00.000Z";
      const oldOrigin = completed.origin;
      expect(oldOrigin.kind).toBe("agent");
      if (oldOrigin.kind !== "agent") throw new Error("Expected the completed chat insert");
      await world.stores.operationRuns.create({
        ...completed,
        id: oldId,
        startedAt: oldAt,
        idempotencyKey: "retired-store-write",
        origin: { ...oldOrigin, agentName: "retired-store-agent" }
      });
      await world.stores.operationRuns.finish({
        clientInstanceId,
        id: oldId,
        end: { status: "done", finishedAt: oldAt, output: { value: { inserted: 1 } } }
      });
      const currentUsage = await world.api.call("data_stores.used_by", {
        params: { store: "findings" }
      });
      expect(currentUsage.statusCode).toBe(200);
      expect(currentUsage.json()).toMatchObject({
        conversationWriters: { agents: 1, conversations: 1, truncated: false }
      });
      // Workflow agent calls have an agent origin too, but act as the Workflow's principal.
      const listWriters = vi
        .spyOn(world.stores.operationRuns, "list")
        .mockImplementation(async ({ filters }) =>
          filters?.operation === "data_store.findings.insert"
            ? [
                completed,
                {
                  ...completed,
                  actor: { kind: "service_principal", id: "workflow-principal", label: "Workflow" },
                  origin: {
                    ...oldOrigin,
                    agentName: "workflow-agent",
                    conversationId: asConversationId("workflow-thread")
                  }
                }
              ]
            : []
        );
      try {
        const withWorkflow = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(withWorkflow.statusCode, withWorkflow.body).toBe(200);
        expect(withWorkflow.json()).toMatchObject({
          conversationWriters: { agents: 1, conversations: 1, truncated: false }
        });
      } finally {
        listWriters.mockRestore();
      }
      const recent = Array.from({ length: 1_000 }, () => ({
        ...completed,
        origin: { kind: "user" as const }
      }));
      const listed = vi
        .spyOn(world.stores.operationRuns, "list")
        .mockImplementation(async ({ filters }) =>
          filters?.operation === "data_store.findings.insert" ? [...recent, completed] : []
        );
      try {
        const partial = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(partial.statusCode, partial.body).toBe(200);
        expect(listed).toHaveBeenCalledWith({
          clientInstanceId,
          filters: { operation: "data_store.findings.insert", since: expect.any(String) },
          page: { limit: 1_001 }
        });
        expect(partial.json()).toMatchObject({
          conversationWriters: { agents: 0, conversations: 0, truncated: true }
        });
      } finally {
        listed.mockRestore();
      }
    } finally {
      await sql.end();
    }
  });
});
