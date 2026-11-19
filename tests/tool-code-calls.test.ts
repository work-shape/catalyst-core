import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createActorAccess,
  createPlatformId,
  isToolOperationAnswer,
  NoopAuditRecorder,
  toolCallOperationName,
  type AuthenticatedUser,
  type ConversationId,
  type JobWorker,
  type JsonObject,
  type Logger,
  type OperationExecutionContext,
  type OperationOrigin,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import { createOutsideSchemaChecker } from "@work-shape/catalyst-connections";
import {
  createJobWorker,
  createToolAssetKind,
  createToolCodeCallClient,
  createToolCodeCallJobs,
  createToolOperationSource
} from "@work-shape/catalyst-client-assembly";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessExecutor,
  createDockerRunInvocation,
  type WorkspaceCommandProcessInput
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";

// A code tool's call (TOOL-2b, check 80): the operation writes the call and its job, the
// command worker runs the handler in the sandbox of code steps and the operation answers with
// what the handler answered. Here the sandbox is the local one, which runs the handler as a
// process, so the whole path runs on any machine; the container's isolation is read from the
// command it would be started with, as `workflow-code-sandbox.test.ts` tests it for real.

const checker = createOutsideSchemaChecker();
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const LIMITS = {
  cpuCount: 1,
  memoryBytes: 128 * 1024 ** 2,
  pidsLimit: 64,
  scratchBytes: 16 * 1024 ** 2
};

const PYTHON = `
import json, os, sys
data = json.load(sys.stdin)
with open(os.environ["WORKFLOW_INPUT_FILE"]) as handed:
    assert json.load(handed) == data
print("checked", file=sys.stderr)
mode = data.get("mode")
if mode == "data":
    answer = {"output": {"total": sum(data["numbers"])}, "display": {"type": "data", "kind": "figures.total", "title": "Total", "data": {"total": sum(data["numbers"])}}}
elif mode == "html":
    answer = {"output": "shown", "display": {"type": "html", "title": "Total", "html": "<p>%d</p>" % sum(data["numbers"])}}
elif mode == "env":
    answer = {"output": sorted(os.environ.keys())}
elif mode == "socket":
    import socket
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=3).close()
        answer = {"output": "connected"}
    except OSError as error:
        answer = {"output": "refused: " + type(error).__name__}
elif mode == "sleep":
    import time
    time.sleep(30)
    answer = {"output": "late"}
elif mode == "not_json":
    print("this is no JSON")
    sys.exit(0)
elif mode == "no_output":
    answer = {"result": 1}
elif mode == "fail":
    print("the ledger is closed", file=sys.stderr)
    sys.exit(3)
else:
    answer = {"output": {"total": sum(data["numbers"])}}
print(json.dumps(answer))
`;

const NODE = `
import { readFileSync, writeFileSync } from "node:fs";
import { total } from "lib/sum.mjs";
const data = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT_FILE, "utf8"));
const answer = data.mode === "html"
  ? { output: "shown", display: { type: "html", html: "<b>" + total(data.numbers) + "</b>" } }
  : { output: { total: total(data.numbers) }, display: { type: "data", kind: "figures.total", title: "Total", data: { total: total(data.numbers) } } };
writeFileSync(process.env.WORKFLOW_OUTPUT_FILE, JSON.stringify(answer));
`;

const input = {
  type: "object",
  properties: {
    numbers: { type: "array", items: { type: "number" } },
    mode: { type: "string" }
  },
  required: ["numbers"],
  additionalProperties: false
};

const pythonTool = (overrides: JsonObject = {}): JsonObject => ({
  name: "sum_py",
  type: "code",
  title: { en: "Sum", de: "Summe" },
  description: "Adds numbers.",
  input,
  runtime: "python",
  entry: "main.py",
  files: [{ path: "main.py", content: PYTHON }],
  ...overrides
});

const nodeTool: JsonObject = {
  name: "sum_js",
  type: "code",
  title: { en: "Sum", de: "Summe" },
  description: "Adds numbers.",
  input,
  runtime: "node",
  entry: "index.mjs",
  files: [
    { path: "index.mjs", content: NODE },
    { path: "lib/sum.mjs", content: "export const total = (n) => n.reduce((a, b) => a + b, 0);" }
  ]
};

