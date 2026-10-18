import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject, JsonValue } from "@work-shape/catalyst-core";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  publishedDefinitions,
  runSchema,
  workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import { fetchTestOperation, listenTestInstance } from "./support/test-instance";
import { operationOf, write } from "./support/connection-operations";
import { clientInstanceId } from "./support/access-instance";

let t: WorkflowFixture | undefined;
afterEach(async () => {
  await t?.instance.close();
  t = undefined;
});
const ref = (step: string, path: string) => ({ ref: { step, path } });
const trigger = {
  id: "start",
  name: "Start",
  type: "trigger",
  triggers: [{ kind: "manual" }, { kind: "parent" }]
};
const result = (input: unknown) => ({ id: "result", name: "Result", type: "output", input });
const read = {
  id: "read",
  name: "Read",
  type: "operation",
  operation: "connection.crm.echo",
  input: {}
};
const workflow = (id: string, steps: unknown[]) => ({
  id,
  name: id,
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps
});

it.each(["root_input", "operation_input", "child_input", "loop", "output", "paged_row"] as const)(
  "refuses a foreign reference through %s over HTTP",
  async (route) => {
    const definitions = publishedDefinitions();
    definitions.publish(
      workflow("source", [
        trigger,
        { ...read, dataset: { at: "rows" } },
        result({ rows: ref("read", "rows") })
      ])
    );
    definitions.publish(workflow("child", [trigger, result({})]));
    const consumer =
      route === "operation_input"
        ? [{ ...read, id: "consume", input: { wrapped: ref("read", "wrapped") } }, result({})]
        : route === "child_input"
          ? [
              {
                id: "child",
                name: "Child",
                type: "workflow",
                workflow: "child",
                input: { wrapped: ref("read", "wrapped") }
              },
              result({})
            ]
          : route === "loop"
            ? [
                {
                  id: "loop",
                  name: "Loop",
                  type: "loop",
                  items: { step: "read", path: "foreign" },
                  steps: [{ ...read, id: "consume" }]
                },
                result({})
              ]
            : [result({ wrapped: ref("read", "wrapped") })];
    definitions.publish(
      workflow(
        "target",
        route === "paged_row"
          ? [trigger, { ...read, paginate: true, dataset: { at: "rows" } }, result({})]
          : [trigger, read, ...consumer]
      )
    );
    const objects = new MemoryObjectStorage();
    t = await workflowFixture({
      definitions: definitions.source,
      datasetObjects: objects,
      connectorCatalog: [
        {
          name: "echo",
          description: "Read",
          proposedEffect: "reading",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        },
        write
      ]
    });
    const f = t;
    await f.seed("crm", {
      operations: [
        operationOf("echo", {
          exposure: ["workflow"],
          paging: { by: "page", param: "page", sizeParam: "size", size: 2 }
        })
      ]
    });
    await f.allow({ kind: "service_principal", id: f.principal.id }, "connection.use");
    await f.allow({ kind: "service_principal", id: f.principal.id }, "workflow.use");
    const base = await listenTestInstance(f.instance);
    const start = async (id: string, input: JsonObject = {}, who = f.root.id) => {
      return fetchTestOperation(base, "workflows.start", {
        params: { workflow: id },
        headers: { "x-test-user": who, "content-type": "application/json" },
        body: JSON.stringify({ input })
      });
    };
    f.setBehaviour(async () => ({ rows: [{ id: 1 }] }));
    const response = await start("source");
    expect(response.status).toBe(200);
    const source = runSchema.parse(await response.json());
    expect((await f.finish(source.id)).status).toBe("done");
    const stored = await f.stores.workflowRuns.readRun({ clientInstanceId, id: source.id });
    if (!stored) throw new Error("Source missing");
    const [dataset] = await f.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: stored.id,
      limit: 10
    });
    if (!dataset) throw new Error("Dataset missing");
    const foreign = { $dataset: dataset.id, rowCount: dataset.rowCount, bytes: dataset.bytes };
    let calls = 0;
    f.setBehaviour(async (): Promise<JsonValue> => {
      calls++;
      return { foreign, wrapped: [{ nested: foreign }], rows: [{ nested: foreign }] };
    });
    if (route === "root_input") {
      await f.allow({ kind: "user", id: f.kai.id }, "workflow.use");
      expect((await start("target", { wrapped: [{ nested: foreign }] }, f.kai.id)).status).toBe(
        403
      );
      expect(calls).toBe(0);
      return;
    }
    const attempted = await start("target");
    expect(attempted.status).toBe(200);
    const target = runSchema.parse(await attempted.json());
    const finished = await f.finish(target.id);
    expect(finished).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN", message: "This run cannot read the dataset" }
    });
    expect(calls).toBe(1);
    const got = await fetchTestOperation(base, "workflows.get_run", {
      params: { runId: target.id },
      headers: { "x-test-user": f.root.id }
    });
    expect(z.object({ status: z.string() }).parse(await got.json()).status).toBe("failed");
  }
);
