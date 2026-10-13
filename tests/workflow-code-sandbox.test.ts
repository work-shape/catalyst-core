import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject, WorkflowCodeOutcome } from "@vivd-catalyst/core";
import {
  DockerWorkspaceCommandProcessExecutor,
  createDockerRunInvocation,
  type WorkspaceCommandProcessInput
} from "@vivd-catalyst/tool-execution";
import { createCodeSandbox } from "@vivd-catalyst/workflows";

// What a container gives a code step: nothing but its script and its input. No network, no
// variable of the platform, no path of the host but its own directory, and limits of memory
// and processes that end a script without ending its neighbour.
//
// The first tests read the command the sandbox is started with. The rest run scripts in the
// runner image and need Docker and the image:
//   CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/workflow-code-sandbox.test.ts
// On a machine whose Docker engine runs in a VM, the temp directory must be one the VM mounts.

const LIMITS = { cpuCount: 0.5, memoryBytes: 96 * 1024 * 1024, pidsLimit: 32 };

describe("the command a code step's container is started with", () => {
  const input: WorkspaceCommandProcessInput = {
    command: {
      id: "code-step-wfs_1",
      command: "python3 step.py < input.json",
      limits: { timeoutSeconds: 60, maxStdoutBytes: 1024, maxStderrBytes: 1024 }
    },
    sandboxLimits: LIMITS,
    workspaceDirectory: "/tmp/code/run",
    workspaceCwd: ".",
    cwd: "/tmp/code/run",
    tempDirectory: "/tmp/code/tmp",
    env: { DATABASE_URL: "postgres://secret", HOME: "/root", AWS_SECRET_ACCESS_KEY: "secret" }
  };
  const { args } = createDockerRunInvocation(input, {
    image: "runner:test",
    cpuCount: 2,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pidsLimit: 128,
    runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
  });
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1];

  it("has the limits of a code step and not those of an agent's command, and no swap", () => {
    expect(valueOf("--memory")).toBe(String(LIMITS.memoryBytes));
    expect(valueOf("--memory-swap")).toBe(String(LIMITS.memoryBytes));
    expect(valueOf("--cpus")).toBe("0.5");
    expect(valueOf("--pids-limit")).toBe("32");
  });

  it("has no network, no capability, a read-only root and one mounted path", () => {
    expect(valueOf("--network")).toBe("none");
    expect(valueOf("--cap-drop")).toBe("ALL");
    expect(args).toContain("--read-only");
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(1);
    expect(valueOf("--mount")).toBe("type=bind,source=/tmp/code/run,target=/workspace");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
  });

  it("is handed no variable of the worker's environment", () => {
    const handed = args.flatMap((arg, at) => (arg === "--env" ? [args[at + 1] ?? ""] : []));
    expect(handed.map((pair) => pair.split("=")[0]).sort()).toEqual([
      "HOME",
      "PATH",
      "TMPDIR",
      "WORKSPACE_DIR"
    ]);
    expect(handed).toContain("HOME=/workspace");
    expect(args.join(" ")).not.toContain("secret");
  });

  it("keeps the sandbox's own limits for a command that names none", () => {
    const { sandboxLimits: _own, ...agent } = input;
    const plain = createDockerRunInvocation(agent, {
      image: "runner:test",
      memoryBytes: 4 * 1024 * 1024 * 1024,
      runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
    }).args;
    expect(plain[plain.indexOf("--memory") + 1]).toBe(String(4 * 1024 * 1024 * 1024));
    expect(plain).not.toContain("--memory-swap");
  });
});