const revisionSchema = z.object({ revision: z.number() }).loose();

let t: Awaited<ReturnType<typeof setupAccessInstance>>;
let conversationId: ConversationId;
let tempRoot = "";
const handed: WorkspaceCommandProcessInput[] = [];
const workers: JobWorker[] = [];

async function putAndPublish(config: JsonObject, name = String(config.name)) {
  const put = await t.call(t.admin.id, "assets.put", {
    params: { kind: "tool", name },
    payload: { config }
  });
  expect(put.statusCode, put.body).toBe(200);
  const { revision } = revisionSchema.parse(put.json());
  await t.expectOk(t.admin.id, "assets.publish", {
    params: { kind: "tool", name },
    payload: { revision }
  });
}

beforeAll(async () => {
  t = await setupAccessInstance({ furtherKinds: [createToolAssetKind({ checker })] });
  const workspaceId = await t.sharedWorkspace("tools");
  conversationId = (
    await t.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      createdByUserId: t.admin.id,
      createdByExternalUserId: t.admin.id,
      visibility: "private",
      title: "Tools",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    })
  ).id;
  tempRoot = await mkdtemp(join(tmpdir(), "tool-code-calls-"));
  await putAndPublish(pythonTool());
  await putAndPublish(pythonTool({ name: "slow_py", timeoutSeconds: 1 }), "slow_py");
  await putAndPublish(nodeTool);
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await checker.close();
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  handed.length = 0;
});

