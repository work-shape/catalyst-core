import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_MAX_BLOCK_DEPTH, isAppError } from "@work-shape/catalyst-core";
import { createWorkflowFolderSource, parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { WORKFLOW_FIXTURES } from "./support/workflow-instance";

// The loader of Workflow definitions: a folder per Workflow with `workflow.yaml`, the shape a
// Workflow has as an asset. It answers a definition the engine can run or says what is wrong
// with it, so no run is ever started on a definition that cannot end. The file form is the
// contract's: an ordered list of steps with nested blocks.

const refusalSchema = z.object({
  reason: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
});

const trigger = { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] };
const output = (input: Record<string, unknown> = {}) => ({
  id: "result",
  name: "Result",
  type: "output",
  input
});
const operation = (id: string, input: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "operation",
  operation: "connection.crm.echo",
  input
});
const ref = (step: string, path = "") => ({ ref: { step, path } });
const loop = (id: string, steps: unknown[], fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "loop",
  items: { step: "start", path: "input.list" },
  steps,
  ...fields
});
const sample = (fields: Record<string, unknown>) => ({
  id: "sample",
  name: "Sample",
  runAs: "sample-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  ...fields
});

/** The codes and the paths of what keeps a definition from being run. */
function refused(fields: Record<string, unknown>) {
  const result = parseWorkflowManifest(sample(fields));
  if (result.ok) return [];
  return result.issues.map((issue) => [issue.code ?? "", issue.path]);
}

