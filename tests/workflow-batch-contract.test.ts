import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  operationBatchResultSchema,
  workflowDatasetReferenceSchema,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import {
  parseWorkflowManifest,
  createCodeSandbox,
  checkDatasetContracts,
  type CodeStepDatasets
} from "@work-shape/catalyst-workflows";

const reference = { $dataset: "parent", rowCount: 3, bytes: 200, offset: 500 };
describe("dataset view contracts", () => {
  it.each([-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1])("refuses invalid offsets (%s)", (offset) => {
    expect(workflowDatasetReferenceSchema.safeParse({ ...reference, offset }).success).toBe(false);
  });
  it("keeps offsets in batch failures and accepts a positive loop batch size", () => {
    expect(
      operationBatchResultSchema.parse({ done: 997, failed: 3, failures: reference }).failures
        .offset
    ).toBe(500);
    const manifest = {
      id: "batch",
      name: "Batch",
      runAs: "runner",
      inputs: {},
      outputs: {},
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "each",
          name: "Each",
          type: "loop",
          batch: 500,
          items: { step: "start", path: "input.rows" },
          steps: [
            {
              id: "call",
              name: "Call",
              type: "operation",
              operation: "fixture.process",
              input: { rows: { ref: { step: "each", path: "" } } }
            }
          ]
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    expect(parseWorkflowManifest(manifest)).toMatchObject({ ok: true });
    for (const batch of [0, -1, 1.5, "500", Number.MAX_SAFE_INTEGER + 1])
      expect(
        parseWorkflowManifest({
          ...manifest,
          steps: manifest.steps.map((step) => (step.type === "loop" ? { ...step, batch } : step))
        }).ok
      ).toBe(false);
  });
  it("checks the row contract of a batch passed into a code step", async () => {
    const row = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };
    const definition = (required: string) =>
      parseWorkflowManifest({
        id: "batch-types",
        name: "Batch types",
        runAs: "runner",
        inputs: { type: "object", properties: { rows: { type: "dataset", row } } },
        outputs: {},
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          {
            id: "each",
            name: "Each",
            type: "loop",
            batch: 500,
            items: { step: "start", path: "input.rows" },
            steps: [
              {
                id: "code",
                name: "Code",
                type: "code",
                file: "run.py",
                input: { rows: { ref: { step: "each", path: "" } } },
                inputSchema: {
                  type: "object",
                  properties: { rows: { type: "dataset", row: { ...row, required: [required] } } }
                },
                outputSchema: {}
              }
            ]
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      });
    const good = definition("id"),
      bad = definition("missing");
    if (!good.ok || !bad.ok) throw new Error("Invalid test definition");
    const definitions = { read: async () => undefined };
    await expect(checkDatasetContracts(good.manifest, definitions)).resolves.toBeUndefined();
    await expect(checkDatasetContracts(bad.manifest, definitions)).rejects.toMatchObject({
      details: { reason: "dataset_schema_invalid" }
    });
    // The loop reference means its counts after the loop, rather than its current batch.
    const outside = {
      ...good.manifest,
      outputs: { type: "object", properties: { counts: { type: "dataset", row } } },
      steps: good.manifest.steps.map((step) =>
        step.type === "output"
          ? { ...step, input: { counts: { ref: { step: "each", path: "" } } } }
          : step
      )
    };
    await expect(checkDatasetContracts(outside, definitions)).rejects.toMatchObject({
      details: { reason: "dataset_schema_invalid" }
    });
  });
  it("recognizes a batch descriptor's failures reference as a typed dataset", async () => {
    const parsed = parseWorkflowManifest({
      id: "batch-output",
      name: "Batch output",
      runAs: "runner",
      inputs: {},
      outputs: {
        type: "object",
        properties: {
          failures: {
            type: "dataset",
            row: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" } },
              required: ["code", "message"]
            }
          }
        }
      },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "batch", name: "Batch", type: "operation", operation: "fixture.batch", input: {} },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: { failures: { ref: { step: "batch", path: "failures" } } }
        }
      ]
    });
    if (!parsed.ok) throw new Error("Invalid test definition");
    const descriptor: OperationDefinition = {
      name: "fixture.batch",
      effect: "reading",
      auth: "principal",
      action: "connection.use",
      scope: null,
      timeoutMs: 1000,
      batch: true,
      inputSchema: z.object({}),
      outputSchema: operationBatchResultSchema,
      outputJsonSchema: {
        type: "object",
        properties: {
          failures: {
            type: "object",
            properties: {
              $dataset: { type: "string" },
              rowCount: { type: "integer" },
              bytes: { type: "integer" }
            }
          }
        }
      },
      resource: () => undefined,
      execute: async () => {
        throw new Error("Metadata only");
      }
    };
    const definitions = { read: async () => undefined },
      registry = { resolve: async () => descriptor };
    await expect(
      checkDatasetContracts(parsed.manifest, definitions, registry)
    ).resolves.toBeUndefined();
    descriptor.batch = undefined;
    await expect(
      checkDatasetContracts(parsed.manifest, definitions, registry)
    ).rejects.toMatchObject({ details: { reason: "dataset_schema_invalid" } });
  });
  it("passes ranges to code readers and deduplicates equal views without aliasing different slices", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ew-batch-code-"));
    try {
      const requested: unknown[] = [];
      const datasets: CodeStepDatasets = {
        rowBytes: 256,
        async rows(_id, view) {
          requested.push(view);
          return (async function* () {
            for (let i = 0; i < (view?.rowCount ?? 0); i++)
              yield { index: (view?.offset ?? 0) + i };
          })();
        },
        store: async () => {
          throw new Error("No output here");
        }
      };
      const other = { ...reference, offset: 503, rowCount: 2 };
      const sandbox = createCodeSandbox({
        tempRoot: directory,
        outputMaxBytes: 1024,
        limits: { cpuCount: 1, memoryBytes: 1024 * 1024, pidsLimit: 16, scratchBytes: 4096 },
        sandbox: {
          dataPaths: { input: "/work/in", output: "/work/out" },
          async execute(input) {
            expect(JSON.parse(await readFile(join(input.cwd, "input.json"), "utf8"))).toEqual({
              first: { path: "/work/in/first.jsonl", rowCount: 3 },
              again: { path: "/work/in/first.jsonl", rowCount: 3 },
              other: { path: "/work/in/other.jsonl", rowCount: 2 }
            });
            if (!input.dataDirectories) throw new Error("Missing data directories");
            expect(await readFile(join(input.dataDirectories.input, "first.jsonl"), "utf8")).toBe(
              '{"index":500}\n{"index":501}\n{"index":502}\n'
            );
            expect(await readFile(join(input.dataDirectories.input, "other.jsonl"), "utf8")).toBe(
              '{"index":503}\n{"index":504}\n'
            );
            return {
              exitCode: 0,
              stdoutPreview: "{}",
              stderrPreview: "",
              truncated: { stdout: false, stderr: false },
              durationMs: 1
            };
          }
        }
      });
      const result = await sandbox.run({
        id: "view-input",
        staged: {
          language: "python",
          file: "run.py",
          source: "",
          input: { first: reference, again: reference, other },
          timeoutSeconds: 10
        },
        datasets,
        signal: new AbortController().signal
      });
      expect(result).toMatchObject({ kind: "ended", outcome: { kind: "output" } });
      expect(requested).toEqual([reference, other]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
