import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowSourceCache,
  createCodeSandbox,
  WorkflowStepFailure,
  WORKFLOW_SOURCE_DEFAULTS,
  workflowSourceIssues,
  type WorkflowSourceTree
} from "@work-shape/catalyst-workflows";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  createDockerRunInvocation,
  type WorkspaceCommandProcessInput
} from "@work-shape/catalyst-tool-execution";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "wf-tree-"));
  directories.push(root);
  return root;
}
function tree(files: Record<string, string>, read = () => {}): WorkflowSourceTree {
  return {
    hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) })),
    async readFile(path) {
      read();
      return files[path] === undefined ? undefined : Buffer.from(files[path]);
    }
  };
}
const limits = {
  cpuCount: 1,
  memoryBytes: 128 * 1024 ** 2,
  pidsLimit: 64,
  scratchBytes: 16 * 1024 ** 2
};

describe("a Workflow revision's source tree (check 152)", () => {
  it.each(["lib/run.py", "lib/run.js", "lib/run.mjs"])(
    "runs %s from the tree root, importing lib and reading SQL with an unused file",
    async (entry) => {
      const root = await directory();
      const python = `from lib.db import value\nimport json\nprint(json.dumps({"value":value,"sql":open("sql/query.sql").read()}))`;
      const js = `const fs = require('node:fs'); const {value} = require('lib/db.cjs'); console.log(JSON.stringify({value,sql:fs.readFileSync('sql/query.sql','utf8')}));`;
      const mjs = `import {value} from 'lib/db.mjs'; import fs from 'node:fs'; console.log(JSON.stringify({value,sql:fs.readFileSync('sql/query.sql','utf8')}));`;
      const source = tree({
        [entry]: entry.endsWith(".py") ? python : entry.endsWith(".mjs") ? mjs : js,
        "lib/db.py": "value = 42",
        "lib/db.cjs": "exports.value = 42",
        "lib/db.mjs": "export const value = 42",
        "sql/query.sql": "select 42",
        "tests/unused.txt": "accepted"
      });
      let invocation: WorkspaceCommandProcessInput | undefined;
      const local = new LocalWorkspaceCommandProcessExecutor();
      const sandbox = createCodeSandbox({
        tempRoot: root,
        outputMaxBytes: 1024,
        limits,
        stepFiles: { readTree: async () => source },
        sandbox: {
          async execute(input) {
            invocation = input;
            return local.execute({
              ...input,
              env: {
                ...input.env,
                PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`
              }
            });
          }
        }
      });
      const result = await sandbox.run({
        id: "tree",
        staged: {
          language: "python",
          file: entry,
          tree: { workflow: "example", revisionId: "before-publish", hash: source.hash },
          input: {},
          timeoutSeconds: 10
        },
        signal: new AbortController().signal
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ended",
        outcome: { kind: "output", value: { value: 42, sql: "select 42" } }
      });
      if (!invocation) throw new Error("Sandbox was not started");
      const { args } = createDockerRunInvocation(invocation, {
        image: "runner:test",
        runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
      });
      expect(args.filter((arg) => arg.startsWith("type=bind"))).toEqual([
        `type=bind,source=${invocation.workspaceDirectory},target=/code,readonly`
      ]);
      expect(args).toContain("--read-only");
      expect(invocation.command.command).toContain('cd "$source_root/tree"');
      expect(invocation.env).toEqual({});
    }
  );

  it.skipIf(!process.env.CATALYST_RUNNER_IMAGE)(
    "mounts the exported tree read-only for a real unprivileged container",
    async () => {
      const root = await directory();
      const source = tree({
        "lib/run.py": `from lib.db import value
import json, os, errno
assert open("sql/query.sql").read() == "select 42"
try:
    open("lib/db.py", "w").write("changed")
    raise RuntimeError("source was writable")
except OSError as e:
    assert e.errno == errno.EROFS
json.dump({"value":value},open(os.environ["WORKFLOW_OUTPUT_FILE"],"w"))`,
        "lib/db.py": "value = 42",
        "sql/query.sql": "select 42",
        "tests/unused.txt": "accepted"
      });
      const sandbox = createCodeSandbox({
        tempRoot: root,
        outputMaxBytes: 1024,
        limits,
        sandbox: new DockerWorkspaceCommandProcessExecutor({
          image: process.env.CATALYST_RUNNER_IMAGE ?? "unused",
          runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
        }),
        stepFiles: { readTree: async () => source }
      });
      const result = await sandbox.run({
        id: "readonly-tree",
        staged: {
          language: "python",
          file: "lib/run.py",
          tree: { workflow: "example", revisionId: "pinned", hash: source.hash },
          input: {},
          timeoutSeconds: 15
        },
        signal: new AbortController().signal
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ended",
        outcome: { kind: "output", value: { value: 42 } }
      });
    }
  );

  it.each(["local", ...(process.env.CATALYST_RUNNER_IMAGE ? ["container"] : [])])(
    "keeps legacy file-alias scripts unchanged in %s while importing the revision tree",
    async (kind) => {
      const root = await directory();
      const script =
        'from lib.db import value\nimport json\ndata=json.load(open("input.json"))\njson.dump({"value":value+data["add"]},open("output.json","w"))';
      const source = tree({ "steps/run.py": script, "lib/db.py": "value = 40" });
      const sandbox = createCodeSandbox({
        tempRoot: root,
        outputMaxBytes: 1024,
        limits,
        sandbox:
          kind === "local"
            ? new LocalWorkspaceCommandProcessExecutor()
            : new DockerWorkspaceCommandProcessExecutor({
                image: process.env.CATALYST_RUNNER_IMAGE ?? "unused",
                runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
              }),
        stepFiles: { readTree: async () => source }
      });
      const result = await sandbox.run({
        id: "legacy-tree",
        staged: {
          language: "python",
          file: "steps/run.py",
          source: script,
          legacyIo: true,
          tree: { workflow: "example", revisionId: "pinned", hash: source.hash },
          input: { add: 2 },
          timeoutSeconds: 15
        },
        signal: new AbortController().signal
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ended",
        outcome: { kind: "output", value: { value: 42 } }
      });
    }
  );

  it("ends a missing source-store attempt as a step failure", async () => {
    const root = await directory();
    const sandbox = createCodeSandbox({
      tempRoot: root,
      outputMaxBytes: 1024,
      limits,
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      stepFiles: {
        readTree: async () => {
          throw new WorkflowStepFailure("code_file_missing", "store missing");
        }
      }
    });
    const result = await sandbox.run({
      id: "missing",
      staged: {
        language: "python",
        file: "lib/run.py",
        tree: { workflow: "example", revisionId: "pinned", hash: "tree" },
        input: {},
        timeoutSeconds: 10
      },
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({
      kind: "ended",
      outcome: { kind: "failed", error: { code: "code_file_missing" } }
    });
  });

  it("lets transient source failures retry instead of ending the step", async () => {
    const root = await directory();
    const source = tree({ "lib/run.py": 'print("{}")' });
    let attempts = 0;
    const sandbox = createCodeSandbox({
      tempRoot: root,
      outputMaxBytes: 1024,
      limits,
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      stepFiles: {
        readTree: async () => {
          if (attempts++ === 0) throw new Error("temporary source outage");
          return source;
        }
      }
    });
    const input = {
      id: "retry-source",
      staged: {
        language: "python",
        file: "lib/run.py",
        tree: { workflow: "example", revisionId: "pinned", hash: source.hash },
        input: {},
        timeoutSeconds: 10
      },
      signal: new AbortController().signal
    };
    await expect(sandbox.run(input)).rejects.toThrow("temporary source outage");
    expect(await sandbox.run(input)).toMatchObject({
      kind: "ended",
      outcome: { kind: "output", value: {} }
    });
  });

  it("copies on a cache miss, reuses a hit without reading objects, and evicts the least recently used tree", async () => {
    const root = await directory();
    const cacheRoot = join(root, "cache");
    let reads = 0;
    const cache = createWorkflowSourceCache({
      directory: cacheRoot,
      limits: { ...WORKFLOW_SOURCE_DEFAULTS, cacheBytes: 8 }
    });
    const first = tree({ "a.txt": "aaaa" }, () => reads++);
    const second = tree({ "b.txt": "bbbb" }, () => reads++);
    await cache.copy(first, join(root, "one"));
    await cache.copy(second, join(root, "two"));
    const key = (hash: string) => createHash("sha256").update(hash).digest("hex");
    await utimes(join(cacheRoot, key(second.hash)), new Date(0), new Date(0));
    await cache.copy(first, join(root, "hit"));
    expect(reads).toBe(2);
    expect(await readFile(join(root, "hit/a.txt"), "utf8")).toBe("aaaa");
    const third = tree({ "c.txt": "cccc" }, () => reads++);
    await cache.copy(third, join(root, "three"));
    expect((await readdir(cacheRoot)).sort()).toEqual([key(first.hash), key(third.hash)].sort());
  });

  it("keeps oversized exports outside the cache budget and preserves retained hits", async () => {
    const root = await directory();
    const cacheRoot = join(root, "cache");
    const cache = createWorkflowSourceCache({
      directory: cacheRoot,
      limits: { ...WORKFLOW_SOURCE_DEFAULTS, cacheBytes: 4 }
    });
    await cache.copy(tree({ "a.txt": "1234" }), join(root, "small"));
    const before = await readdir(cacheRoot);
    await cache.copy(tree({ "big.txt": "12345678" }), join(root, "big"));
    expect(await readdir(cacheRoot)).toEqual(before);
    expect(await readFile(join(root, "big/big.txt"), "utf8")).toBe("12345678");
  });

  it("rejects traversal, .git, duplicate and file/directory collisions before reading objects", async () => {
    for (const paths of [
      ["../outside.py"],
      ["/outside.py"],
      [".git/config"],
      ["lib/a.py", "LIB/a.py"],
      ["lib", "lib/a.py"]
    ]) {
      expect(workflowSourceIssues(paths.map((path) => ({ path, bytes: 1 })))[0]?.code).toBe(
        "code_file_invalid"
      );
    }
    const root = await directory();
    const cache = createWorkflowSourceCache({ directory: join(root, "cache") });
    let reads = 0;
    await expect(
      cache.copy(
        tree({ "../outside.py": "x" }, () => reads++),
        join(root, "run")
      )
    ).rejects.toThrow();
    expect(reads).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("never follows a symlink from a disk cache entry", async () => {
    const root = await directory();
    const cacheRoot = join(root, "cache");
    const source = tree({ "lib/a.txt": "safe" });
    const cache = createWorkflowSourceCache({ directory: cacheRoot });
    await cache.copy(source, join(root, "first"));
    const held = join(cacheRoot, createHash("sha256").update(source.hash).digest("hex"));
    await rm(join(held, "lib"), { recursive: true });
    await symlink(root, join(held, "lib"));
    await cache.copy(source, join(root, "second"));
    expect(await readFile(join(root, "second/lib/a.txt"), "utf8")).toBe("safe");
  });

  it.each([
    ["fileBytes", { fileBytes: 3 }],
    ["files", { files: 1 }],
    ["treeBytes", { treeBytes: 7 }]
  ] as const)("names workflows.source.%s when a tree exceeds that bound", (setting, overrides) => {
    expect(
      workflowSourceIssues(
        [
          { path: "lib/run.py", bytes: 4 },
          { path: "sql/a.sql", bytes: 4 }
        ],
        { ...WORKFLOW_SOURCE_DEFAULTS, ...overrides }
      )[0]?.message
    ).toContain(`workflows.source.${setting}`);
  });
});
