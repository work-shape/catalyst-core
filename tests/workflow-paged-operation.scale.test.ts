import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { type OperationPaging } from "@work-shape/catalyst-core";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  workflowFixture,
  publishedDefinitions,
  runSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { fetchTestOperation, listenTestInstance } from "./support/test-instance";
import { operationOf, write } from "./support/connection-operations";
import { stepRunsOf } from "./support/workflow-runs";

let t: WorkflowFixture | undefined;
afterEach(async () => {
  await t?.instance.close();
  t = undefined;
});
const row = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };
function manifest() {
  return {
    id: "paged",
    name: "Paged",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object", properties: { rows: { type: "dataset", row } } },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "rows",
        name: "Rows",
        type: "operation",
        operation: "connection.crm.echo",
        input: {},
        paginate: true,
        dataset: { at: "rows" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: { ref: { step: "rows", path: "rows" } } }
      }
    ]
  };
}
async function setup(
  paging: OperationPaging,
  options: {
    objects?: MemoryObjectStorage;
    now?: () => Date;
    pages?: number;
    pageBytes?: number;
    rows?: number;
    bytes?: number;
    pagedStepMinutes?: number;
    workflowMinutes?: number;
  } = {}
) {
  const definitions = publishedDefinitions();
  const {
    pagedStepMinutes,
    workflowMinutes,
    now,
    objects = new MemoryObjectStorage(),
    ...datasetLimits
  } = options;
  definitions.publish({
    ...manifest(),
    ...(workflowMinutes ? { limits: { pagedStepMinutes: workflowMinutes } } : {})
  });
  t = await workflowFixture({
    definitions: definitions.source,
    ...(now ? { now } : {}),
    datasetObjects: objects,
    datasetLimits: { ...workflowsConfigSchema.parse({}).datasets, ...datasetLimits },
    ceilings: {
      pagedStepMinutes: pagedStepMinutes ?? workflowsConfigSchema.parse({}).limits.pagedStepMinutes
    },
    connectorCatalog: [
      {
        name: "echo",
        description: "Reads a page",
        proposedEffect: "reading",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { rows: { type: "array", items: row } } }
      },
      write
    ]
  });
  await t.seed("crm", {
    operations: [operationOf("echo", { exposure: ["workflow"], paging: { ...paging } })]
  });
  t.state.limits = { ...t.state.limits, resultMaxBytes: 2 * 1024 ** 2 };
  await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
  const base = await listenTestInstance(t.instance);
  const headers = { "x-test-user": t.root.id, "content-type": "application/json" };
  const response = await fetchTestOperation(base, "workflows.start", {
    params: { workflow: "paged" },
    headers,
    body: JSON.stringify({ input: {} })
  });
  expect(response.status).toBe(200);
  return { fixture: t, id: runSchema.parse(await response.json()).id, objects };
}

it("stores 100,000 rows and a 1.3 MiB page without retaining rows on the step", async () => {
  const { fixture: f, id } = await setup({
    by: "page",
    param: "page",
    sizeParam: "size",
    size: 1000
  });
  f.setBehaviour(async (_op, input) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    return {
      rows:
        page > 100
          ? []
          : Array.from({ length: 1000 }, (_, offset) => ({
              id: (page - 1) * 1000 + offset,
              ...(page === 1 ? { text: "x".repeat(1400) } : {})
            }))
    };
  });
  expect((await f.finish(id)).status).toBe("done");
  const [call] = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
  expect(call?.output?.value).toMatchObject({ pages: 101, rows: 100_000 });
  const preview = (await stepRunsOf(f, id)).find((step) => step.stepId === "rows")?.outputPreview
    ?.text;
  expect(JSON.parse(preview ?? "null")).toMatchObject({ rows: { rowCount: 100_000 } });
}, 60_000);
