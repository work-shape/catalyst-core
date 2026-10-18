import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createAuthorizer,
  NoopAuditRecorder,
  createPlatformId,
  asUserId
} from "@work-shape/catalyst-core";
import { eventually } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { getTestJobs, listenTestInstance } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// An actual assembled instance: HTTP start -> cursor -> dataset -> load -> download.
describe("Workflow dataset consumers", () => {
  const fixture = useDataStoreInstance();
  it("loads the full streamed query once per step run and refuses foreign load references over HTTP", async () => {
    const world = await fixture.start(true, "allow", undefined, undefined, false, true);
    await world.api.call("health.get");
    const owner = await fixture.person(world, "user-1", ["user", "admin", "superadmin"]);
    expect(
      (
        await fixture.put(world, [
          { path: "store.yaml", text: "id: findings\nname: Findings\n" },
          {
            path: "migrations/0001_init.sql",
            text: "create table bulk_rows(id integer primary key, month text not null); create table batch_rows(id integer primary key, month text not null);"
          }
        ])
      ).statusCode
    ).toBe(200);
    expect((await fixture.publish(world, 1)).statusCode).toBe(200);
    const record = await fixture.settle(world, 1);
    const principal = await world.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "bulk-loader",
      displayLabel: "Bulk loader",
      createdByUserId: asUserId(owner.id)
    });
    for (const action of ["data_store.read", "data_store.insert"])
      await world.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: record.id,
        grantedBy: asUserId(owner.id)
      });
    const save = async (id: string, steps: unknown[]) => {
      const manifest = {
        id,
        name: id,
        runAs: "bulk-loader",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          ...steps
        ]
      };
      const address = { kind: "workflow", name: id };
      const written = await world.api.call("assets.put", {
        params: address,
        payload: { config: { name: id, manifest }, expectedRevision: null }
      });
      expect(written.statusCode, written.body).toBe(200);
      const published = await world.api.call("assets.publish", {
        params: address,
        payload: { revision: 1 }
      });
      expect(published.statusCode, published.body).toBe(200);
    };
    await save("bulk-load", [
      {
        id: "query",
        name: "Query",
        type: "operation",
        operation: "data_store.findings.query",
        input: {
          sql: {
            value:
              "select i::bigint as id, '2026-09'::text as month from generate_series(1, 2500) i order by i"
          }
        },
        dataset: { at: "rows" }
      },
      {
        id: "load",
        name: "Load",
        type: "operation",
        operation: "data_store.findings.load",
        input: { table: { value: "bulk_rows" }, dataset: { ref: { step: "query", path: "rows" } } }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: {
          rows: { ref: { step: "query", path: "rows" } },
          counts: { ref: { step: "load", path: "inserted" } },
          columns: { ref: { step: "query", path: "columns" } }
        }
      }
    ]);
    const url = await listenTestInstance(world.api);
    const start = async (workflow: string, input = {}) => {
      const response = await fetch(
        `${url}${apiOperations["workflows.start"].buildPath({ params: { workflow } })}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input })
        }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        typeof result.id !== "string"
      )
        throw new Error("Missing run id");
      return result.id;
    };
    const finish = (id: string) =>
      eventually(async () => {
        await getTestJobs(world.api).runDue();
        const run = await world.stores.workflowRuns.readRun({ clientInstanceId, id });
        expect(run?.status).toMatch(/^(done|failed)$/u);
        if (!run) throw new Error("Missing run");
        return run;
      });
    const run = await finish(await start("bulk-load"));
    expect(run, JSON.stringify(run.error)).toMatchObject({ status: "done" });
    const [dataset] = await world.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: run.id,
      limit: 10
    });
    expect(dataset?.rowCount).toBe(2500);
    expect(JSON.parse(run.outputPreview?.text ?? "null").columns[0]).toEqual({
      name: "id",
      type: "integer",
      nativeType: "bigint"
    });
    if (!dataset) throw new Error("Missing dataset");
    const download = await fetch(
      `${url}${apiOperations["workflows.download_dataset"].buildPath({ params: { runId: run.id, datasetId: dataset.id } })}`
    );
    expect(download.status).toBe(200);
    expect((await download.text()).trim().split("\n")).toHaveLength(2500);
    const steps = await world.stores.workflowRuns.listStepRuns({ clientInstanceId, runId: run.id });
    const step = steps.find((candidate) => candidate.stepId === "load");
    if (!step) throw new Error("Missing load step");
    const input = {
      table: "bulk_rows",
      dataset: { $dataset: dataset.id, rowCount: dataset.rowCount, bytes: dataset.bytes }
    };
    const operation = await world.execution.operationCalls.registry.resolve(
      "data_store.findings.load"
    );
    if (!operation) throw new Error("Missing load operation");
    const access = await createAuthorizer(world.stores.access).forActor(owner);
    const replay = await operation.execute(operation.inputSchema.parse(input), {
      runId: createPlatformId<"OperationRunId">("oprun"),
      actor: owner,
      access,
      origin: { kind: "workflow", workflowRunId: run.id, stepRunId: step.id },
      correlationId: "retry",
      idempotencyKey: "a-new-attempt-key",
      runtime: {},
      audit: new NoopAuditRecorder()
    });
    expect(replay).toMatchObject({ inserted: 2500, deleted: 0 });
    const database = new URL(await fileTestDatabaseUrl(import.meta.url));
    database.pathname = `/${record.location.database}`;
    const sql = postgres(database.toString(), { max: 1 });
    try {
      expect(await sql`select count(*)::integer as count from public.bulk_rows`).toEqual([
        { count: 2500 }
      ]);
      expect(
        await sql`select count(*)::integer as count from catalyst.loads where step_run_id = ${step.id}`
      ).toEqual([{ count: 1 }]);
      await save("view-load", [
        {
          id: "load",
          name: "Load view",
          type: "operation",
          operation: "data_store.findings.load",
          input: {
            table: { value: "batch_rows" },
            dataset: { ref: { step: "start", path: "input.dataset" } }
          }
        },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: {
            rows: { ref: { step: "start", path: "input.dataset" } },
            more: { ref: { step: "start", path: "input.more" } },
            inserted: { ref: { step: "load", path: "inserted" } }
          }
        }
      ]);
      const malformed = await world.api.call("workflows.start", {
        params: { workflow: "view-load" },
        payload: { input: { dataset: { ...input.dataset, offset: -1, rowCount: 100 } } }
      });
      expect(malformed.statusCode, malformed.body).toBe(422);
      // Valid reference shape, invalid stored range: this must fail at start, before a worker.
      const outOfRange = await world.api.call("workflows.start", {
        params: { workflow: "view-load" },
        payload: {
          input: { dataset: { ...input.dataset, offset: dataset.rowCount + 1, rowCount: 1 } }
        }
      });
      expect(outOfRange.statusCode, outOfRange.body).toBe(422);
      expect(outOfRange.json()).toMatchObject({
        error: { details: { reason: "dataset_reference_invalid" } }
      });
      const view = await finish(
        await start("view-load", {
          dataset: { ...input.dataset, offset: 100, rowCount: 100 },
          more: { ...input.dataset, offset: 150, rowCount: 100 }
        })
      );
      expect(view, JSON.stringify(view.error)).toMatchObject({ status: "done" });
      expect(
        await sql`select count(*)::integer as count, min(id)::integer as first, max(id)::integer as last from public.batch_rows`
      ).toEqual([{ count: 100, first: 101, last: 200 }]);
      const downloaded = await fetch(
        `${url}${apiOperations["workflows.download_dataset"].buildPath({ params: { runId: view.id, datasetId: dataset.id } })}`
      );
      expect(downloaded.status).toBe(200);
      const lines = (await downloaded.text()).trim().split("\n");
      expect(lines).toHaveLength(150);
      expect(JSON.parse(lines[0] ?? "null").id).toBe("101");
      expect(JSON.parse(lines.at(-1) ?? "null").id).toBe("250");
    } finally {
      await sql.end();
    }
    await save("foreign-load", [
      {
        id: "load",
        name: "Load",
        type: "operation",
        operation: "data_store.findings.load",
        input: { table: { value: "bulk_rows" }, dataset: { value: input.dataset } }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]);
    const foreign = await finish(await start("foreign-load"));
    expect(foreign).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
    // A restore excludes dataset objects. Metadata authorization still succeeds, but the
    // byte reader must retain dataset_expired instead of reporting a database failure.
    if (!dataset.parts[0]) throw new Error("Missing dataset part");
    await createFilesystemObjectStorage(world.filesRoot).delete(dataset.parts[0].key);
    await save("expired-load", [
      {
        id: "load",
        name: "Load",
        type: "operation",
        operation: "data_store.findings.load",
        input: {
          table: { value: "bulk_rows" },
          dataset: { ref: { step: "start", path: "input.dataset" } }
        }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]);
    const expired = await finish(await start("expired-load", { dataset: input.dataset }));
    expect(expired).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", message: expect.stringContaining("dataset_expired") }
    });
    const loaded = await world.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.dataset_loaded"
    });
    expect(loaded.filter((event) => event.subject === dataset.id)).toHaveLength(2);
    expect(JSON.stringify(loaded)).not.toContain("2026-09");
  });
});
