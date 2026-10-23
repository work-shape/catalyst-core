import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@work-shape/catalyst-core";
import {
  createDockerRunInvocation,
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "@work-shape/catalyst-tool-execution";
import {
  WORKFLOW_CODE_STEP_EFFECT,
  createCodeStepJobs,
  parseWorkflowManifest,
  type WorkflowStepFiles
} from "@work-shape/catalyst-workflows";
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

/** What a code step's container gets in these tests: little, so a limit is reached fast. */
const LIMITS = {
  cpuCount: 1,
  memoryBytes: 128 * 1024 * 1024,
  pidsLimit: 64,
  scratchBytes: 16 * 1024 * 1024
};

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
      timeoutSeconds: options.timeoutSeconds ?? 20,
      limits: LIMITS,
      cancelCheckMs: 50
    }).handlers
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
  return { t, worker, begin, run, step, asked, revisionId, tempRoot };
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

  it("is accepted where it names a dataset as its input or its output (EW-14a)", () => {
    const dataset = { type: "dataset", row: { type: "object" } };
    expect(issues({ inputSchema: { type: "object", properties: { rows: dataset } } })).toEqual([]);
    expect(issues({ outputSchema: { type: "object", properties: { findings: dataset } } })).toEqual(
      []
    );
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

  it("hands its sandbox no skill folder: a container of a code step has no /skills", async () => {
    const local = new LocalWorkspaceCommandProcessExecutor();
    const handed: WorkspaceCommandProcessInput[] = [];
    // A sandbox that would mount skill folders, as the container one does.
    const sandbox: WorkspaceCommandProcessExecutor = {
      mountsSkillFolders: true,
      execute(input) {
        handed.push(input);
        return local.execute(input);
      }
    };
    const { run } = await ready({ script: SUM, sandbox });
    expect((await run()).status).toBe("done");
    const [input] = handed;
    if (!handed.length || !input) throw new Error("The code step handed no command to its sandbox");
    expect(handed).toHaveLength(1);
    expect(input.skillFolders).toBeUndefined();
    const { args } = createDockerRunInvocation(input, {
      image: "runner:test",
      runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
    });
    expect(args.filter((arg) => arg.includes("/skills"))).toEqual([]);
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

  it("refuses an unowned dataset at start before a code step can see it", async () => {
    const { t } = await ready({ script: SUM });
    const response = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "compute" },
      payload: { input: { numbers: { $dataset: "ds_1", rowCount: 3, bytes: 64 } } }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { details: { reason: "dataset_expired" } } });
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
        timeoutSeconds: 20,
        limits: LIMITS
      }).handlers
    ]);
    const ended = await t.finish(started.id, next);
    expect(ended.status).toBe("done");
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({ add: { sum: 6 } });
  }, 60_000);
});

// What a script starts and leaves running. Every process it starts carries a mark of this
// file on its command line: a test looks for it on the host after the step, and the file
// kills every process with the mark after each test, whatever the test found, so a test that
// fails leaves nothing running. A process that left its session is no child of anything the
// test knows, and only the mark finds it. A writer on this host also writes its pid to a file
// the cleanup reads, and that pid is killed too while it carries the mark: where `pkill` is
// missing or misses it.
// A writer ends by itself all the same, at WRITER_SECONDS or WRITER_BYTES, whichever comes
// first: a run that is killed before its cleanup leaves a writer that stops, never one that
// fills the disk with a file nobody can see any more.
const MARK = `catalyst-writer-${randomUUID()}`;
let marks = 0;
/** A mark of its own for one test, which the file's mark finds too. */
const nextMark = () => `${MARK}-${String((marks += 1))}`;
const WRITERS = mkdtempSync(join(tmpdir(), "code-step-writers-"));
/** Where each writer started on this host writes its pid. A container's writer cannot. */
const WRITER_PIDS = join(WRITERS, "pids");

