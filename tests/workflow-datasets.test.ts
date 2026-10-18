import { apiOperations } from "@work-shape/catalyst-api-contract";
import { listenTestInstance } from "./support/test-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import {
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

function datasetWorkflow() {
  const manifest = notifyClients({ concurrency: 2, onItemFailure: "continue" });
  return {
    ...manifest,
    types: { client: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    retention: { datasets: 2 },
    steps: manifest.steps.map((step) =>
      step.id === "clients" ? { ...step, dataset: { at: "clients" } } : step
    )
  };
}

describe("Workflow datasets", () => {
  it("accepts dataset producers and named row types, while naming the deferred slices", () => {
    expect(parseWorkflowManifest(datasetWorkflow())).toMatchObject({ ok: true });
    const paged = datasetWorkflow();
    paged.steps = paged.steps.map((step) =>
      step.id === "clients" ? { ...step, paginate: true } : step
    );
    expect(parseWorkflowManifest(paged)).toMatchObject({ ok: true });
  });

  it("stores only a reference, loops over its rows once and removes intermediates at run end", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(datasetWorkflow());
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(writesOf(t)).toHaveLength(3);
    const steps = await stepRunsOf(t, run.id);
    const producer = steps.find((step) => step.key === "clients");
    const output = JSON.parse(producer?.outputPreview?.text ?? "null");
    expect(output).toEqual({
      clients: { $dataset: expect.any(String), rowCount: 3, bytes: expect.any(Number) }
    });
    expect(JSON.stringify(output)).not.toContain("client-anna");
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, page: { limit: 100 } });
    expect(audit.filter((event) => event.type === "workflow_run.dataset_created")).toHaveLength(2);
    await t.worker().runDue();
    const deleted = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.dataset_deleted"
    });
    expect(deleted).toHaveLength(2);
  });
});

it.each([true, false])(
  "a parent retains child datasets only when returned (returned=%s)",
  async (returned) => {
    const definitions = publishedDefinitions();
    const base = notifyClients();
    const child = {
      ...base,
      id: "child-data",
      outputs: {
        type: "object",
        properties: { clients: { type: "dataset", row: { type: "object" } } },
        required: ["clients"]
      },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
        {
          id: "clients",
          name: "Clients",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { ref: { step: "start", path: "input.note" } } },
          dataset: { at: "clients" }
        },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: { clients: { ref: { step: "clients", path: "clients" } } }
        }
      ]
    };
    definitions.publish(child);
    definitions.publish({
      ...base,
      outputs: returned ? child.outputs : { type: "object" },
      retention: { datasets: 2 },
      steps: [
        base.steps[0],
        {
          id: "child",
          name: "Child",
          type: "workflow",
          workflow: "child-data",
          input: { note: { ref: { step: "start", path: "input.note" } } }
        },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: returned ? { clients: { ref: { step: "child", path: "clients" } } } : {}
        }
      ]
    });
    const objects = new MemoryObjectStorage();
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, datasetObjects: objects }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    const root = await t.finish((await start(t)).id);
    expect(root, JSON.stringify(root.error)).toMatchObject({ status: "done" });
    const parent = await t.stores.workflowRuns.readRun({ clientInstanceId, id: root.id });
    if (!parent) throw new Error("Missing parent");
    const [childRun] = await t.stores.workflowRuns.listChildRuns({
      clientInstanceId,
      id: parent.id
    });
    if (!childRun) throw new Error("Missing child");
    const [dataset] = await t.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: childRun.id,
      limit: 10
    });
    if (!dataset) throw new Error("Missing child dataset");
    if (!returned) {
      await t.worker().runDue();
      expect(objects.size).toBe(0);
      expect(
        await t.stores.workflowRunDatasets.get({ clientInstanceId, id: dataset.id })
      ).toMatchObject({ state: "deleted" });
      return;
    }
    expect(dataset.state).toBe("complete");
    expect(objects.size).toBe(1);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      await t.stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: tomorrow,
        limit: 10
      })
    ).toEqual([]);
    const afterRetention = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(
      await t.stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: afterRetention,
        limit: 10
      })
    ).toHaveLength(1);
  }
);

