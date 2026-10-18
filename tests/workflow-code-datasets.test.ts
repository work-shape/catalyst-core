import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import type { JsonObject, JsonValue } from "@work-shape/catalyst-core";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import {
  checkDatasetContracts,
  createCodeSandbox,
  createCodeStepJobs,
  outputFileRows,
  openOutputFile,
  parseWorkflowManifest,
  storeOutputDatasets,
  type CodeStepDatasets,
  type WorkflowStepFiles
} from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// EW-14a: datasets in and out of a code step (spec, events-workflows-and-guardrails.md,
// "Dataset", the `code` paragraph, and check 35). The worker copies each dataset of the input
// as a file into a read-only directory, and after the script ended stores the files the result
// names from `/work/out`. That is the one place the worker opens what a script left, so each
// refusal is tried with a real file of its kind: a link, a pipe, a file over the bound, a file
// in a folder below and a name that leaves the directory.
//
// The container's half needs Docker and the runner image:
//   CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/workflow-code-datasets.test.ts

const runnerImage = process.env.CATALYST_RUNNER_IMAGE;
const run = promisify(execFile);
const SEEN = "/work/out";
const findingsSchema = {
  type: "object",
  properties: { findings: { type: "dataset", row: { type: "object" } } }
};

const errorOf = async (action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && "code" in error)
      return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("Not refused");
};

