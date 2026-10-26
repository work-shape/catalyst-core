import { workflowStepFiles } from "./support/workflow-step-files";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import { createCodeStepJobs } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

const rowSchema = { type: "object" };
const READ_ROWS = `
import json
rows = json.load(open("input.json"))["rows"]
items = [json.loads(line) for line in open(rows["path"])] if "path" in rows else [rows]
json.dump({"ids": [row["id"] for row in items]}, open("output.json", "w"))
`;
let open: WorkflowFixture | undefined;
let tempRoot: string | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("code steps inside dataset loops", () => {
  it.each([{ batch: 5 }, { batch: undefined }])(
    "each worker script reads only its own rows (batch=$batch)",
    async ({ batch }) => {
      const base = notifyClients();
      const definitions = publishedDefinitions();
      definitions.publish({
        ...base,
        steps: [
          base.steps[0],
          { ...base.steps[1], dataset: { at: "clients" } },
          {
            id: "each",
            name: "Each",
            type: "loop",
            ...(batch === undefined ? {} : { batch }),
            concurrency: 2,
            items: { step: "clients", path: "clients" },
            steps: [
              {
                id: "read",
                name: "Read rows",
                type: "code",
                file: "read.py",
                input: { rows: { ref: { step: "each", path: "" } } },
                inputSchema: {
                  type: "object",
                  properties: {
                    rows: batch === undefined ? rowSchema : { type: "dataset", row: rowSchema }
                  },
                  required: ["rows"]
                },
                outputSchema: {
                  type: "object",
                  properties: { ids: { type: "array", items: { type: "string" } } },
                  required: ["ids"]
                }
              }
            ]
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      });
      const objects = new MemoryObjectStorage();
      const t = await readyWorkflows(
        (fixture) => {
          open = fixture;
        },
        {
          definitions: definitions.source,
          datasetObjects: objects,
          stepFiles: workflowStepFiles(["steps/read.py"], async () =>
            new TextEncoder().encode(READ_ROWS)
          ),
          codeRunner: { timeoutSeconds: 60 }
        }
      );
      const rows = Array.from({ length: 23 }, (_, index) => ({ id: `row-${index}` }));
      t.setBehaviour(async () => ({ clients: rows }));
      tempRoot = await mkdtemp(join(tmpdir(), "workflow-code-loops-"));
      const worker = t.worker([
        ...t.workflows.jobHandlers,
        ...createCodeStepJobs({
          clientInstanceId,
          stores: t.stores,
          stepFiles: t.stepFiles,
          sandbox: new LocalWorkspaceCommandProcessExecutor(),
          tempRoot,
          slots: 2,
          timeoutSeconds: 60,
          limits: {
            cpuCount: 1,
            memoryBytes: 256 * 1024 * 1024,
            pidsLimit: 64,
            scratchBytes: 32 * 1024 * 1024
          },
          datasets: { objects, limits: workflowsConfigSchema.parse({}).datasets },
          cancelCheckMs: 50
        }).handlers
      ]);
      const ended = await t.finish((await start(t)).id, worker, 400);
      expect(ended, JSON.stringify(ended.error)).toMatchObject({ status: "done" });
      const steps = await stepRunsOf(t, ended.id, { topLevel: "false", limit: 100 });
      const outputs = steps
        .filter((step) => step.stepId === "read")
        .sort((a, b) => (a.iteration?.index ?? 0) - (b.iteration?.index ?? 0))
        .map((step) => JSON.parse(step.outputPreview?.text ?? "null"));
      const size = batch ?? 1;
      expect(outputs).toEqual(
        Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => ({
          ids: rows.slice(index * size, (index + 1) * size).map((row) => row.id)
        }))
      );
      expect(
        (await readdir(tempRoot)).filter(
          (name) => !name.startsWith("catalyst-workflow-source-cache")
        )
      ).toEqual([]);
    },
    120_000
  );
});