/** The command line of a process, or "" where there is none. */
async function commandLineOf(pid: number): Promise<string> {
  try {
    if (process.platform === "linux") {
      return (await readFile(`/proc/${String(pid)}/cmdline`, "utf8")).replaceAll("\0", " ");
    }
    const { stdout } = await promisify(execFile)("ps", [
      "-ww",
      "-o",
      "command=",
      "-p",
      String(pid)
    ]);
    return stdout;
  } catch {
    return "";
  }
}

/** Kills every writer of this file: by its mark, and by the pid it wrote. */
async function killWriters(): Promise<void> {
  await promisify(execFile)("pkill", ["-KILL", "-f", MARK]).catch(() => undefined);
  const pids = await readFile(WRITER_PIDS, "utf8").catch(() => "");
  for (const pid of pids.split(/\s+/u).filter(Boolean).map(Number)) {
    // A pid the host has given to another process since is left alone.
    if (!(await commandLineOf(pid)).includes(MARK)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It ended in the meantime.
    }
  }
}
afterEach(killWriters);
afterAll(async () => {
  await killWriters();
  await rm(WRITERS, { recursive: true, force: true });
});

/** How a script starts a process that outlives it, unless the sandbox ends it. */
const WAYS = [
  "a child",
  "a child in a session of its own",
  "a grandchild of a double fork"
] as const;
type Way = (typeof WAYS)[number];

/** How long a writer writes at most, unless something ends it before. */
const WRITER_SECONDS = 120;
/** How much a writer writes at most: some 80 to 100 seconds of writing. */
const WRITER_BYTES = 64 * 1024 * 1024;

/**
 * Python that appends to `output.json` until something ends it, or until WRITER_SECONDS or
 * WRITER_BYTES, as one line of a string literal. Its arguments are its mark and the file it
 * writes its pid to. It writes up to 800 KB a second: past a result's limit within a script's
 * second, and still writing long after any test of it looked.
 */
const WRITE = [
  "import os, sys, time",
  "try:",
  "    with open(sys.argv[2], 'a') as pids:",
  "        pids.write(' %d ' % os.getpid())",
  "except OSError:",
  "    pass",
  `end = time.monotonic() + ${String(WRITER_SECONDS)}`,
  "written = 0",
  "with open('output.json', 'a') as out:",
  `    while written < ${String(WRITER_BYTES)} and time.monotonic() < end:`,
  "        out.write('1,' * 4096)",
  "        out.flush()",
  "        written += 8192",
  "        time.sleep(0.01)"
].join("\\n");

/**
 * A script that starts a process that keeps appending to `output.json` (WRITE), waits until
 * it wrote, and ends `seconds` later. The writer is started by name: the sandbox of these tests
 * hands a script no PATH, and without one Python on Linux does not know its own path
 * (`sys.executable` is empty). A writer that `holdsStreams` keeps the script's output and
 * error streams open; any other has none of them.
 */
function startsWriter(
  way: Way,
  mark: string,
  options: { seconds?: number; holdsStreams?: boolean } = {}
): string {
  const start = {
    "a child": ["subprocess.Popen(argv, **quiet)"],
    "a child in a session of its own": ["subprocess.Popen(argv, start_new_session=True, **quiet)"],
    "a grandchild of a double fork": [
      "first = os.fork()",
      "if first == 0:",
      "    os.setsid()",
      "    if os.fork() == 0:",
      ...(options.holdsStreams
        ? []
        : [
            "        null = os.open(os.devnull, os.O_RDWR)",
            "        for fd in (0, 1, 2): os.dup2(null, fd)"
          ]),
      "        os.execvp('python3', argv)",
      "    os._exit(0)",
      "os.waitpid(first, 0)"
    ]
  }[way];
  return [
    "import os, subprocess, sys, time",
    `argv = ["python3", "-c", "${WRITE}", "${mark}", ${JSON.stringify(WRITER_PIDS)}]`,
    options.holdsStreams
      ? "quiet = {}"
      : "quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    ...start,
    // The writer wrote before the script goes on: what a test finds afterwards is no accident.
    // The error stream reaches the log at once, also from a script that is stopped.
    "while not os.path.isfile('output.json') or os.path.getsize('output.json') < 65536:",
    "    time.sleep(0.01)",
    "print('the writer writes', file=sys.stderr, flush=True)",
    `time.sleep(${String(options.seconds ?? 1.5)})`
  ].join("\n");
}