describe("the files a result names in the output directory", () => {
  let root = "";
  let directory = "";
  let stored: unknown[][] = [];
  const datasets: CodeStepDatasets = {
    rowBytes: 256,
    rows: () => Promise.reject(new Error("No input here")),
    async store({ rows }) {
      const all: unknown[] = [];
      for await (const row of rows) all.push(row);
      stored.push(all);
      return { $dataset: "wfd_test", rowCount: all.length, bytes: 1 };
    }
  };
  const collect = (path: JsonValue, bound = 64 * 1024) =>
    storeOutputDatasets({
      value: { findings: { path } },
      schema: findingsSchema,
      directory,
      seenAs: SEEN,
      bound,
      datasets,
      signal: new AbortController().signal
    });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "code-datasets-"));
    directory = join(root, "out");
    await mkdir(directory);
    await mkdir(join(root, "in"));
    // What a script must never reach: a file of the worker beside the output directory.
    await writeFile(join(root, "secret.jsonl"), `{"secret":"WORKER-SECRET"}\n`);
    await writeFile(join(root, "in", "postings.jsonl"), `{"secret":"INPUT-SECRET"}\n`);
    stored = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores the rows of a regular file directly in the directory", async () => {
    await writeFile(join(directory, "findings.jsonl"), `{"a":1}\n{"a":2}\r\n{"a":3}`);
    const value = await collect(`${SEEN}/findings.jsonl`);
    expect(value).toEqual({ findings: { $dataset: "wfd_test", rowCount: 3, bytes: 1 } });
    expect(stored).toEqual([[{ a: 1 }, { a: 2 }, { a: 3 }]]);
  });

  it("refuses a link, to a file outside or inside the directory, and reads nothing", async () => {
    await symlink(join(root, "secret.jsonl"), join(directory, "findings.jsonl"));
    const outside = await errorOf(() => collect(`${SEEN}/findings.jsonl`));
    expect(outside.code).toBe("code_dataset_file_invalid");
    expect(outside.message).not.toContain("WORKER-SECRET");
    await writeFile(join(directory, "real.jsonl"), `{"a":1}\n`);
    await symlink("real.jsonl", join(directory, "inside.jsonl"));
    expect((await errorOf(() => collect(`${SEEN}/inside.jsonl`))).code).toBe(
      "code_dataset_file_invalid"
    );
    expect(stored).toEqual([]);
  });

  it("refuses a pipe without waiting for a writer", async () => {
    await run("mkfifo", [join(directory, "findings.jsonl")]);
    const started = Date.now();
    expect((await errorOf(() => collect(`${SEEN}/findings.jsonl`))).code).toBe(
      "code_dataset_file_invalid"
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stored).toEqual([]);
  });

  it("refuses a folder, a missing file and a file with a second name", async () => {
    await mkdir(join(directory, "folder"));
    await writeFile(join(directory, "first.jsonl"), `{"a":1}\n`);
    await link(join(directory, "first.jsonl"), join(directory, "second.jsonl"));
    for (const name of ["folder", "missing.jsonl", "first.jsonl", "second.jsonl"]) {
      expect((await errorOf(() => collect(`${SEEN}/${name}`))).code, name).toBe(
        "code_dataset_file_invalid"
      );
    }
    expect(stored).toEqual([]);
  });

  it("refuses a file over the bound before it reads, and stops at the bound while it reads", async () => {
    await writeFile(join(directory, "findings.jsonl"), `{"a":1}\n`.repeat(256));
    const over = await errorOf(() => collect(`${SEEN}/findings.jsonl`, 1_024));
    expect(over.code).toBe("code_disk_limit");
    expect(stored).toEqual([]);
    // A file that grows after it was opened is read no further than the bound.
    const handle = await openOutputFile({
      path: `${SEEN}/findings.jsonl`,
      directory,
      seenAs: SEEN,
      field: "findings",
      bound: 64 * 1024
    });
    try {
      let rows = 0;
      const reading = await errorOf(async () => {
        for await (const _ of outputFileRows({ handle, bound: 100, rowBytes: 256 })) rows += 1;
      });
      expect(reading.code).toBe("code_disk_limit");
      expect(rows).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("refuses a file in a folder below and a name that leaves the directory", async () => {
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, "sub", "findings.jsonl"), `{"a":1}\n`);
    for (const path of [
      `${SEEN}/sub/findings.jsonl`,
      `${SEEN}/../in/postings.jsonl`,
      `${SEEN}/../secret.jsonl`,
      "/work/in/postings.jsonl",
      `${SEEN}/..`,
      `${SEEN}/.`,
      `${SEEN}/`,
      `${SEEN}/.hidden`,
      "findings.jsonl",
      `${SEEN}/a\u0000b`
    ]) {
      const refused = await errorOf(() => collect(path));
      expect(refused.code, path).toBe("code_dataset_path_invalid");
      expect(refused.message).not.toContain("SECRET");
    }
    expect((await errorOf(() => collect(42))).code).toBe("code_dataset_path_invalid");
    expect(stored).toEqual([]);
  });

  it("refuses a result that names a dataset by an id instead of a file", async () => {
    const refused = await errorOf(() =>
      storeOutputDatasets({
        value: { note: { $dataset: "wfd_other", rowCount: 1, bytes: 1 } },
        schema: findingsSchema,
        directory,
        seenAs: SEEN,
        bound: 1_024,
        datasets,
        signal: new AbortController().signal
      })
    );
    expect(refused.code).toBe("code_output_invalid");
  });

  it("names the line that is no JSON, or too long, and never its content", async () => {
    await writeFile(
      join(directory, "findings.jsonl"),
      `{"a":1}\n{"a":2}\n{"secret":"ROW-SECRET"\n{"a":4}\n`
    );
    const broken = await errorOf(() => collect(`${SEEN}/findings.jsonl`));
    expect(broken).toEqual({
      code: "dataset_row_invalid",
      message: "Dataset line 3 is no JSON in UTF-8"
    });
    await writeFile(join(directory, "long.jsonl"), `{"a":1}\n{"b":"${"x".repeat(400)}"}\n`);
    const long = await errorOf(() => collect(`${SEEN}/long.jsonl`));
    expect(long).toEqual({
      code: "dataset_limit",
      message: "The dataset reached 'rowBytes' at line 2"
    });
  });
});

/** A script in Python that names one file in its output directory as `findings`. */
const leaving = (make: string, name = "findings.jsonl") => `
import json, os
OUT = "/work/out" if os.path.isdir("/work/out") else os.path.abspath("../out")
${make}
json.dump({"findings": {"path": OUT + "/${name}"}}, open("output.json", "w"))
`;