/** The command worker: its jobs on the local sandbox, with a path to the test's interpreters. */
function startWorker(sandbox?: WorkspaceCommandProcessExecutor) {
  const local = new LocalWorkspaceCommandProcessExecutor();
  const worker = createJobWorker({
    stores: t.stores,
    clientInstanceId,
    logger: silent,
    handlers: createToolCodeCallJobs({
      clientInstanceId,
      stores: t.stores,
      tempRoot,
      slots: 2,
      limits: LIMITS,
      cancelCheckMs: 50,
      sandbox: sandbox ?? {
        execute(given) {
          handed.push(given);
          return local.execute({
            ...given,
            env: { ...given.env, PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` }
          });
        }
      }
    }).handlers
  });
  worker.start();
  workers.push(worker);
  return worker;
}

const actor: AuthenticatedUser = {
  clientInstanceId,
  id: "person",
  externalUserId: "person",
  displayLabel: "Person",
  authSource: "test",
  roles: [],
  permissionRefs: []
};

async function call(
  tool: string,
  given: JsonObject,
  options: { deadline?: Date; personal?: boolean } = {}
): Promise<ToolHandlerResult> {
  const source = createToolOperationSource({
    clientInstanceId,
    store: t.stores.configAssets,
    checker,
    codeCalls: createToolCodeCallClient({ stores: t.stores, pollMs: 20 }),
    personalConversation: async () => options.personal ?? false
  });
  const operation = await source.resolve(toolCallOperationName(tool));
  if (!operation) throw new Error(`The tool '${tool}' did not resolve`);
  const origin: OperationOrigin = {
    kind: "agent",
    agentRunId: asAgentRunId("run-1"),
    conversationId: asConversationId(conversationId),
    agentName: "calculator",
    toolCallId: asToolCallId("call-1"),
    toolName: toolCallOperationName(tool)
  };
  const context: OperationExecutionContext = {
    runId: createPlatformId("opr"),
    actor,
    access: createActorAccess({ ...actor, kind: "user" }, { holderActive: true, grants: [] }),
    audit: new NoopAuditRecorder(),
    correlationId: "tool-code-calls",
    origin,
    runtime: options.deadline ? { deadline: options.deadline } : {}
  };
  const answer = await operation.execute(given, context);
  if (!isToolOperationAnswer(answer)) throw new Error("The tool did not answer as a tool");
  return answer.result;
}

function leftRows(): Promise<number> {
  return t.stores.toolCodeCalls.pruneToolCodeCalls({
    clientInstanceId,
    before: "2999-01-01T00:00:00.000Z"
  });
}

describe("a code tool's handler", () => {
  // First: a worker that ran a call a moment ago still counts as one that takes calls.
  it("fails the call where no worker takes it", async () => {
    const source = createToolOperationSource({
      clientInstanceId,
      store: t.stores.configAssets,
      checker,
      codeCalls: createToolCodeCallClient({ stores: t.stores, pollMs: 20, unclaimedMs: 200 })
    });
    const operation = await source.resolve(toolCallOperationName("sum_py"));
    if (!operation) throw new Error("The tool did not resolve");
    expect(operation.timeoutMs).toBeGreaterThan(30_000);
    const answer = await operation.execute(
      { numbers: [1] },
      {
        runId: createPlatformId("opr"),
        actor,
        access: createActorAccess({ ...actor, kind: "user" }, { holderActive: true, grants: [] }),
        audit: new NoopAuditRecorder(),
        correlationId: "tool-code-calls",
        origin: {
          kind: "agent",
          agentRunId: asAgentRunId("run-2"),
          conversationId: asConversationId(conversationId),
          agentName: "calculator",
          toolCallId: asToolCallId("call-2"),
          toolName: toolCallOperationName("sum_py")
        },
        runtime: {}
      }
    );
    expect(isToolOperationAnswer(answer) ? answer.result : answer).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", details: { reason: "no_worker" } }
    });
    expect(await leftRows()).toBe(0);
  });
  it("runs in Python on the agent's input and answers with output for the model", async () => {
    startWorker();
    expect(await call("sum_py", { numbers: [1, 2, 3] })).toEqual({
      status: "success",
      output: { total: 6 }
    });
    // The call's row is gone once the operation read it.
    expect(await leftRows()).toBe(0);
  });

  it("hands its display data to the panel as the conversation's result, keyed by the tool", async () => {
    startWorker();
    expect(await call("sum_py", { numbers: [2, 3], mode: "data" })).toEqual({
      status: "success",
      output: { total: 5 },
      structuredResult: {
        key: "sum_py",
        kind: "figures.total",
        schemaVersion: 1,
        title: "Total",
        data: { total: 5 }
      }
    });
  });

  it("shows its HTML as show_view does, without scripts in a personal conversation", async () => {
    startWorker();
    const shown = await call("sum_py", { numbers: [4], mode: "html" });
    expect(shown).toMatchObject({
      status: "success",
      output: "shown",
      display: {
        kind: "html.rendered",
        version: 2,
        mode: "inline",
        title: "Total",
        data: { html: "<p>4</p>", title: "Total" }
      }
    });
    const personal = await call("sum_py", { numbers: [4], mode: "html" }, { personal: true });
    expect(personal).toMatchObject({ display: { kind: "private_hydrated_view" } });
  });

  it("runs in Node, importing from its own files, with a data and an HTML display", async () => {
    startWorker();
    expect(await call("sum_js", { numbers: [5, 6] })).toEqual({
      status: "success",
      output: { total: 11 },
      structuredResult: {
        key: "sum_js",
        kind: "figures.total",
        schemaVersion: 1,
        title: "Total",
        data: { total: 11 }
      }
    });
    expect(await call("sum_js", { numbers: [1], mode: "html" })).toMatchObject({
      status: "success",
      output: "shown",
      display: { kind: "html.rendered", data: { html: "<b>1</b>" } }
    });
  });

  it("runs with an empty environment in a container without a network (check 80)", async () => {
    process.env.CATALYST_TEST_PLATFORM_SECRET = "not-for-a-tool";
    try {
      startWorker();
      const listed = await call("sum_py", { numbers: [], mode: "env" });
      expect(listed.status).toBe("success");
      const keys = listed.status === "success" ? z.array(z.string()).parse(listed.output) : [];
      expect(keys).not.toContain("CATALYST_TEST_PLATFORM_SECRET");
    } finally {
      delete process.env.CATALYST_TEST_PLATFORM_SECRET;
    }
    const [invocation] = handed;
    if (!invocation) throw new Error("No handler was handed to the sandbox");
    expect(invocation.env).toEqual({});
    expect(invocation.command.id.startsWith("tool-call-")).toBe(true);
    const { args } = createDockerRunInvocation(invocation, {
      image: "runner:test",
      runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false }
    });
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
  });

  it("is stopped past its timeout, and the call fails with timed_out (check 80)", async () => {
    startWorker();
    const began = Date.now();
    expect(await call("slow_py", { numbers: [], mode: "sleep" })).toEqual({
      status: "timed_out",
      error: {
        code: "timed_out",
        message: "The tool 'slow_py' did not answer within 1 seconds and was stopped."
      }
    });
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(await leftRows()).toBe(0);
  });

  it("is stopped at the agent's tool deadline when that comes first", async () => {
    startWorker();
    const began = Date.now();
    const ended = await call(
      "sum_py",
      { numbers: [], mode: "sleep" },
      { deadline: new Date(Date.now() + 1_500) }
    );
    expect(ended).toMatchObject({ status: "timed_out", error: { code: "timed_out" } });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(await leftRows()).toBe(0);
  });

  it("fails the call where it answers no JSON or no output, without echoing its answer", async () => {
    startWorker();
    const notJson = await call("sum_py", { numbers: [], mode: "not_json" });
    expect(notJson).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", details: { reason: "code_output_not_json" } }
    });
    expect(JSON.stringify(notJson)).not.toContain("this is no JSON");
    expect(await call("sum_py", { numbers: [], mode: "no_output" })).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        details: { reason: "tool_answer_invalid" },
        message: expect.stringContaining("no valid answer") as unknown
      }
    });
  });

  it("fails the call where it ends with an error, naming the end of its error stream", async () => {
    startWorker();
    const failed = await call("sum_py", { numbers: [], mode: "fail" });
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", details: { reason: "code_failed" } }
    });
    expect(failed.status === "failed" ? failed.error.message : "").toContain(
      "the ledger is closed"
    );
  });
});

describe("a code tool's definition", () => {
  it("is refused where its files hold no handler, and listed with its runtime", async () => {
    const missing = await t.call(t.admin.id, "assets.put", {
      params: { kind: "tool", name: "broken_py" },
      payload: {
        config: pythonTool({ name: "broken_py", files: [{ path: "other.py", content: "" }] })
      }
    });
    expect(missing.statusCode, missing.body).toBe(422);
    expect(missing.body).toContain("main.py");

    const listed = z
      .object({ items: z.array(z.object({ name: z.string(), attributes: z.unknown() })) })
      .parse((await t.expectOk(t.admin.id, "assets.list", { params: { kind: "tool" } })).json());
    expect(listed.items.find((item) => item.name === "sum_js")?.attributes).toEqual({
      type: "code",
      runtime: "node"
    });
  });
});

// Against the runner image in a real container, where Docker and the image are at hand:
//   CATALYST_RUNNER_IMAGE=<image> pnpm exec vitest run tests/tool-code-calls.test.ts
const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a code tool's handler in a container of the runner image", () => {
  const docker = () => new DockerWorkspaceCommandProcessExecutor({ image: runnerImage ?? "" });

  it("cannot open a socket, sees no secret and answers (check 80)", async () => {
    startWorker(docker());
    expect(await call("sum_py", { numbers: [1, 2], mode: "data" })).toMatchObject({
      status: "success",
      output: { total: 3 }
    });
    const socket = await call("sum_py", { numbers: [], mode: "socket" });
    expect(socket.status === "success" ? String(socket.output) : "").toMatch(/^refused/u);
    process.env.CATALYST_TEST_PLATFORM_SECRET = "not-for-a-tool";
    try {
      const listed = await call("sum_py", { numbers: [], mode: "env" });
      expect(listed.status === "success" ? listed.output : []).not.toContain(
        "CATALYST_TEST_PLATFORM_SECRET"
      );
    } finally {
      delete process.env.CATALYST_TEST_PLATFORM_SECRET;
    }
    expect(await call("sum_js", { numbers: [5, 6] })).toMatchObject({
      status: "success",
      output: { total: 11 }
    });
  });

  it("is stopped past its timeout, and the call fails with timed_out", async () => {
    startWorker(docker());
    expect(await call("slow_py", { numbers: [], mode: "sleep" })).toMatchObject({
      status: "timed_out",
      error: { code: "timed_out" }
    });
  });
});