/**
 * The processes on the host with the mark. With an image, the host is the one the engine
 * runs containers on, seen from a container in its process namespace. The first letter is a
 * class of its own, so the pattern does not find the command that carries it.
 */
async function marked(mark: string, image?: string): Promise<string[]> {
  const pattern = `[${mark.slice(0, 1)}]${mark.slice(1)}`;
  const [command, args] = image
    ? ["docker", ["run", "--rm", "--pid=host", "--entrypoint", "pgrep", image, "-f", pattern]]
    : ["pgrep", ["-f", pattern]];
  try {
    const { stdout } = await promisify(execFile)(command, args);
    return stdout.split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    // pgrep ends with 1 where it found nothing.
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
}

/** What has the mark once a kill had a moment to arrive: nothing, where the sandbox ended it. */
async function survivorsOf(mark: string, image?: string): Promise<string[]> {
  let left = await marked(mark, image);
  for (let pass = 0; pass < 20 && left.length > 0; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = await marked(mark, image);
  }
  return left;
}

/** Cancels the run once the writer of its script runs. Answers what had the mark by then. */
async function cancelOnceWriting(
  prepared: Awaited<ReturnType<typeof ready>>,
  mark: string,
  image?: string
): Promise<string[]> {
  const { t, worker, begin, step } = prepared;
  const started = await begin();
  // The trigger, and the code step, which the engine stages.
  await worker.runDue();
  await worker.runDue();
  expect(await step(started.id)).toMatchObject({ status: "waiting" });
  const job = worker.runDue();
  let running: string[] = [];
  for (let pass = 0; pass < 100 && running.length === 0; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    running = await marked(mark, image);
  }
  await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
  await job;
  expect(await step(started.id)).toMatchObject({ status: "cancelled" });
  return running;
}

// What a script may leave in the place of its result. The worker never opens it: the command
// that ran the script reads a regular file and nothing else, inside the sandbox and within
// the script's time limit. Each case names how its step ends.
const LEFT_BEHIND: [string, string, string][] = [
  ["a named pipe", `import os\nos.mkfifo("output.json")`, "code_output_missing"],
  [
    "a socket",
    `import socket\nserver = socket.socket(socket.AF_UNIX)\nserver.bind("output.json")`,
    "code_output_missing"
  ],
  ["a directory", `import os\nos.mkdir("output.json")`, "code_output_missing"],
  [
    "a link to a file of the host",
    `import os\nos.symlink("/etc/passwd", "output.json")`,
    "code_output_missing"
  ],
  [
    "a link to a pipe",
    `import os\nos.mkfifo("pipe")\nos.symlink("pipe", "output.json")`,
    "code_output_missing"
  ],
  [
    "a file of 10 GB that holds nothing",
    `import os\nwith open("output.json", "w") as out:\n    out.write("[")\nos.truncate("output.json", 10 * 1024 * 1024 * 1024)`,
    "code_output_too_large"
  ],
  [
    "a file another process keeps writing to",
    startsWriter("a child", `${MARK}-left-behind`),
    "code_output_too_large"
  ]
];

describe("what a script leaves in the place of its result", () => {
  it.each(LEFT_BEHIND)(
    "ends the step for %s without the worker waiting on it",
    async (_, script, code) => {
      const { run, step } = await ready({ script, timeoutSeconds: 20 });
      const before = Date.now();
      const ended = await run();
      // Well within the time a script may take: nothing waited for a writer or an end.
      expect(Date.now() - before).toBeLessThan(15_000);
      expect(ended.status).toBe("failed");
      expect(ended.error?.code).toBe(code);
      expect(await step(ended.id)).toMatchObject({ status: "failed", attempt: 1 });
      // Nothing the script started is left running.
      expect(await survivorsOf(MARK)).toEqual([]);
    },
    60_000
  );

  it("leaves the worker able to run the next steps after five pipes", async () => {
    const pipe = LEFT_BEHIND[0]?.[1] ?? "";
    const { run } = await ready({ script: pipe });
    for (let count = 0; count < 5; count++) {
      expect((await run()).error?.code).toBe("code_output_missing");
    }
    // Nothing of the five is left open in the worker: no file, and no job.
    const { t, run: again } = await ready({ script: SUM });
    expect((await again()).status).toBe("done");
    const jobs = await t.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: "workflow_run.run_code", statuses: ["running", "queued"] }
    });
    expect(jobs).toEqual([]);
  }, 120_000);
});