it("a failed run keeps its resume window even when output retention is shorter", async () => {
  const definitions = publishedDefinitions();
  const manifest = datasetWorkflow();
  definitions.publish({
    ...manifest,
    steps: manifest.steps.map((step) =>
      step.id === "each_client" ? { ...step, onItemFailure: "stop" } : step
    )
  });
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
  );
  t.setBehaviour((operation) =>
    operation === "echo"
      ? Promise.resolve({ clients: [{ id: "one" }] })
      : Promise.reject(new Error("Source unavailable"))
  );
  const result = await t.finish((await start(t)).id);
  expect(result.status).toBe("failed");
  expect(
    await t.stores.workflowRunDatasets.claimExpired({
      clientInstanceId,
      now: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      limit: 10
    })
  ).toEqual([]);
  expect(
    await t.stores.workflowRunDatasets.claimExpired({
      clientInstanceId,
      now: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      limit: 10
    })
  ).toHaveLength(1);
});

it("replaces a large changing operation answer before its Operation Run retains it", async () => {
  const definitions = publishedDefinitions();
  const base = notifyClients();
  definitions.publish({
    ...base,
    outputs: { type: "object" },
    steps: [
      base.steps[0],
      {
        id: "bulk",
        name: "Bulk",
        type: "operation",
        operation: "connection.crm.write",
        input: { rows: { value: true } },
        dataset: { at: "received.rows" }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  });
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
  );
  t.state.limits = { ...t.state.limits, resultMaxBytes: 2 * 1024 * 1024 };
  const marker = "DATASET_ROW_CONTENT_";
  t.setBehaviour(() =>
    Promise.resolve({
      received: {
        rows: Array.from({ length: 500 }, (_, index) => ({
          index,
          text: marker + "x".repeat(2500)
        }))
      }
    })
  );
  const result = await t.finish((await start(t)).id);
  expect(result, JSON.stringify(result.error)).toMatchObject({ status: "done" });
  const calls = await t.stores.operationRuns.list({ clientInstanceId, page: { limit: 100 } });
  const bulk = calls.find((call) => call.operation === "connection.crm.write");
  expect(bulk?.output?.value).toMatchObject({
    received: { rows: { $dataset: expect.any(String), rowCount: 500 } }
  });
  expect(JSON.stringify(calls)).not.toContain(marker);
  const steps = await stepRunsOf(t, result.id);
  expect(JSON.stringify(steps)).not.toContain(marker);
});

it("accepts a dataset in a root input only when the caller may read its source data", async () => {
  const definitions = publishedDefinitions();
  const base = notifyClients();
  const datasetType = { type: "dataset", row: { type: "object" } };
  definitions.publish({
    ...base,
    id: "source-data",
    outputs: { type: "object", properties: { rows: datasetType }, required: ["rows"] },
    steps: [
      base.steps[0],
      {
        id: "rows",
        name: "Rows",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "read" } },
        dataset: { at: "clients" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: { ref: { step: "rows", path: "clients" } } }
      }
    ]
  });
  definitions.publish({
    ...base,
    id: "consume-data",
    inputs: { type: "object", properties: { rows: datasetType }, required: ["rows"] },
    outputs: { type: "object" },
    steps: [
      base.steps[0],
      {
        id: "each",
        name: "Each",
        type: "loop",
        items: { step: "start", path: "input.rows" },
        steps: [
          {
            id: "send",
            name: "Send",
            type: "operation",
            operation: "connection.crm.write",
            input: { client: { ref: { step: "each", path: "id" } } }
          }
        ]
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  });
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
  );
  const source = await t.finish((await start(t, t.root.id, "source-data")).id);
  expect(source.status).toBe("done");
  const sourceRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: source.id });
  if (!sourceRun) throw new Error("Missing source run");
  const [record] = await t.stores.workflowRunDatasets.listForRun({
    clientInstanceId,
    runId: sourceRun.id,
    limit: 10
  });
  if (!record) throw new Error("Missing dataset");
  const input = { rows: { $dataset: record.id, rowCount: record.rowCount, bytes: record.bytes } };
  await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
  const refused = await t.call(t.kai.id, "workflows.start", {
    params: { workflow: "consume-data" },
    payload: { input }
  });
  expect(refused.statusCode).toBe(403);
  await t.allow({ kind: "user", id: t.kai.id }, "workflow.read_run_data");
  const response = await t.expectOk(t.kai.id, "workflows.start", {
    params: { workflow: "consume-data" },
    payload: { input }
  });
  const target = runSchema.parse(response.json());
  expect((await t.finish(target.id)).status).toBe("done");
  expect(writesOf(t)).toHaveLength(3);
});