describe("the definitions a folder holds", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });

  /** What reading a definition with these fields answers: the manifest, or its refusal. */
  async function read(fields: Record<string, unknown>, text?: string) {
    const root = await mkdtemp(join(tmpdir(), "workflow-definitions-"));
    folders.push(root);
    await mkdir(join(root, "sample"));
    // JSON is YAML.
    await writeFile(join(root, "sample", "workflow.yaml"), text ?? JSON.stringify(sample(fields)));
    try {
      return { revision: await createWorkflowFolderSource(root).read("sample") };
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.code).toBe("VALIDATION_FAILED");
      const refusal = refusalSchema.parse(error.details);
      return { reason: refusal.reason, issues: refusal.issues.map((issue) => issue.message) };
    }
  }

  it("reads the fixture folders, names their revision and lists them", async () => {
    const source = createWorkflowFolderSource(WORKFLOW_FIXTURES);
    const revision = await source.read("notify-clients");
    expect(revision?.manifest.steps.map((step) => step.id)).toEqual([
      "start",
      "clients",
      "each_client",
      "result"
    ]);
    // The same file is the same revision, and the id says nothing but that.
    expect(revision?.revisionId).toMatch(/^[0-9a-f]{64}$/u);
    expect((await source.read("notify-clients"))?.revisionId).toBe(revision?.revisionId);
    expect(await source.read("no-such-workflow")).toBeUndefined();
    // An id is a folder name and never a path out of the directory.
    expect(await source.read("../workflows/notify-clients")).toBeUndefined();
    // A folder whose file cannot be run is no Workflow of the list.
    expect((await source.list()).map((workflow) => workflow.id)).toEqual([
      "notify-clients",
      "top-customers"
    ]);
  });

  it("runs the steps in the order of the list and refuses a file with wiring, edges or positions", async () => {
    const steps = [trigger, operation("first"), operation("second"), output()];
    const read1 = await read({ steps });
    expect(read1.revision?.manifest.steps.map((step) => step.id)).toEqual([
      "start",
      "first",
      "second",
      "result"
    ]);
    for (const extra of [
      { wiring: [{ from: "start", to: "second" }] },
      { edges: [] },
      { positions: { start: { x: 0, y: 0 } } }
    ]) {
      const refusal = await read({ steps, ...extra });
      expect(refusal.reason).toBe("definition_invalid");
      expect(refusal.issues?.join(" ")).toContain("Unrecognized key");
    }
    expect(
      refused({ steps: [trigger, { ...operation("first"), position: { x: 1, y: 2 } }, output()] })
    ).toEqual([["", "steps.1"]]);
  });

  it("gives a loop its defaults: it stops at a failed item and runs one item at a time", () => {
    const result = parseWorkflowManifest(
      sample({ steps: [trigger, loop("each", [operation("inner")]), output()] })
    );
    expect(result.ok && result.manifest.steps[1]).toMatchObject({
      type: "loop",
      onItemFailure: "stop",
      concurrency: 1
    });
    expect(
      refused({
        steps: [
          trigger,
          loop("each", [operation("inner")], { onItemFailure: "continue" }),
          output()
        ]
      })
    ).toEqual([]);
  });

  it("reads the reserved blocks and refuses them with not_supported_yet, whatever they hold", async () => {
    const condition = {
      id: "check",
      name: "Check",
      type: "condition",
      when: { ref: { step: "start", path: "input.flag" }, op: "equals", value: true },
      then: [operation("yes")],
      else: [operation("no")]
    };
    const parallel = {
      id: "both",
      name: "Both",
      type: "parallel",
      branches: [
        { id: "left", name: "Left", steps: [operation("a")] },
        { id: "right", name: "Right", steps: [operation("b")] }
      ],
      concurrency: 2
    };
    expect(refused({ steps: [trigger, condition, output()] })).toEqual([
      ["not_supported_yet", "steps.check"]
    ]);
    expect(refused({ steps: [trigger, parallel, output()] })).toEqual([
      ["not_supported_yet", "steps.both"]
    ]);
    // Inside a loop, without an `else`, and without a branch.
    const { else: _else, ...bare } = condition;
    expect(refused({ steps: [trigger, loop("each", [bare]), output()] })).toEqual([
      ["not_supported_yet", "steps.check"]
    ]);
    expect(refused({ steps: [trigger, { ...parallel, branches: [] }, output()] })).toEqual([
      ["not_supported_yet", "steps.both"]
    ]);
    const refusal = await read({ steps: [trigger, condition, output()] });
    expect(refusal.reason).toBe("not_supported_yet");
    expect(refusal.issues).toEqual([
      "Step 'check' has the type 'condition', which is not supported yet (not_supported_yet)"
    ]);
    // A type no release knows is refused the same way.
    expect(
      refused({ steps: [trigger, { id: "x", name: "X", type: "teleport" }, output()] })
    ).toEqual([["not_supported_yet", "steps.1.type"]]);
  });

  it("refuses what the contract's block check refuses, by its code", async () => {
    // A step after a loop cannot read a step inside it, and no step reads a later one.
    expect(
      refused({
        steps: [trigger, loop("each", [operation("inner")]), output({ all: ref("inner") })]
      })
    ).toEqual([["reference_out_of_scope", "steps.result"]]);
    expect(
      refused({
        steps: [trigger, operation("first", { text: ref("second") }), operation("second"), output()]
      })
    ).toEqual([["reference_out_of_scope", "steps.first"]]);
    expect(refused({ steps: [trigger, operation("same"), operation("same"), output()] })).toEqual([
      ["duplicate_step_id", "steps.same"]
    ]);

    let steps: unknown[] = [operation("leaf")];
    for (let level = WORKFLOW_MAX_BLOCK_DEPTH; level >= 1; level -= 1) {
      steps = [loop(`loop-${String(level)}`, steps)];
    }
    expect(refused({ steps: [trigger, ...steps, output()] })).toEqual([]);
    expect(refused({ steps: [trigger, loop("loop-0", steps), output()] })).toEqual([
      ["block_depth", `steps.loop-${String(WORKFLOW_MAX_BLOCK_DEPTH)}`]
    ]);
    expect((await read({ steps: [trigger, loop("loop-0", steps), output()] })).reason).toBe(
      "block_depth"
    );
  });

  it("refuses by name what the file form holds and this engine does not run", () => {
    const code = {
      id: "check",
      name: "Check",
      type: "agent",
      instructions: "check.md",
      input: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    };
    const inner = [operation("inner")];
    const cases: [Record<string, unknown>, string][] = [
      [{ steps: [trigger, code, output()] }, "steps[1].type"],
      [
        { steps: [trigger, loop("each", inner, { collect: ref("inner").ref }), output()] },
        "steps[1].collect"
      ],
      [{ steps: [trigger, output()], labels: { month: { value: "2026-10" } } }, "labels"],
      [{ steps: [trigger, output()], onFailure: "notify" }, "onFailure"]
    ];
    for (const [fields, path] of cases) {
      expect(refused(fields)).toEqual([["not_supported_yet", path]]);
    }
    // `collect` names the loop's last step: any other is the block check's refusal.
    expect(
      refused({
        steps: [
          trigger,
          loop("each", [operation("one"), operation("two")], { collect: ref("one").ref }),
          output()
        ]
      })
    ).toContainEqual(["reference_out_of_scope", "steps.each"]);
  });

  it("takes a field of a mapping as a literal or a reference, never both", () => {
    expect(
      refused({ steps: [trigger, operation("first", { text: { value: "a" } }), output()] })
    ).toEqual([]);
    expect(
      refused({
        steps: [trigger, operation("first", { text: { value: "a", ...ref("start") } }), output()]
      })
    ).not.toEqual([]);
    expect(refused({ steps: [trigger, operation("first", { text: {} }), output()] })).not.toEqual(
      []
    );
    // A literal is no dataset: one that carries the key of one is refused where it is written.
    expect(
      refused({
        steps: [trigger, operation("first", { rows: { value: { $dataset: 5 } } }), output()]
      })
    ).toEqual([["", "steps.first.input.rows"]]);
    expect(
      refused({
        steps: [trigger, output({ rows: { value: [{ nested: { $dataset: "x" } }] } })]
      })
    ).toEqual([["", "steps.result.input.rows"]]);
    // The key that marks a dataset in step data names no field a definition declares.
    expect(
      refused({
        steps: [trigger, output()],
        outputs: { type: "object", properties: { $dataset: { type: "string" } } }
      })
    ).toEqual([["", "outputs"]]);
  });

  it("refuses a definition without its one trigger first and its one output last", async () => {
    expect((await read({ steps: [operation("first"), output()] })).issues).toContain(
      "The one trigger step is the first step"
    );
    expect((await read({ steps: [trigger, operation("first")] })).issues).toContain(
      "The one output step is the last step"
    );
    expect(
      (await read({ steps: [trigger, operation("first", { text: ref("nobody") }), output()] }))
        .issues
    ).toEqual(["The step 'first' refers to 'nobody', and no step has that id"]);
  });

  it("lets a step of a loop read the loop's current item and the steps before the loop", async () => {
    const each = loop("each", [
      operation("inner", { text: ref("each", "name"), note: ref("start", "input.note") })
    ]);
    expect(
      (await read({ steps: [trigger, each, output({ done: ref("each", "done") })] })).issues
    ).toBeUndefined();
  });

  it("refuses a file nested deeper than a definition may be, however deep, without reading it by recursion", async () => {
    // Blocks nested far deeper than the stack is: as a value, and as the text of a file.
    let steps: unknown[] = [operation("leaf")];
    for (let level = 0; level < 20_000; level += 1) steps = [loop(`l${String(level)}`, steps)];
    const result = parseWorkflowManifest(sample({ steps: [trigger, ...steps, output()] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.message)).toEqual([
      "workflow.yaml is nested deeper than 256 levels"
    ]);
    const deepSchema = parseWorkflowManifest(
      sample({
        steps: [trigger, output()],
        inputs: JSON.parse(`${'{"a":'.repeat(300)}1${"}".repeat(300)}`)
      })
    );
    expect(!deepSchema.ok && deepSchema.issues.map((issue) => issue.message)).toEqual([
      "workflow.yaml is nested deeper than 256 levels"
    ]);
    const text = `steps: ${"[".repeat(60_000)}${"]".repeat(60_000)}`;
    const refusal = await read({}, text);
    expect(refusal.reason).toBe("definition_invalid");
    // The reader of YAML refuses it itself; either way it is a refusal and no crash.
    expect(refusal.issues).toHaveLength(1);
  });

  it("refuses a file that is not YAML, and a folder whose definition names another id", async () => {
    expect((await read({}, "steps: [unclosed")).issues).toEqual([
      expect.stringContaining("'workflow.yaml' is not valid YAML")
    ]);
    const root = await mkdtemp(join(tmpdir(), "workflow-definitions-"));
    folders.push(root);
    await mkdir(join(root, "other"));
    await writeFile(
      join(root, "other", "workflow.yaml"),
      JSON.stringify(sample({ steps: [trigger, output()] }))
    );
    await expect(createWorkflowFolderSource(root).read("other")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "definition_invalid" }
    });
  });
});