// How a step ends: by itself, at its time limit, or at a cancel. After each, nothing the
// script started is left running. The local sandbox ends the process group of the script: a
// process that left it, with a session of its own or a double fork, is out of its reach, and
// the step does not wait for it. Only a container ends that one too, as tested below with the
// runner image. The local sandbox is for development only.
describe("what a script starts in the local sandbox", () => {
  it("is ended with the script when the script ends", async () => {
    const mark = nextMark();
    const { run } = await ready({ script: startsWriter("a child", mark) });
    // The writer wrote more than a result may be.
    expect((await run()).error?.code).toBe("code_output_too_large");
    expect(await survivorsOf(mark)).toEqual([]);
  }, 30_000);

  it("is ended at the script's time limit", async () => {
    const mark = nextMark();
    const { t, run } = await ready({
      script: startsWriter("a child", mark, { seconds: 60 }),
      timeoutSeconds: 3
    });
    const ended = await run();
    expect(ended.error?.code).toBe("code_timeout");
    expect(await stderrOf(t, ended.id)).toContain("the writer writes");
    expect(await survivorsOf(mark)).toEqual([]);
  }, 30_000);

  it("is ended when the run is cancelled", async () => {
    const mark = nextMark();
    const prepared = await ready({
      script: startsWriter("a child", mark, { seconds: 60 }),
      timeoutSeconds: 120
    });
    expect(await cancelOnceWriting(prepared, mark)).not.toEqual([]);
    expect(await survivorsOf(mark)).toEqual([]);
  }, 60_000);

  it("does not hold the step where it left the script's process group and keeps its streams", async () => {
    const mark = nextMark();
    const { run } = await ready({
      script: startsWriter("a grandchild of a double fork", mark, { holdsStreams: true }),
      timeoutSeconds: 3
    });
    const before = Date.now();
    // The writer keeps the script's output open, so the script's command never ends by itself.
    expect((await run()).error?.code).toBe("code_timeout");
    expect(Date.now() - before).toBeLessThan(15_000);
  }, 30_000);
});

const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