const SCRIPTS_LEAVING: [string, string, string][] = [
  [
    "a link to a file of the worker",
    leaving(
      `os.symlink("/etc/passwd" if OUT == "/work/out" else os.path.abspath("../run/input.json"), OUT + "/findings.jsonl")`
    ),
    "code_dataset_file_invalid"
  ],
  ["a pipe", leaving(`os.mkfifo(OUT + "/findings.jsonl")`), "code_dataset_file_invalid"],
  [
    "a file over the bound",
    leaving(`open(OUT + "/findings.jsonl", "w").write('{"a":1}\\n' * 20000)`),
    "code_disk_limit"
  ],
  [
    "a file in a folder below",
    leaving(
      `os.makedirs(OUT + "/sub")\nopen(OUT + "/sub/findings.jsonl", "w").write('{"a":1}\\n')`,
      "sub/findings.jsonl"
    ),
    "code_dataset_path_invalid"
  ],
  [
    "a name that leaves the directory",
    leaving(`open(OUT + "/findings.jsonl", "w").write('{"a":1}\\n')`, "../run/input.json"),
    "code_dataset_path_invalid"
  ],
  [
    "files past the bound that it does not name",
    leaving(
      `for n in range(8):\n    open(OUT + "/part%d" % n, "w").write("x" * 30000)\nopen(OUT + "/findings.jsonl", "w").write('{"a":1}\\n')`
    ),
    "code_disk_limit"
  ]
];

const sandboxes: [string, () => WorkspaceCommandProcessExecutor][] = [
  ["as a process of the worker", () => new LocalWorkspaceCommandProcessExecutor()]
];
if (runnerImage) {
  sandboxes.push([
    "in a container of the runner image",
    () => new DockerWorkspaceCommandProcessExecutor({ image: runnerImage })
  ]);
}