it("checks dataset row compatibility structurally across named child contracts", async () => {
  const { checkChildContracts } = await import("@work-shape/catalyst-workflows");
  const named = (type: string | string[], required: string[]) => ({
    type: "object",
    properties: { id: { type }, extra: { type: "string" } },
    required
  });
  const child = parseWorkflowManifest({
    id: "row-child",
    name: "Child",
    runAs: "runner",
    types: { expected: named("string", ["id"]) },
    inputs: {
      type: "object",
      properties: { rows: { type: "dataset", row: { $ref: "#/types/expected" } } },
      required: ["rows"]
    },
    outputs: { type: "object" },
    steps: [{ ...trigger, triggers: [{ kind: "parent" }] }, output()]
  });
  if (!child.ok) throw new Error("Invalid child fixture");
  const source = { read: async () => ({ revisionId: "r1", manifest: child.manifest }) };
  const parent = (row: Record<string, unknown>) =>
    parseWorkflowManifest({
      id: "row-parent",
      name: "Parent",
      runAs: "runner",
      types: { actual: row },
      inputs: {
        type: "object",
        properties: { rows: { type: "dataset", row: { $ref: "#/types/actual" } } }
      },
      outputs: { type: "object" },
      steps: [
        trigger,
        {
          id: "child",
          name: "Child",
          type: "workflow",
          workflow: "row-child",
          input: { rows: ref("start", "input.rows") }
        },
        output()
      ]
    });
  for (const row of [named("integer", ["id"]), named("string", [])]) {
    const parsed = parent(row);
    if (!parsed.ok) throw new Error("Invalid parent fixture");
    await expect(checkChildContracts(parsed.manifest, source)).rejects.toMatchObject({
      details: { reason: "dataset_schema_invalid" }
    });
  }
  const wider = parent(named("string", ["id", "extra"]));
  if (!wider.ok) throw new Error("Invalid wider fixture");
  await expect(checkChildContracts(wider.manifest, source)).resolves.toBeUndefined();
  const nullableSource = {
    read: async () => ({
      revisionId: "r2",
      manifest: { ...child.manifest, types: { expected: named(["string", "null"], ["id"]) } }
    })
  };
  const nullable = parent(named(["string", "null"], ["id"]));
  if (!nullable.ok) throw new Error("Invalid nullable fixture");
  await expect(checkChildContracts(nullable.manifest, nullableSource)).resolves.toBeUndefined();
  const tooWide = parent(named(["string", "null", "integer"], ["id"]));
  if (!tooWide.ok) throw new Error("Invalid union fixture");
  await expect(checkChildContracts(tooWide.manifest, nullableSource)).rejects.toMatchObject({
    details: { reason: "dataset_schema_invalid" }
  });
  const dottedRow = {
    type: "object",
    properties: { "client.id": { type: "string" } },
    required: ["client.id"]
  };
  const dottedSource = {
    read: async () => ({
      revisionId: "r3",
      manifest: { ...child.manifest, types: { expected: dottedRow } }
    })
  };
  const dotted = parent(dottedRow);
  if (!dotted.ok) throw new Error("Invalid dotted fixture");
  await expect(checkChildContracts(dotted.manifest, dottedSource)).resolves.toBeUndefined();
  const arrays = {
    type: "object",
    properties: { id: { type: ["array", "null"], items: { type: "string" } } },
    required: ["id"]
  };
  const arraySource = {
    read: async () => ({
      revisionId: "r4",
      manifest: { ...child.manifest, types: { expected: arrays } }
    })
  };
  const wrongItems = parent({
    ...arrays,
    properties: { id: { type: ["array", "null"], items: { type: "integer" } } }
  });
  if (!wrongItems.ok) throw new Error("Invalid array fixture");
  await expect(checkChildContracts(wrongItems.manifest, arraySource)).rejects.toMatchObject({
    details: { reason: "dataset_schema_invalid" }
  });
});
