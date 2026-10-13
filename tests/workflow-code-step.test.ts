import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@vivd-catalyst/core";
import {
  LocalWorkspaceCommandProcessExecutor,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor
} from "@vivd-catalyst/tool-execution";
import {
  WORKFLOW_CODE_STEP_EFFECT,
  createCodeStepJobs,
  parseWorkflowManifest,
  type WorkflowStepFiles
} from "@vivd-catalyst/workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// The `code` step: one script of a Workflow's `steps/` folder, run on the step's input. The
// engine stages the step and the command worker runs the script in the sandbox. Here the
// sandbox is the local one, which runs the script as a process, so the whole path is tested
// on any machine: the files, the streams, the result, the limits of time and size. What a
// container adds, its isolation and its limits of memory and processes, is tested against a
// real one in `workflow-code-sandbox.test.ts`.

const SUM = `
import json, sys
data = json.load(sys.stdin)
print("adding", len(data["numbers"]), "numbers")
print("no warnings", file=sys.stderr)
with open("output.json", "w") as out:
    json.dump({"sum": sum(data["numbers"])}, out)
`;

/** A Workflow that hands its numbers to a script and returns what the script returned. */
const compute = (step: Record<string, unknown> = {}, file = "compute.py") => ({
  id: "compute",
  name: "Compute",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "add",
      name: "Add the numbers",
      type: "code",
      file,
      input: { numbers: { ref: { step: "start", path: "input.numbers" } } },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      ...step
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { add: { ref: { step: "add", path: "" } } }
    }
  ]
});

let open: WorkflowFixture | undefined;
const directories: string[] = [];
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

interface Options {
  /** The script of `steps/compute.py`. None where the revision has no such file. */
  script?: string;
  step?: Record<string, unknown>;
  file?: string;
  timeoutSeconds?: number;
  /** In place of the local sandbox. */
  sandbox?: WorkspaceCommandProcessExecutor;
  /** Whether the instance runs a sandbox at all. */
  runner?: boolean;
}

async function ready(options: Options = {}) {
  const definitions = publishedDefinitions();
  const file = options.file ?? "compute.py";
  const revisionId = definitions.publish(compute(options.step, file));
  const asked: { workflow: string; revisionId: string; path: string }[] = [];
  const stepFiles: WorkflowStepFiles = {
    readStepFile(input) {
      asked.push(input);
      return Promise.resolve(
        options.script !== undefined && input.path === `steps/${file}`
          ? new TextEncoder().encode(options.script)
          : undefined
      );
    }
  };
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: definitions.source,
      stepFiles,
      ...(options.runner === false
        ? {}
        : { codeRunner: { timeoutSeconds: options.timeoutSeconds ?? 20 } })
    }
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "code-step-test-"));
  directories.push(tempRoot);
  // One worker serves the engine's jobs and the command worker's, as two processes do.
  const worker = t.worker([
    ...t.workflows.jobHandlers,
    ...createCodeStepJobs({
      clientInstanceId,
      stores: t.stores,
      sandbox: options.sandbox ?? new LocalWorkspaceCommandProcessExecutor(),
      tempRoot,
      slots: 2,
      limits: { cpuCount: 1, memoryBytes: 256 * 1024 * 1024, pidsLimit: 64 },
      cancelCheckMs: 50
    })
  ]);
  const begin = async (input: JsonValue = { numbers: [1, 2, 3] }) =>
    runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: "compute" },
          payload: { input }
        })
      ).json()
    );
  const run = async (input?: JsonValue) => t.finish((await begin(input)).id, worker);
  const step = async (runId: string) =>
    (await stepRunsOf(t, runId)).find((stepRun) => stepRun.stepId === "add");
  return { t, worker, begin, run, step, asked, revisionId };
}

describe("the definition of a code step", () => {
  const issues = (step: Record<string, unknown>, file?: string) => {
    const result = parseWorkflowManifest(compute(step, file));
    return result.ok ? [] : result.issues.map((issue) => [issue.code ?? "", issue.path]);
  };

  it("is accepted for a script of the runner image's languages in the step files folder", () => {
    for (const file of ["compute.py", "lib/compute.js", "compute.mjs", "a_b-c.1.py"]) {
      expect(issues({}, file), file).toEqual([]);
    }
  });

  it("is refused for a path that leaves the folder and for a language the image has not", () => {
    for (const file of [
      "../compute.py",
      "/etc/compute.py",
      "steps/../x.py",
      "a b.py",
      ".hidden.py"
    ]) {
      expect(issues({}, file), file).toEqual([["", "steps.add.file"]]);
    }
    for (const file of ["compute.rb", "compute", "compute.sh", "compute.py.txt"]) {
      expect(issues({}, file), file).toEqual([["", "steps.add.file"]]);
    }
  });

  it("is refused with not_supported_yet where it names a dataset as its input or its output", () => {
    const dataset = { type: "dataset", row: { type: "object" } };
    expect(issues({ inputSchema: { type: "object", properties: { rows: dataset } } })).toEqual([
      ["not_supported_yet", "steps[1].inputSchema"]
    ]);
    expect(issues({ outputSchema: dataset })).toEqual([
      ["not_supported_yet", "steps[1].outputSchema"]
    ]);
  });
});