it("deleting an unpublished Workflow claims the datasets of its active test run", async () => {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets", datasetObjects: objects }
  );
  const address = { kind: "workflow", name: "notify-clients" };
  await t.expectOk(t.root.id, "assets.put", {
    params: address,
    payload: {
      config: { name: "notify-clients", manifest: datasetWorkflow() },
      expectedRevision: null
    }
  });
  const response = await t.expectOk(t.root.id, "workflows.test", {
    params: { workflow: "notify-clients" },
    payload: { input: { note: "test" } }
  });
  const started = runSchema.parse(response.json());
  const worker = t.worker();
  await worker.runDue();
  await worker.runDue();
  const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
  if (!run) throw new Error("Missing test run");
  const [dataset] = await t.stores.workflowRunDatasets.listForRun({
    clientInstanceId,
    runId: run.id,
    limit: 10
  });
  if (!dataset) throw new Error("Missing test dataset");
  expect(dataset.state).toBe("complete");
  await t.expectOk(t.root.id, "assets.delete", {
    params: address,
    payload: { expectedRevision: 1 }
  });
  expect(
    await t.stores.workflowRunDatasets.get({ clientInstanceId, id: dataset.id })
  ).toMatchObject({ state: "deleted" });
});

it("streams only result datasets over HTTP to the starter or a run-data reader, with content-free audit", async () => {
  const definitions = publishedDefinitions();
  const base = notifyClients();
  definitions.publish({
    ...base,
    id: "download-data",
    outputs: { type: "object" },
    steps: [
      base.steps[0],
      {
        id: "rows",
        name: "Rows",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "read" } },
        dataset: { at: "clients" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: { ref: { step: "rows", path: "clients" } } }
      }
    ]
  });
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
  );
  const rows = [{ id: 'private,"value\nnext', nested: { ok: true } }];
  t.setBehaviour(() => Promise.resolve({ clients: rows }));
  await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
  await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
  const run = await t.finish((await start(t, t.kai.id, "download-data")).id);
  expect(run.status).toBe("done");
  const ref = JSON.parse(run.outputPreview?.text ?? "null").rows;
  const url = await listenTestInstance(t.instance);
  const download = (user: string, id = run.id, dataset = ref.$dataset, format = "jsonl") =>
    fetch(
      `${url}${apiOperations["workflows.download_dataset"].buildPath({ params: { runId: id, datasetId: dataset }, query: { format } })}`,
      {
        headers: { "x-test-user": user }
      }
    );
  expect((await download(t.lena.id)).status).toBe(403);
  const jsonl = await download(t.kai.id);
  expect(jsonl.status).toBe(200);
  expect(jsonl.headers.get("cache-control")).toBe("private, no-store");
  expect(await jsonl.text()).toBe(JSON.stringify(rows[0]) + "\n");
  const csv = await download(t.root.id, run.id, ref.$dataset, "csv");
  expect(csv.status).toBe(200);
  expect(await csv.text()).toBe('"id","nested"\r\n"private,""value\nnext","{""ok"":true}"\r\n');
  const other = await t.finish((await start(t, t.root.id, "download-data")).id);
  expect((await download(t.root.id, other.id)).status).toBe(404);
  expect((await download(t.kai.id, run.id, "missing")).status).toBe(404);
  expect((await download(t.kai.id, run.id, ref.$dataset, "bad")).status).toBe(422);
  const events = await t.stores.audit.listAuditEvents({
    clientInstanceId,
    type: "workflow_run.dataset_downloaded"
  });
  expect(events.filter((event) => event.subject === ref.$dataset)).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain("private");
  expect(JSON.stringify(events)).not.toContain("nested");
  const persisted = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
  if (!persisted) throw new Error("Missing run");
  await t.stores.workflowRunDatasets.claimRun({ clientInstanceId, runId: persisted.id });
  expect((await download(t.kai.id)).status).toBe(404);
});