// The same through the job, in a container of the runner image, with what only a container
// has: a working directory of a stated size, and the engine's own word on memory.
//   CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/workflow-code-step.test.ts
describe.skipIf(!runnerImage)("a code step in a container, through the job", () => {
  // The containers of this file have a name of their own, so that each test removes what it
  // left without touching another file's.
  const containerNamePrefix = `catalyst-test-${randomUUID().slice(0, 8)}`;
  const docker = () =>
    new DockerWorkspaceCommandProcessExecutor({ image: runnerImage ?? "", containerNamePrefix });
  afterEach(async () => {
    await docker().removeLeftovers({ idPrefix: "", olderThanMs: 0 });
  });

  it.each([
    ...LEFT_BEHIND,
    [
      "a device node, which the container cannot make",
      `import os, stat\ntry:\n    os.mknod("output.json", stat.S_IFCHR | 0o666, os.makedev(1, 3))\nexcept OSError as error:\n    print(type(error).__name__, flush=True)`,
      "code_output_not_json"
    ]
  ])(
    "ends the step for %s without the worker waiting on it",
    async (_, script, code) => {
      const { run } = await ready({ script, sandbox: docker(), timeoutSeconds: 20 });
      const before = Date.now();
      const ended = await run();
      expect(Date.now() - before).toBeLessThan(15_000);
      expect(ended.error?.code).toBe(code);
      expect(await survivorsOf(MARK, runnerImage)).toEqual([]);
    },
    60_000
  );

  // The script is the first process of its container. When it ends, or the worker removes
  // the container at its time limit or a cancel, the kernel ends every process of the
  // container's process namespace: one that left its session as well.
  it.each(WAYS)(
    "ends %s when the script ends",
    async (way) => {
      const mark = nextMark();
      const { run } = await ready({ sandbox: docker(), script: startsWriter(way, mark) });
      expect((await run()).error?.code).toBe("code_output_too_large");
      expect(await survivorsOf(mark, runnerImage)).toEqual([]);
    },
    60_000
  );

  it.each(WAYS)(
    "ends %s at the script's time limit",
    async (way) => {
      const mark = nextMark();
      const { t, run } = await ready({
        sandbox: docker(),
        script: startsWriter(way, mark, { seconds: 60 }),
        timeoutSeconds: 5
      });
      const ended = await run();
      expect(ended.error?.code).toBe("code_timeout");
      expect(await stderrOf(t, ended.id)).toContain("the writer writes");
      expect(await survivorsOf(mark, runnerImage)).toEqual([]);
    },
    60_000
  );

  it.each(WAYS)(
    "ends %s when the run is cancelled",
    async (way) => {
      const mark = nextMark();
      const prepared = await ready({
        sandbox: docker(),
        script: startsWriter(way, mark, { seconds: 60 }),
        timeoutSeconds: 120
      });
      expect(await cancelOnceWriting(prepared, mark, runnerImage)).not.toEqual([]);
      expect(await survivorsOf(mark, runnerImage)).toEqual([]);
    },
    60_000
  );

  it("gives a script that fills its directory no space left, and writes nothing to the host's disk", async () => {
    const { t, run, tempRoot } = await ready({
      sandbox: docker(),
      timeoutSeconds: 30,
      script: `
import os
written = 0
try:
    with open("big.bin", "wb") as out:
        while written < 10 * 1024 * 1024 * 1024:
            out.write(b"x" * (1024 * 1024))
            out.flush()
            written += 1024 * 1024
finally:
    print("written", written // (1024 * 1024), "MiB", flush=True)
`
    });
    const before = Date.now();
    const ended = await run();
    // Sixteen MiB are written in a moment: the step does not run to its time limit.
    expect(Date.now() - before).toBeLessThan(20_000);
    expect(ended.error).toMatchObject({
      code: "code_failed",
      message: "The script ended with the exit code 1"
    });
    const [log] = logsOf(
      await t.call(t.root.id, "workflows.list_step_runs", {
        params: { runId: ended.id },
        query: { status: "failed" }
      })
    );
    expect(log?.stderr).toContain("No space left on device");
    // The directory holds what its size says and no more.
    const written = Number(/written (\d+) MiB/u.exec(log?.stdout ?? "")?.[1]);
    expect(written).toBeGreaterThan(8);
    expect(written).toBeLessThanOrEqual(16);
    // Nothing of it is on the worker's disk: the directory of the step is gone, and it never
    // held more than the script and the input.
    expect(await readdir(tempRoot)).toEqual([]);
  }, 60_000);

  it("cannot write where the worker put the script, and sees its working directory as memory", async () => {
    const { run, step } = await ready({
      sandbox: docker(),
      script: `
import json, os
def writable(path):
    try:
        open(os.path.join(path, "probe"), "w").close()
        return True
    except OSError:
        return False
mounts = {}
for line in open("/proc/self/mountinfo"):
    fields = line.split()
    mounts[fields[4]] = [fields[fields.index("-") + 1], fields[5].split(",")[0]]
print(json.dumps({
    "code": [writable("/code"), sorted(os.listdir("/code")), mounts.get("/code")],
    "workspace": [writable("/workspace"), mounts.get("/workspace"), os.getcwd()],
}))
`
    });
    const ended = await run();
    expect(ended.status).toBe("done");
    const seen = z
      .object({ code: z.array(z.unknown()), workspace: z.array(z.unknown()) })
      .parse(JSON.parse((await step(ended.id))?.outputPreview?.text ?? "null"));
    // What the worker wrote is read-only for the script, whatever file system holds it.
    expect(seen.code).toEqual([false, ["input.json", "step.py"], [expect.any(String), "ro"]]);
    expect(seen.workspace).toEqual([true, ["tmpfs", "rw"], "/workspace"]);
  }, 60_000);

  it("reports a container the engine ended for its memory as code_out_of_memory, and nothing else as that", async () => {
    const greedy = await ready({
      sandbox: docker(),
      script: `data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`
    });
    expect((await greedy.run()).error?.code).toBe("code_out_of_memory");
    await greedy.t.instance.close();

    // A script may end with 137 itself, and may kill itself: neither is the engine's doing.
    const exits = await ready({ sandbox: docker(), script: `import sys\nsys.exit(137)` });
    expect((await exits.run()).error).toMatchObject({
      code: "code_failed",
      message: "The script ended with the exit code 137"
    });
    await exits.t.instance.close();
    const kills = await ready({
      sandbox: docker(),
      script: `import os, signal\nos.kill(os.getpid(), signal.SIGKILL)`
    });
    expect((await kills.run()).error?.code).toBe("code_failed");
  }, 120_000);
});