describe("a Workflow with a code step", () => {
  it("runs the script on the step's input and hands its result on", async () => {
    const { t, run, step, asked, revisionId } = await ready({ script: SUM });
    const ended = await run();
    expect(ended.status).toBe("done");
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({ add: { sum: 6 } });

    const add = await step(ended.id);
    expect(add).toMatchObject({ status: "done", attempt: 1 });
    expect(JSON.parse(add?.outputPreview?.text ?? "null")).toEqual({ sum: 6 });
    // A code step changes nothing outside its container, and its step run says so.
    expect(add?.effect).toBe(WORKFLOW_CODE_STEP_EFFECT);
    expect(add?.effect).toBe("reading");
    // What the script printed beside its result is the step run's log.
    const [listed] = logsOf(
      await t.expectOk(t.root.id, "workflows.list_step_runs", {
        params: { runId: ended.id },
        query: { status: "done" }
      })
    );
    expect(listed).toEqual({
      stdout: "adding 3 numbers\n",
      stderr: "no warnings\n",
      truncated: false
    });
    // The script is read from the files of the revision the run started on.
    expect(new Set(asked.map((ask) => JSON.stringify(ask)))).toEqual(
      new Set([JSON.stringify({ workflow: "compute", revisionId, path: "steps/compute.py" })])
    );
    expect(ended.definitionRevisionId).toBe(revisionId);
    // Nothing of the script, its input or its log is in the audit.
    const audit = JSON.stringify([
      ...(await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.started" })),
      ...(await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.ended" }))
    ]);
    expect(audit).not.toContain("adding");
    expect(audit).not.toContain("numbers");
  });

  it("takes a result the script prints where it writes no file, and its error stream as the log", async () => {
    const { run, step } = await ready({
      script: `
import json, sys
data = json.load(open("input.json"))
print("reading the file as well", file=sys.stderr)
print(json.dumps({"count": len(data["numbers"])}))
`
    });
    const ended = await run();
    expect(ended.status).toBe("done");
    expect(JSON.parse((await step(ended.id))?.outputPreview?.text ?? "null")).toEqual({ count: 3 });
  });

  it("refuses the start where the revision has no such file, or one that is too large", async () => {
    const missing = await ready({});
    const refused = await missing.t.expectRefused(
      missing.t.root.id,
      "workflows.start",
      { params: { workflow: "compute" }, payload: { input: {} } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({
      reason: "code_file_missing",
      issues: [{ code: "code_file_missing", path: "steps.add.file" }]
    });
    await missing.t.instance.close();

    const large = await ready({ script: `# ${"x".repeat(300 * 1024)}` });
    const tooLarge = await large.t.expectRefused(
      large.t.root.id,
      "workflows.start",
      { params: { workflow: "compute" }, payload: { input: {} } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(tooLarge.details).toMatchObject({ reason: "code_file_too_large" });
  });

  it.each([
    [
      "an exit code other than 0",
      `import sys\nprint("it broke", file=sys.stderr)\nsys.exit(3)`,
      "code_failed"
    ],
    ["a result that is not JSON", `print("not json at all")`, "code_output_not_json"],
    ["no result", `pass`, "code_output_missing"],
    [
      "a result larger than a step output may be",
      `import json\nprint(json.dumps({"big": "x" * (300 * 1024)}))`,
      "code_output_too_large"
    ],
    [
      "a result file larger than a step output may be",
      `open("output.json", "w").write('"' + "x" * (300 * 1024) + '"')`,
      "code_output_too_large"
    ]
  ])(
    "fails the step and the run for %s, and does not run the script again",
    async (_, script, code) => {
      const { run, step } = await ready({ script });
      const ended = await run();
      expect(ended.status).toBe("failed");
      expect(ended.error?.code).toBe(code);
      const add = await step(ended.id);
      expect(add).toMatchObject({ status: "failed", attempt: 1, error: { code } });
      expect(ended.error?.stepRunId).toBe(add?.id);
    }
  );

  it("names the exit code and keeps the end of the error stream as the log, cut to its bound", async () => {
    const { t, run } = await ready({
      script: `import sys\nsys.stderr.write("e" * 100000)\nsys.exit(7)`
    });
    const ended = await run();
    expect(ended.error).toMatchObject({
      code: "code_failed",
      message: "The script ended with the exit code 7"
    });
    const [log] = logsOf(
      await t.expectOk(t.root.id, "workflows.list_step_runs", {
        params: { runId: ended.id },
        query: { status: "failed" }
      })
    );
    expect(log?.stderr).toHaveLength(16 * 1024);
    expect(log?.truncated).toBe(true);
  });

  it("checks the input and the result against the schemas the step declares", async () => {
    const strict = {
      inputSchema: {
        type: "object",
        properties: { numbers: { type: "array", items: { type: "number" } } },
        required: ["numbers"]
      },
      outputSchema: {
        type: "object",
        properties: { sum: { type: "string" } },
        required: ["sum"]
      }
    };
    const { run } = await ready({ script: SUM, step: strict });
    // The script returns a number where the step promised a text.
    expect((await run()).error?.code).toBe("code_output_invalid");
    // An input that does not fit never reaches the script.
    expect((await run({ numbers: "three" })).error?.code).toBe("code_input_invalid");
  });

  it("stops a script at the time a code step may take, and fails the step as code_timeout", async () => {
    const { run, step } = await ready({
      script: `import time\nprint("starting", flush=True)\ntime.sleep(30)`,
      timeoutSeconds: 1
    });
    const before = Date.now();
    const ended = await run();
    expect(Date.now() - before).toBeLessThan(15_000);
    expect(ended.error).toMatchObject({ code: "code_timeout" });
    expect(await step(ended.id)).toMatchObject({ status: "failed", attempt: 1 });
  }, 30_000);

  it("fails at once where the instance runs no sandbox", async () => {
    const { run } = await ready({ script: SUM, runner: false });
    const ended = await run();
    expect(ended.status).toBe("failed");
    expect(ended.error?.code).toBe("code_runner_unavailable");
  });

  it("refuses a dataset an earlier step handed on as its input", async () => {
    const { run } = await ready({ script: SUM });
    const ended = await run({ numbers: { $dataset: "ds_1", rowCount: 3, bytes: 64 } });
    expect(ended.error?.code).toBe("not_supported_yet");
  });
});

describe("a code step whose sandbox gives way", () => {
  const unstartable = (starts: { count: number }): WorkspaceCommandProcessExecutor => ({
    execute(): Promise<ProcessResult> {
      starts.count += 1;
      return Promise.resolve({
        exitCode: 127,
        stdoutPreview: "",
        stderrPreview: "",
        truncated: { stdout: false, stderr: false },
        durationMs: 1,
        spawnError: new Error("Cannot connect to the Docker daemon")
      });
    }
  });

  it("tries again where the container could not be started, and fails the step when no attempt could", async () => {
    const starts = { count: 0 };
    const { t, worker, begin, step } = await ready({ script: SUM, sandbox: unstartable(starts) });
    const started = await begin();
    const read = async () =>
      runSchema.parse(
        (await t.call(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
      );
    let ended = await read();
    for (let pass = 0; pass < 300 && ended.status !== "failed"; pass++) {
      await worker.runDue();
      await new Promise((resolve) => setTimeout(resolve, 100));
      ended = await read();
    }
    // Three attempts, with the wait of the job between them, and then the step fails.
    expect(starts.count).toBe(3);
    expect(ended.error?.code).toBe("code_runner_unavailable");
    expect(await step(started.id)).toMatchObject({ status: "failed" });
  }, 60_000);

  it("stops the script when the run is cancelled", async () => {
    const { t, worker, begin, step } = await ready({
      script: "import time\ntime.sleep(60)",
      timeoutSeconds: 120
    });
    const started = await begin();
    // The trigger, and the code step, which the engine stages.
    await worker.runDue();
    await worker.runDue();
    expect(await step(started.id)).toMatchObject({ status: "waiting" });
    // The script runs. The cancel ends the step run, and the job ends the script.
    const running = worker.runDue();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = Date.now();
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    await running;
    expect(Date.now() - before).toBeLessThan(10_000);
    expect(await step(started.id)).toMatchObject({ status: "cancelled" });
    await worker.runDue();
    expect(
      runSchema.parse(
        (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
      ).status
    ).toBe("cancelled");
  }, 60_000);

  it("runs the script again where the worker stopped in it, and finishes the run", async () => {
    const { t, worker, begin, step } = await ready({
      script: `
import json, sys, time
data = json.load(sys.stdin)
time.sleep(1.5)
print(json.dumps({"sum": sum(data["numbers"])}))
`
    });
    const started = await begin();
    await worker.runDue();
    await worker.runDue();
    const running = worker.runDue();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.stop();
    await running.catch(() => undefined);
    // Nothing failed: the step waits for a worker.
    expect(await step(started.id)).toMatchObject({ status: "waiting" });
    expect((await step(started.id))?.error).toBeUndefined();

    const next = t.worker([
      ...t.workflows.jobHandlers,
      ...createCodeStepJobs({
        clientInstanceId,
        stores: t.stores,
        sandbox: new LocalWorkspaceCommandProcessExecutor(),
        tempRoot: tmpdir(),
        slots: 2,
        limits: { cpuCount: 1, memoryBytes: 256 * 1024 * 1024, pidsLimit: 64 }
      })
    ]);
    const ended = await t.finish(started.id, next);
    expect(ended.status).toBe("done");
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({ add: { sum: 6 } });
  }, 60_000);
});

/** The logs of the step runs a list answered. */
function logsOf(response: { json(): unknown }) {
  return z
    .object({
      items: z.array(
        z.object({
          log: z
            .object({ stdout: z.string(), stderr: z.string(), truncated: z.boolean() })
            .optional()
        })
      )
    })
    .parse(response.json())
    .items.flatMap((item) => (item.log ? [item.log] : []));
}