describe.each(sandboxes)("a script that leaves a file %s", (_, sandbox) => {
  let tempRoot = "";
  let count = 0;
  const stored: unknown[] = [];
  const datasets: CodeStepDatasets = {
    rowBytes: 1024,
    rows: () => Promise.reject(new Error("No input here")),
    async store({ rows }) {
      for await (const row of rows) stored.push(row);
      return { $dataset: "wfd_test", rowCount: stored.length, bytes: 1 };
    }
  };
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "code-datasets-sandbox-"));
    stored.length = 0;
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const leave = (source: string, timeoutSeconds = 30) => {
    count += 1;
    return createCodeSandbox({
      sandbox: sandbox(),
      tempRoot,
      limits: {
        cpuCount: 1,
        memoryBytes: 128 * 1024 * 1024,
        pidsLimit: 64,
        scratchBytes: 16 * 1024 * 1024
      },
      outputMaxBytes: 256 * 1024,
      diskBytes: 64 * 1024
    }).run({
      id: `ew14a-${String(process.pid)}-${String(count)}`,
      staged: {
        language: "python",
        file: "leave.py",
        source,
        input: {},
        timeoutSeconds,
        datasets: { outputSchema: findingsSchema }
      },
      signal: new AbortController().signal,
      datasets
    });
  };

  it.each(SCRIPTS_LEAVING)(
    "fails the step for %s and reads nothing of it",
    async (_what, source, code) => {
      const result = await leave(source);
      if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
      expect(result.outcome).toMatchObject({ kind: "failed", error: { code } });
      expect(stored).toEqual([]);
      // Nothing of the step is left on the worker's disk.
      expect(await readdir(tempRoot)).toEqual([]);
    },
    120_000
  );

  it("stops a script that goes on writing past the bound, long before its time limit", async () => {
    const started = Date.now();
    const result = await leave(
      leaving(
        `import time\nfor n in range(1000):\n    open(OUT + "/part%d" % n, "w").write("x" * 4096)\n    time.sleep(0.01)\ntime.sleep(60)`
      ),
      90
    );
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    expect(result.outcome).toMatchObject({ kind: "failed", error: { code: "code_disk_limit" } });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The disk bound covers the whole step: the input files the worker writes and what the script
// writes, together. The sandbox above runs with a bound of 64 KiB; each input row is ~1 KiB.

describe.each(sandboxes)("the disk of a step's input and output together %s", (_, sandbox) => {
  let tempRoot = "";
  let count = 0;
  const inputs = new Map<string, number>();
  const taken = new Map<string, number>();
  const stored: unknown[] = [];
  const datasets: CodeStepDatasets = {
    rowBytes: 4096,
    rows: (id) => {
      const rows = inputs.get(id) ?? 0;
      return Promise.resolve(
        (async function* () {
          for (let row = 0; row < rows; row += 1) {
            taken.set(id, (taken.get(id) ?? 0) + 1);
            yield { row, text: "x".repeat(1000) };
          }
        })()
      );
    },
    async store({ rows }) {
      for await (const row of rows) stored.push(row);
      return { $dataset: "wfd_test", rowCount: stored.length, bytes: 1 };
    }
  };
  const reference = (id: string) => ({ $dataset: id, rowCount: inputs.get(id) ?? 0, bytes: 1 });
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "code-datasets-disk-"));
    inputs.clear();
    taken.clear();
    stored.length = 0;
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  const step = (source: string, input: JsonObject) => {
    count += 1;
    return createCodeSandbox({
      sandbox: sandbox(),
      tempRoot,
      limits: {
        cpuCount: 1,
        memoryBytes: 128 * 1024 * 1024,
        pidsLimit: 64,
        scratchBytes: 16 * 1024 * 1024
      },
      outputMaxBytes: 256 * 1024,
      diskBytes: 64 * 1024
    }).run({
      id: `ew14a-disk-${String(process.pid)}-${String(count)}`,
      staged: {
        language: "python",
        file: "disk.py",
        source,
        input,
        timeoutSeconds: 60,
        datasets: { outputSchema: findingsSchema }
      },
      signal: new AbortController().signal,
      datasets
    });
  };
  const reads = `
import json, os
OUT = "/work/out" if os.path.isdir("/work/out") else os.path.abspath("../out")
IN = os.path.dirname(OUT) + "/in"
inp = json.load(open("input.json"))
`;

  it("writes a dataset the input names ten times as one file", async () => {
    // Ten times 20 KiB would be past the bound; once is well within it.
    inputs.set("wfd_shared", 20);
    const result = await step(
      `${reads}
paths = sorted({item["path"] for item in inp["aliases"]})
open(OUT + "/findings.jsonl", "w").write(json.dumps({"files": len(os.listdir(IN)), "paths": len(paths), "rows": sum(1 for _ in open(paths[0]))}) + "\\n")
json.dump({"findings": {"path": OUT + "/findings.jsonl"}}, open("output.json", "w"))`,
      { aliases: Array.from({ length: 10 }, () => reference("wfd_shared")) }
    );
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    expect(result.outcome).toMatchObject({ kind: "output" });
    expect(stored).toEqual([{ files: 1, paths: 1, rows: 20 }]);
    expect(taken.get("wfd_shared")).toBe(20);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);

  it("refuses input past the bound before it is written, and never runs the script", async () => {
    inputs.set("wfd_large", 50);
    inputs.set("wfd_more", 50);
    const result = await step(
      `${reads}
open(OUT + "/findings.jsonl", "w").write('{"ran":true}\\n')
json.dump({"findings": {"path": OUT + "/findings.jsonl"}}, open("output.json", "w"))`,
      { first: reference("wfd_large"), second: reference("wfd_more") }
    );
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    expect(result.outcome).toMatchObject({ kind: "failed", error: { code: "code_disk_limit" } });
    // The worker stopped at the row that would have passed 64 KiB: never 100 rows of 1 KiB.
    const rows = (taken.get("wfd_large") ?? 0) + (taken.get("wfd_more") ?? 0);
    expect(rows).toBeGreaterThan(50);
    expect(rows).toBeLessThan(66);
    expect(stored).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);

  it("counts the input files against many small files the script writes", async () => {
    // 40 KiB in, then ten files of 3 KiB that the result does not name: each is within the
    // shell's file limit, and together with the input they are past 64 KiB.
    inputs.set("wfd_postings", 40);
    const result = await step(
      `${reads}
for n in range(10):
    open(OUT + "/part%d" % n, "w").write("x" * 3072)
open(OUT + "/findings.jsonl", "w").write('{"a":1}\\n')
json.dump({"findings": {"path": OUT + "/findings.jsonl"}}, open("output.json", "w"))`,
      { postings: reference("wfd_postings") }
    );
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    expect(result.outcome).toMatchObject({ kind: "failed", error: { code: "code_disk_limit" } });
    expect(stored).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);

  it("counts the input files against what the script may write", async () => {
    // 40 KiB in, then 30 KiB out: either alone fits 64 KiB, together they do not.
    inputs.set("wfd_postings", 40);
    const result = await step(
      `${reads}
import signal, sys
# The file limit of the shell is what is left of the bound after the input: the write is cut.
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
try:
    with open(OUT + "/findings.jsonl", "w") as out:
        out.write('{"a":1}\\n' * 3800)
    print("whole", file=sys.stderr)
except OSError:
    print("cut", file=sys.stderr)
json.dump({"findings": {"path": OUT + "/findings.jsonl"}}, open("output.json", "w"))`,
      { postings: reference("wfd_postings") }
    );
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    expect(result.outcome).toMatchObject({ kind: "failed", error: { code: "code_disk_limit" } });
    expect(result.log.stderr.trim()).toBe("cut");
    expect(stored).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Check 35 through the engine and the command worker, with the files object store.

const posting = {
  type: "object",
  properties: {
    client_id: { type: "integer" },
    amount: { type: "number" },
    text: { type: "string" },
    extra: { type: "object", additionalProperties: { type: "number" } }
  },
  required: ["client_id", "amount"]
};
const finding = {
  type: "object",
  properties: { line: { type: "integer" }, rule: { type: "string" } },
  required: ["line", "rule"]
};
const postingsOf = (row: JsonObject = { $ref: "#/types/posting" }) => ({
  type: "dataset",
  row
});
const ref = (step: string, path: string) => ({ ref: { step, path } });

const GENERATE = `
import json, os
OUT = "/work/out" if os.path.isdir("/work/out") else os.path.abspath("../out")
data = json.load(open("input.json"))
bad = data.get("bad") or 0
with open(OUT + "/postings.jsonl", "w") as out:
    for i in range(data["count"]):
        if i + 1 == bad:
            out.write(json.dumps({"client_id": "CLIENT-SECRET", "amount": 1}) + "\\n")
        elif i + 1 == -bad:
            out.write(json.dumps({"client_id": 1, "amount": 1, "extra": {"EW14A_PRIVATE_KEY_47f9c": "CLIENT-SECRET"}}) + "\\n")
        else:
            out.write(json.dumps({"client_id": 1400 + i % 600, "amount": (i % 997) - 3, "text": "Buchung %d" % i}) + "\\n")
json.dump({"postings": {"path": OUT + "/postings.jsonl"}}, open("output.json", "w"))
`;

const CHECK = `
import json, os, socket
OUT = "/work/out" if os.path.isdir("/work/out") else os.path.abspath("../out")
data = json.load(open("input.json"))
source = data["postings"]
try:
    open(source["path"], "a").close()
    writable = True
except OSError:
    writable = False
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3).close()
    network = True
except OSError:
    network = False
checked = 0
with open(source["path"]) as rows, open(OUT + "/findings.jsonl", "w") as out:
    for number, line in enumerate(rows, 1):
        posting = json.loads(line)
        checked += 1
        if posting["amount"] < 0:
            out.write(json.dumps({"line": number, "rule": "negative_amount"}) + "\\n")
json.dump({
    "findings": {"path": OUT + "/findings.jsonl"},
    "checked": checked,
    "rowCount": source["rowCount"],
    "inputPath": source["path"],
    "inputWritable": writable,
    "network": network
}, open("output.json", "w"))
`;

function monthlyCheck(checkRow: JsonObject = { $ref: "#/types/posting" }) {
  return {
    id: "monthly-check",
    name: "Monthly check",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    types: { posting, finding },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "postings",
        name: "Postings",
        type: "code",
        file: "generate.py",
        input: { count: ref("start", "input.count"), bad: ref("start", "input.bad") },
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { postings: postingsOf() },
          required: ["postings"]
        }
      },
      {
        id: "check",
        name: "Check",
        type: "code",
        file: "check.py",
        input: { postings: ref("postings", "postings") },
        inputSchema: {
          type: "object",
          properties: { postings: postingsOf(checkRow) },
          required: ["postings"]
        },
        outputSchema: {
          type: "object",
          properties: {
            findings: { type: "dataset", row: { $ref: "#/types/finding" } },
            checked: { type: "integer" }
          },
          required: ["findings", "checked"]
        }
      },
      { id: "result", name: "Result", type: "output", input: { check: ref("check", "") } }
    ]
  };
}

let open: WorkflowFixture | undefined;
const directories: string[] = [];
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function ready(
  sandbox: WorkspaceCommandProcessExecutor,
  extra: Record<string, unknown>[] = []
) {
  const definitions = publishedDefinitions();
  definitions.publish(monthlyCheck());
  for (const manifest of extra) definitions.publish(manifest);
  const scripts: Record<string, string> = {
    "steps/generate.py": GENERATE,
    "steps/check.py": CHECK
  };
  const stepFiles: WorkflowStepFiles = {
    readStepFile: ({ path }) =>
      Promise.resolve(
        scripts[path] === undefined ? undefined : new TextEncoder().encode(scripts[path])
      )
  };
  const objects = new MemoryObjectStorage();
  const limits = workflowsConfigSchema.parse({}).datasets;
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: definitions.source,
      stepFiles,
      datasetObjects: objects,
      codeRunner: { timeoutSeconds: 60 }
    }
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "code-datasets-step-"));
  directories.push(tempRoot);
  const worker = t.worker([
    ...t.workflows.jobHandlers,
    ...createCodeStepJobs({
      clientInstanceId,
      stores: t.stores,
      sandbox,
      tempRoot,
      slots: 2,
      timeoutSeconds: 60,
      limits: {
        cpuCount: 1,
        memoryBytes: 256 * 1024 * 1024,
        pidsLimit: 64,
        scratchBytes: 32 * 1024 * 1024
      },
      datasets: { objects, limits },
      cancelCheckMs: 50
    }).handlers
  ]);
  const begin = async (workflow: string, input: JsonValue) =>
    z.object({ id: z.string() }).parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow },
          payload: { input }
        })
      ).json()
    );
  const finish = async (workflow: string, input: JsonValue) =>
    t.finish((await begin(workflow, input)).id, worker);
  return { t, finish, tempRoot, objects };
}