describe("what a killed command worker left of code steps", () => {
  it("is removed when a worker starts and on its timer, without another code step", async () => {
    const swept: { idPrefix: string; olderThanMs: number }[] = [];
    const sandbox: WorkspaceCommandProcessExecutor = {
      execute: () => Promise.reject(new Error("No script runs in this test")),
      removeLeftovers(input) {
        swept.push(input);
        return Promise.resolve(1);
      }
    };
    const { t, tempRoot } = await ready({ script: SUM });
    // The directory of a step whose worker was killed an hour ago, and one of a step that runs.
    const old = join(tempRoot, "catalyst-code-step-killed");
    const young = join(tempRoot, "catalyst-code-step-running");
    const other = join(tempRoot, "something-else");
    for (const directory of [old, young, other]) await mkdir(directory);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1_000);
    await utimes(old, hourAgo, hourAgo);
    await utimes(other, hourAgo, hourAgo);

    const jobs = createCodeStepJobs({
      clientInstanceId,
      stores: t.stores,
      sandbox,
      tempRoot,
      slots: 1,
      timeoutSeconds: 60,
      limits: LIMITS
    });
    // A script of 60 seconds: what is older than three minutes was left behind.
    const worker = t.worker(jobs.handlers, jobs.schedules);
    worker.start();
    for (let wait = 0; wait < 100 && swept.length === 0; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await worker.stop();
    expect(swept).toEqual([{ idPrefix: "code-step-", olderThanMs: 180_000 }]);
    expect((await readdir(tempRoot)).sort()).toEqual([
      "catalyst-code-step-running",
      "something-else"
    ]);
    // It is a schedule of the worker: the next sweep is queued, ten minutes on.
    const queued = await t.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: "workflow_run.sweep_code", statuses: ["queued"] }
    });
    expect(queued).toHaveLength(1);
  }, 60_000);
});

/** What the failed code step of a run printed to its error stream, as its log keeps it. */
async function stderrOf(t: Awaited<ReturnType<typeof ready>>["t"], runId: string) {
  const [log] = logsOf(
    await t.call(t.root.id, "workflows.list_step_runs", {
      params: { runId },
      query: { status: "failed" }
    })
  );
  return log?.stderr ?? "";
}

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
