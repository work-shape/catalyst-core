import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isAppError } from "@vivd-catalyst/core";
import { createWorkflowFolderSource } from "@vivd-catalyst/workflows";
import { WORKFLOW_FIXTURES } from "./support/workflow-instance";

// The loader of Workflow definitions: a folder per Workflow with `workflow.yaml`, the shape a
// Workflow has as an asset. It answers a definition the engine can run or says what is wrong
// with it, so no run is ever started on a definition that cannot end.

const issuesSchema = z.object({
  reason: z.literal("definition_invalid"),
  issues: z.array(z.object({ path: z.string(), message: z.string() }))
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

describe("the definitions a folder holds", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });

  /** What reading a definition with these fields answers: the manifest, or its issues. */
  async function read(fields: Record<string, unknown>, text?: string) {
    const root = await mkdtemp(join(tmpdir(), "workflow-definitions-"));
    folders.push(root);
    await mkdir(join(root, "sample"));
    const manifest = {
      id: "sample",
      name: "Sample",
      runAs: "spn_sample",
      inputs: { type: "object" },
      outputs: { type: "object" },
      wiring: [],
      ...fields
    };
    // JSON is YAML.
    await writeFile(join(root, "sample", "workflow.yaml"), text ?? JSON.stringify(manifest));
    try {
      return { manifest: await createWorkflowFolderSource(root).read("sample") };
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.code).toBe("CONFLICT");
      return { issues: issuesSchema.parse(error.details).issues.map((issue) => issue.message) };
    }
  }

  it("reads the fixture folders and answers nothing for a folder that is not there", async () => {
    const source = createWorkflowFolderSource(WORKFLOW_FIXTURES);
    const manifest = await source.read("notify-clients");
    expect(manifest?.steps.map((step) => step.id)).toEqual([
      "start",
      "clients",
      "each_client",
      "result"
    ]);
    expect(await source.read("no-such-workflow")).toBeUndefined();
    // An id is a folder name and never a path out of the directory.
    expect(await source.read("../workflows/notify-clients")).toBeUndefined();
  });

  it("runs the steps as written where no wire is given, and in the order of the wires where they chain each step once", async () => {
    const steps = [trigger, operation("first"), operation("second"), output()];
    expect((await read({ steps })).manifest?.steps.map((step) => step.id)).toEqual([
      "start",
      "first",
      "second",
      "result"
    ]);
    const chained = await read({
      steps,
      wiring: [
        { from: "start", to: "second" },
        { from: "second", to: "first" },
        { from: "first", to: "result" }
      ]
    });
    expect(chained.issues).toBeUndefined();
    expect(
      (await read({ steps, wiring: [{ from: "start", to: "first" }] })).issues?.join(" ")
    ).toContain("do not chain each of them once");
  });

  it("refuses the step types this release does not execute, by name", async () => {
    const code = {
      id: "check",
      name: "Check",
      type: "code",
      file: "check.py",
      input: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    };
    expect((await read({ steps: [trigger, code, output()] })).issues).toEqual([
      "This release does not execute a step of the type 'code'"
    ]);
  });

  it("refuses a definition without its one trigger first and its one output last", async () => {
    expect((await read({ steps: [operation("first"), output()] })).issues).toContain(
      "The one trigger step is the first step"
    );
    expect((await read({ steps: [trigger, operation("first")] })).issues).toContain(
      "The one output step is the last step"
    );
  });

  it("refuses a step id used twice and a reference to a step that has not run before", async () => {
    expect(
      (await read({ steps: [trigger, operation("same"), operation("same"), output()] })).issues
    ).toContain("The step id 'same' is used twice");
    expect(
      (
        await read({
          steps: [
            trigger,
            operation("first", { text: ref("second", "text") }),
            operation("second"),
            output()
          ]
        })
      ).issues
    ).toEqual(["The step 'first' refers to 'second', which has not run before it"]);
    // A step after a loop cannot read a step inside it: it reads the loop's list of results.
    const loop = {
      id: "each",
      name: "Each",
      type: "loop",
      items: ref("start", "list").ref,
      steps: [operation("inner")]
    };
    expect((await read({ steps: [trigger, loop, output({ all: ref("inner") })] })).issues).toEqual([
      "The step 'result' refers to 'inner', which has not run before it"
    ]);
    expect(
      (await read({ steps: [trigger, loop, output({ all: ref("each") })] })).issues
    ).toBeUndefined();
  });

  it("lets a step of a loop read the loop's current item and the steps before the loop", async () => {
    const loop = {
      id: "each",
      name: "Each",
      type: "loop",
      items: ref("start", "list").ref,
      steps: [operation("inner", { text: ref("each", "name"), note: ref("start", "note") })]
    };
    expect((await read({ steps: [trigger, loop, output()] })).issues).toBeUndefined();
  });

  it("refuses a file that is not YAML, and a folder whose definition names another id", async () => {
    expect((await read({}, "steps: [unclosed")).issues).toEqual([
      "workflow.yaml is not valid YAML"
    ]);
    const root = await mkdtemp(join(tmpdir(), "workflow-definitions-"));
    folders.push(root);
    await mkdir(join(root, "other"));
    await writeFile(
      join(root, "other", "workflow.yaml"),
      JSON.stringify({
        id: "sample",
        name: "Sample",
        runAs: "spn_sample",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [trigger, output()],
        wiring: []
      })
    );
    await expect(createWorkflowFolderSource(root).read("other")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "definition_invalid" }
    });
  });
});