async function runOf(t: WorkflowFixture, id: string) {
  const found = await t.stores.workflowRuns.readRun({ clientInstanceId, id });
  if (!found) throw new Error(`No run ${id}`);
  return found;
}

const expectedFindings = (count: number) =>
  Array.from({ length: count }, (_, i) => (i % 997) - 3).filter((amount) => amount < 0).length;

describe.each(sandboxes)("check 35: a code step on datasets %s", (where, sandbox) => {
  it("reads 100,000 rows from a file its input names and writes its findings as a file", async () => {
    const { t, finish, tempRoot } = await ready(sandbox());
    const ended = await finish("monthly-check", { count: 100_000, bad: 0 });
    expect(ended.status, JSON.stringify(ended.error)).toBe("done");
    const steps = await stepRunsOf(t, ended.id);
    const generated = JSON.parse(
      steps.find((step) => step.stepId === "postings")?.outputPreview?.text ?? "null"
    );
    expect(generated).toEqual({
      postings: { $dataset: expect.any(String), rowCount: 100_000, bytes: expect.any(Number) }
    });
    const checked = z
      .object({
        findings: z.object({ $dataset: z.string(), rowCount: z.number() }),
        checked: z.number(),
        rowCount: z.number(),
        inputPath: z.string(),
        inputWritable: z.boolean(),
        network: z.boolean()
      })
      .parse(
        JSON.parse(steps.find((step) => step.stepId === "check")?.outputPreview?.text ?? "null")
      );
    expect(checked.checked).toBe(100_000);
    expect(checked.rowCount).toBe(100_000);
    expect(checked.findings.rowCount).toBe(expectedFindings(100_000));
    // No row reaches a step record: references and counts only.
    expect(JSON.stringify(steps)).not.toContain("Buchung");
    const records = await t.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: (await runOf(t, ended.id)).id,
      limit: 10
    });
    expect(records.map((record) => [record.field, record.rowCount]).sort()).toEqual(
      [
        ["findings", expectedFindings(100_000)],
        ["postings", 100_000]
      ].sort()
    );
    if (where.startsWith("in a container")) {
      expect(checked.inputPath).toBe("/work/in/postings.jsonl");
      // The input file is read-only, and the container has no network.
      expect(checked.inputWritable).toBe(false);
      expect(checked.network).toBe(false);
    }
    // The worker leaves nothing of the steps on its disk.
    expect(await readdir(tempRoot)).toEqual([]);
  }, 180_000);

  it("fails the step on a line that does not fit the row schema, with its number and no content", async () => {
    const { t, finish } = await ready(sandbox());
    const ended = await finish("monthly-check", { count: 1_000, bad: 777 });
    expect(ended.status).toBe("failed");
    expect(ended.error?.code).toBe("dataset_row_invalid");
    expect(ended.error?.message).toContain("line 777");
    const steps = await stepRunsOf(t, ended.id);
    expect(steps.find((step) => step.stepId === "postings")).toMatchObject({
      status: "failed",
      error: { code: "dataset_row_invalid" }
    });
    expect(steps.find((step) => step.stepId === "check")).toBeUndefined();
    const everything = JSON.stringify([
      ended,
      steps,
      await t.stores.audit.listAuditEvents({ clientInstanceId, page: { limit: 200 } })
    ]);
    expect(everything).not.toContain("CLIENT-SECRET");
  }, 120_000);

  it("names a field by its place, never by a key of the row", async () => {
    const { t, finish } = await ready(sandbox());
    const ended = await finish("monthly-check", { count: 1_000, bad: -777 });
    expect(ended.error).toMatchObject({
      code: "dataset_row_invalid",
      message: "Dataset line 777 does not fit its row schema at field 3, field 1"
    });
    const steps = await stepRunsOf(t, ended.id);
    const everything = JSON.stringify([
      ended,
      await runOf(t, ended.id),
      steps,
      await t.stores.audit.listAuditEvents({ clientInstanceId, page: { limit: 200 } })
    ]);
    expect(everything).not.toMatch(/EW14A_PRIVATE_KEY|CLIENT-SECRET/u);
  }, 120_000);
});