const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a code step in a container of the runner image", () => {
  let tempRoot = "";
  let run: ReturnType<typeof createCodeSandbox>;
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "code-sandbox-test-"));
    // A variable the worker has and no container may see.
    process.env.CATALYST_TEST_PLATFORM_SECRET = "not-for-a-script";
    run = createCodeSandbox({
      sandbox: new DockerWorkspaceCommandProcessExecutor({ image: runnerImage ?? "" }),
      tempRoot,
      limits: LIMITS,
      outputMaxBytes: 256 * 1024
    });
  });
  afterAll(async () => {
    delete process.env.CATALYST_TEST_PLATFORM_SECRET;
    await rm(tempRoot, { recursive: true, force: true });
  });

  let count = 0;
  const script = (source: string, input: JsonObject = {}, timeoutSeconds = 30) => {
    count += 1;
    return run({
      id: `test-${String(process.pid)}-${String(count)}`,
      staged: { language: "python", file: "probe.py", source, input, timeoutSeconds },
      signal: new AbortController().signal
    });
  };
  const outcomeOf = (result: Awaited<ReturnType<typeof script>>): WorkflowCodeOutcome => {
    if (result.kind !== "ended") throw new Error(`The script did not run: ${result.kind}`);
    return result.outcome;
  };
  const valueOf = (outcome: WorkflowCodeOutcome) => {
    if (outcome.kind !== "output") throw new Error(`The script failed: ${outcome.error.code}`);
    return outcome.value;
  };

  it("runs a script in Python and one in JavaScript on its input", async () => {
    const python = await script(
      `import json, sys\nprint(json.dumps({"doubled": [n * 2 for n in json.load(sys.stdin)["numbers"]]}))`,
      { numbers: [1, 2] }
    );
    expect(valueOf(outcomeOf(python))).toEqual({ doubled: [2, 4] });
    count += 1;
    const javascript = await run({
      id: `test-${String(process.pid)}-${String(count)}`,
      staged: {
        language: "javascript",
        file: "probe.js",
        source: `const input = JSON.parse(require("fs").readFileSync("input.json", "utf8"));\nrequire("fs").writeFileSync("output.json", JSON.stringify({ count: input.numbers.length }));`,
        input: { numbers: [1, 2, 3] },
        timeoutSeconds: 30
      },
      signal: new AbortController().signal
    });
    expect(valueOf(outcomeOf(javascript))).toEqual({ count: 3 });
  }, 120_000);

  it("has no network: a name does not resolve and no address is reached", async () => {
    const result = await script(`
import json, socket
found = {}
try:
    socket.getaddrinfo("example.com", 443)
    found["dns"] = "resolved"
except Exception as error:
    found["dns"] = type(error).__name__
for address in ("1.1.1.1", "172.17.0.1", "host.docker.internal"):
    try:
        socket.create_connection((address, 443), timeout=3).close()
        found[address] = "connected"
    except Exception as error:
        found[address] = type(error).__name__
found["interfaces"] = sorted(name for _, name in socket.if_nameindex())
print(json.dumps(found))
`);
    const found = z.record(z.string(), z.unknown()).parse(valueOf(outcomeOf(result)));
    expect(found.dns).toBe("gaierror");
    expect(found["1.1.1.1"]).not.toBe("connected");
    expect(found["172.17.0.1"]).not.toBe("connected");
    expect(found["host.docker.internal"]).not.toBe("connected");
    // The loopback of the container and nothing else.
    expect(found.interfaces).toEqual(["lo"]);
  }, 120_000);

  it("sees no variable of the platform's environment", async () => {
    const result = await script(`import json, os\nprint(json.dumps(dict(os.environ)))`);
    const env = z.record(z.string(), z.string()).parse(valueOf(outcomeOf(result)));
    expect(Object.keys(env)).not.toContain("CATALYST_TEST_PLATFORM_SECRET");
    expect(JSON.stringify(env)).not.toContain("not-for-a-script");
    // Nothing the worker's own environment holds reaches the script, whatever it is named:
    // every value the two share is one the sandbox sets or the image brings.
    const shared = Object.entries(env).filter(
      ([name, value]) => process.env[name] === value && !["LANG", "LC_ALL"].includes(name)
    );
    expect(shared.map(([name]) => name)).toEqual([]);
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE|POSTGRES|AWS_|API_KEY/u);
    }
    expect(env.HOME).toBe("/workspace");
  }, 120_000);

  it("holds its script and its input and no other path of the host", async () => {
    const result = await script(
      `
import json, os
mounts = []
for line in open("/proc/self/mountinfo"):
    fields = line.split()
    separator = fields.index("-")
    mounts.append({"at": fields[4], "type": fields[separator + 1], "source": fields[separator + 2]})
def writable(path):
    try:
        open(os.path.join(path, "probe"), "w").close()
        os.remove(os.path.join(path, "probe"))
        return True
    except Exception:
        return False
print(json.dumps({
    "files": sorted(os.listdir("/workspace")),
    "input": json.load(open("/workspace/input.json")),
    "mounts": mounts,
    "writable": {path: writable(path) for path in ("/", "/etc", "/usr", "/home", "/workspace", "/tmp")},
    "uid": os.getuid(),
    "socket": os.path.exists("/var/run/docker.sock"),
}))
`,
      { only: "this" }
    );
    const seen = z
      .object({
        files: z.array(z.string()),
        input: z.unknown(),
        mounts: z.array(z.object({ at: z.string(), type: z.string(), source: z.string() })),
        writable: z.record(z.string(), z.boolean()),
        uid: z.number(),
        socket: z.boolean()
      })
      .parse(valueOf(outcomeOf(result)));
    expect(seen.files).toEqual(["input.json", "step.py"]);
    expect(seen.input).toEqual({ only: "this" });
    // What is mounted beside the image's own file system, the kernel's views and the two
    // temp file systems: the directory of this step, and the three files Docker writes for
    // every container.
    const kernel = /^\/(?:proc|sys|dev)(?:\/|$)/u;
    const own = seen.mounts
      .filter((mount) => !kernel.test(mount.at) && mount.at !== "/")
      .map((mount) => mount.at)
      .sort();
    expect(own).toEqual(
      ["/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/tmp", "/var/tmp", "/workspace"].sort()
    );
    expect(seen.mounts.filter((mount) => ["/tmp", "/var/tmp"].includes(mount.at))).toEqual([
      expect.objectContaining({ type: "tmpfs" }),
      expect.objectContaining({ type: "tmpfs" })
    ]);
    expect(seen.writable).toEqual({
      "/": false,
      "/etc": false,
      "/usr": false,
      "/home": false,
      "/workspace": true,
      "/tmp": true
    });
    expect(seen.uid).not.toBe(0);
    expect(seen.socket).toBe(false);
  }, 120_000);

  it("ends a script that allocates without end as code_out_of_memory, while another runs", async () => {
    const before = Date.now();
    const [greedy, neighbour] = await Promise.all([
      script(`data = []\nwhile True:\n    data.append(bytearray(8 * 1024 * 1024))`),
      script(`import json, time\ntime.sleep(2)\nprint(json.dumps({"fine": True}))`)
    ]);
    expect(outcomeOf(greedy)).toMatchObject({
      kind: "failed",
      error: { code: "code_out_of_memory" }
    });
    expect(valueOf(outcomeOf(neighbour))).toEqual({ fine: true });
    expect(Date.now() - before).toBeLessThan(60_000);
  }, 120_000);

  it("ends a script that forks without end within its limits, while another runs", async () => {
    const before = Date.now();
    const [bomb, neighbour] = await Promise.all([
      script(`import os\nwhile True:\n    os.fork()`, {}, 10),
      script(`import json, time\ntime.sleep(2)\nprint(json.dumps({"fine": True}))`)
    ]);
    // The process limit refuses the forks: the script fails, or is stopped at its time limit.
    const outcome = outcomeOf(bomb);
    expect(outcome.kind).toBe("failed");
    expect(["code_failed", "code_timeout", "code_out_of_memory"]).toContain(
      outcome.kind === "failed" ? outcome.error.code : ""
    );
    expect(valueOf(outcomeOf(neighbour))).toEqual({ fine: true });
    expect(Date.now() - before).toBeLessThan(60_000);
  }, 120_000);

  it("stops a script at its time limit and reports it as code_timeout, not as a failure of memory", async () => {
    const result = await script(`import time\ntime.sleep(60)`, {}, 2);
    expect(outcomeOf(result)).toMatchObject({ kind: "failed", error: { code: "code_timeout" } });
  }, 120_000);

  it("does not follow a link the script leaves in place of its result", async () => {
    const result = await script(`import os\nos.symlink("/etc/passwd", "output.json")`);
    expect(outcomeOf(result)).toMatchObject({
      kind: "failed",
      error: { code: "code_output_missing" }
    });
  }, 120_000);
});