describe("a dataset a code step's run may not read", () => {
  it("never reaches the script, however its reference arrives", async () => {
    const leak = {
      id: "leak",
      name: "Leak",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      types: { posting },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "foreign",
          name: "Foreign",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: "forge" } }
        },
        {
          id: "check",
          name: "Check",
          type: "code",
          file: "check.py",
          input: { postings: ref("foreign", "clients") },
          inputSchema: {
            type: "object",
            properties: { postings: postingsOf() },
            required: ["postings"]
          },
          outputSchema: { type: "object" }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    const { t, finish, tempRoot } = await ready(new LocalWorkspaceCommandProcessExecutor(), [leak]);
    // The victim: a run whose result keeps its dataset of findings for days.
    const victim = await finish("monthly-check", { count: 50, bad: 0 });
    expect(victim.status).toBe("done");
    const [record] = (
      await t.stores.workflowRunDatasets.listForRun({
        clientInstanceId,
        runId: (await runOf(t, victim.id)).id,
        limit: 10
      })
    ).filter((row) => row.field === "findings");
    if (!record) throw new Error("Missing the victim's dataset");
    // Another Workflow's step answers its id as if it were its own.
    t.setBehaviour(() =>
      Promise.resolve<JsonValue>({
        clients: { $dataset: record.id, rowCount: record.rowCount, bytes: record.bytes }
      })
    );
    const ended = await finish("leak", {});
    expect(ended.status).toBe("failed");
    expect(ended.error?.code).toBe("FORBIDDEN");
    const check = (await stepRunsOf(t, ended.id)).find((step) => step.stepId === "check");
    expect(check).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
    // The script never ran: no step directory was made for it.
    expect(await readdir(tempRoot)).toEqual([]);
  }, 120_000);
});

describe("the row schemas of a dataset into a code step, at save", () => {
  const definitions = { read: () => Promise.resolve(undefined) };
  const withCheckRow = (row: JsonObject) => {
    const parsed = parseWorkflowManifest(monthlyCheck(row));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.manifest;
  };

  it("refuses a dataset whose rows lack a field the step requires", async () => {
    const refused = await errorOf(() =>
      checkDatasetContracts(
        withCheckRow({
          type: "object",
          properties: { client_id: { type: "integer" }, booking_date: { type: "string" } },
          required: ["client_id", "booking_date"]
        }),
        definitions
      )
    );
    expect(refused.code).toBe("VALIDATION_FAILED");
  });

  it("accepts a dataset whose rows have more fields than the step requires", async () => {
    await expect(
      checkDatasetContracts(
        withCheckRow({
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"]
        }),
        definitions
      )
    ).resolves.toBeUndefined();
  });
});
