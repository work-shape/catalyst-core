import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  TEST_CREDENTIAL_SUBJECT,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  toolCallOperationName,
  type ConversationId,
  type JobWorker,
  type JsonObject,
  type Logger,
  type OperationCall,
  type OperationCallRuntime,
  type OperationOrigin,
  type UserRecord
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
  executeConfirmedOperation,
  runOperation
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";
import {
  fixtureOn,
  identityOf,
  operationOf,
  type ConnectionOperationsFixture
} from "./support/connection-operations";
import { generateTestSecret } from "./support/test-connector";
import { withTestSql } from "./support/test-sql";

// A code tool's handler calls a Connection (TOOL-2c, platform-access.md section 3a): only an
// operation the tool declares, as the tool's caller, with the tool's call as its origin, and
// under the policy the tool's call asked once before the handler started. The handler runs in
// the local sandbox; the request channel is the one the container gets, and the credential
// stays with the platform. Where `CATALYST_RUNNER_IMAGE` names the runner image, the handlers
// run in its container, with no network, and the channel is the container's.

const checker = createOutsideSchemaChecker();
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const LIMITS = {
  cpuCount: 1,
  memoryBytes: 128 * 1024 ** 2,
  pidsLimit: 64,
  scratchBytes: 16 * 1024 ** 2
};
const AGENT = "assistant";
const runnerImage = process.env.CATALYST_RUNNER_IMAGE;

const PYTHON = `
import json, os, sys
from catalyst_tool import ConnectionCallError, call, connection
data = json.load(sys.stdin)
mode = data.get("mode")
try:
    if mode == "undeclared":
        out = call("crm", "write", {})
    elif mode == "env":
        out = {"env": dict(os.environ), "echo": connection("crm").call("echo", {"text": data["text"]})}
    elif mode == "many":
        done = 0
        try:
            for _ in range(60):
                connection("crm").call("echo", {"text": "again"})
                done += 1
        except ConnectionCallError as error:
            out = {"done": done, "code": error.code}
    elif mode == "write":
        out = connection("crm").call("write", {"note": data["text"]})
    else:
        out = connection("crm").call("echo", {"text": data["text"]})
    answer = {"output": out}
except ConnectionCallError as error:
    answer = {"output": {"code": error.code}}
print(json.dumps(answer))
`;

const NODE = `
import { readFileSync, writeFileSync } from "node:fs";
import { connection, ConnectionCallError } from "catalyst-tool";
const data = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT_FILE, "utf8"));
let output;
try {
  const first = await connection("crm").call("echo", { text: data.text });
  const second = await connection("crm").call("echo", { text: data.text + "!" });
  output = [first, second];
} catch (error) {
  output = { code: error instanceof ConnectionCallError ? error.code : "other" };
}
console.log("printed beside");
writeFileSync(process.env.WORKFLOW_OUTPUT_FILE, JSON.stringify({ output }));
`;

const input = {
  type: "object",
  properties: { text: { type: "string" }, mode: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};

const pythonTool = (name: string, connections: string[]): JsonObject => ({
  name,
  type: "code",
  title: { en: "Look up", de: "Nachschlagen" },
  description: "Looks something up in the CRM.",
  input,
  runtime: "python",
  entry: "main.py",
  files: [{ path: "main.py", content: PYTHON }],
  connections
});

const nodeTool: JsonObject = {
  name: "lookup_js",
  type: "code",
  title: { en: "Look up", de: "Nachschlagen" },
  description: "Looks something up in the CRM.",
  input,
  runtime: "node",
  entry: "index.mjs",
  files: [{ path: "index.mjs", content: NODE }],
  connections: ["connection.crm.echo"]
};

const revisionSchema = z.object({ revision: z.number() }).loose();
const refusalSchema = z.object({
  error: z.looseObject({ code: z.string(), details: z.looseObject({}).optional() })
});

let f: ConnectionOperationsFixture;
let conversationId: ConversationId;
let crm = "";
let tempRoot = "";
const workers: JobWorker[] = [];

async function putTool(config: JsonObject) {
  return f.call(f.admin.id, "assets.put", {
    params: { kind: "tool", name: String(config.name) },
    payload: { config }
  });
}

async function publishTool(config: JsonObject) {
  const put = await putTool(config);
  expect(put.statusCode, put.body).toBe(200);
  const { revision } = revisionSchema.parse(put.json());
  await f.expectOk(f.admin.id, "assets.publish", {
    params: { kind: "tool", name: String(config.name) },
    payload: { revision }
  });
}

beforeAll(async () => {
  f = await fixtureOn((options) =>
    setupAccessInstance({
      ...options,
      furtherKinds: [
        ...(options.furtherKinds ?? []),
        createToolAssetKind({ checker, operations: () => f.operationCalls })
      ]
    })
  );
  f.operationCalls.registry.addSource(
    createToolOperationSource({
      clientInstanceId,
      store: f.stores.configAssets,
      checker,
      codeCalls: createToolCodeCallClient({ stores: f.stores, pollMs: 10 }),
      operations: () => f.operationCalls
    })
  );
  crm = await f.seed("crm", {
    operations: [operationOf("echo"), operationOf("write", { effect: "changing" })]
  });
  const workspaceId = await f.sharedWorkspace("tools");
  conversationId = (
    await f.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      createdByUserId: f.kai.id,
      createdByExternalUserId: f.kai.id,
      visibility: "private",
      title: "Tools",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    })
  ).id;
  tempRoot = await mkdtemp(join(tmpdir(), "tool-code-connections-"));
  await publishTool(pythonTool("lookup_py", ["connection.crm.echo"]));
  await publishTool(pythonTool("write_py", ["connection.crm.echo", "connection.crm.write"]));
  await publishTool(nodeTool);
  f.state.agentTools.set(
    AGENT,
    ["lookup_py", "write_py", "lookup_js"].map((tool) => toolCallOperationName(tool))
  );
  await f.grant(f.kai.id, "connection.use", { assetId: crm });
  startWorker();
});

afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await rm(tempRoot, { recursive: true, force: true });
  await checker.close();
});

afterEach(() => {
  f.state.centralSettings = [];
});

function startWorker() {
  const local = new LocalWorkspaceCommandProcessExecutor();
  const worker = createJobWorker({
    stores: f.stores,
    clientInstanceId,
    logger: silent,
    handlers: createToolCodeCallJobs({
      clientInstanceId,
      stores: f.stores,
      tempRoot,
      slots: 2,
      limits: LIMITS,
      cancelCheckMs: 50,
      requestPollMs: 10,
      sandbox: runnerImage
        ? new DockerWorkspaceCommandProcessExecutor({ image: runnerImage })
        : {
            execute(given) {
              return local.execute({
                ...given,
                env: {
                  ...given.env,
                  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`
                }
              });
            }
          }
    }).handlers
  });
  worker.start();
  workers.push(worker);
}

const originOf = (tool: string): OperationOrigin => ({
  kind: "agent",
  agentRunId: asAgentRunId(createPlatformId("run")),
  conversationId: asConversationId(conversationId),
  agentName: AGENT,
  toolCallId: asToolCallId(createPlatformId("call")),
  toolName: toolCallOperationName(tool)
});

/** The agent's call of a tool as `user`, and the runtime it is made in. */
function toolCall(
  user: UserRecord,
  tool: string,
  given: JsonObject,
  further: { fenced?: boolean; preview?: boolean } = {}
): { call: OperationCall; runtime: OperationCallRuntime } {
  const origin = originOf(tool);
  // An Agent Run's worker holds the run's fence: only its call can wait for a confirmation.
  const runtime: OperationCallRuntime =
    further.fenced && origin.kind === "agent"
      ? {
          runFence: {
            runId: origin.agentRunId,
            lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
          }
        }
      : {};
  return {
    call: {
      operation: toolCallOperationName(tool),
      effect: "changing",
      input: given,
      actor: identityOf(user),
      origin,
      correlationId: createPlatformId("corr"),
      ...(further.preview
        ? {
            draft: {
              kind: "agent_preview" as const,
              asset: { kind: "agent", id: "preview-agent", name: AGENT },
              revisionId: "preview-revision",
              part: "agent"
            }
          }
        : {})
    },
    runtime
  };
}

/** The agent's call of a tool, through the call path, as `user`. */
function callTool(...args: Parameters<typeof toolCall>) {
  const { call, runtime } = toolCall(...args);
  return runOperation(call, f.operationCalls.deps, runtime);
}

/** What the tool's handler answered the model. */
function outputOf(outcome: Awaited<ReturnType<typeof callTool>>): unknown {
  expect(outcome.result.status, JSON.stringify([outcome.result, outcome.run.error])).toBe("done");
  return outcome.result.status === "done" ? outcome.result.output : undefined;
}

describe("a code tool's handler calling a Connection", () => {
  it("is refused at the write when it declares an operation that does not exist", async () => {
    const put = await putTool(
      pythonTool("broken_py", ["connection.crm.echo", "connection.crm.delete_all"])
    );
    expect(put.statusCode).toBe(422);
    expect(refusalSchema.parse(put.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "tool_connection_unknown" }
    });
    expect(put.body).toContain("connection.crm.delete_all");
  });

  it("calls a declared operation as the caller, from the tool's call, and never sees the secret", async () => {
    const before = f.handed.length;
    const outcome = await callTool(f.kai, "lookup_py", { text: "acme-marker", mode: "env" });
    const output = z
      .object({ env: z.record(z.string(), z.string()), echo: z.unknown() })
      .parse(outputOf(outcome));
    expect(output.echo).toEqual({ text: "acme-marker" });
    // The Connector type was handed the credential; the handler's environment holds none of it.
    expect(f.handed.slice(before)).toEqual([f.secret]);
    expect(JSON.stringify(output.env)).not.toContain(f.secret);
    expect(Object.keys(output.env)).toEqual(
      expect.arrayContaining(["CATALYST_REQUEST_FD", "CATALYST_ANSWER_FD"])
    );

    const inner = (await f.runs()).filter(
      (run) => run.origin.kind === "agent" && run.origin.byTool?.runId === outcome.run.id
    );
    expect(inner).toHaveLength(1);
    expect(inner[0]).toMatchObject({
      operation: "connection.crm.echo",
      status: "done",
      target: "live",
      actor: { kind: "user", id: f.kai.id },
      origin: { kind: "agent", toolName: toolCallOperationName("lookup_py") }
    });
    // The audit names the call, never what it was handed or answered.
    const audit = await f.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    const ofInner = audit.filter((event) => JSON.stringify(event).includes(inner[0]?.id ?? "-"));
    expect(ofInner.length).toBeGreaterThan(0);
    expect(JSON.stringify(ofInner)).not.toContain("acme-marker");
  });

  it("answers several calls of a Node handler in order, apart from what it prints", async () => {
    const outcome = await callTool(f.kai, "lookup_js", { text: "row" });
    expect(outputOf(outcome)).toEqual([{ text: "row" }, { text: "row!" }]);
  });

  it("refuses an operation the tool does not declare", async () => {
    const executed = f.handed.length;
    const outcome = await callTool(f.kai, "lookup_py", { text: "x", mode: "undeclared" });
    expect(outputOf(outcome)).toEqual({ code: "connection_not_declared" });
    expect(f.handed.length).toBe(executed);
  });

  it("bounds the number of requests of one call", async () => {
    const outcome = await callTool(f.kai, "lookup_py", { text: "x", mode: "many" });
    expect(outputOf(outcome)).toEqual({ done: 50, code: "too_many_requests" });
  }, 60_000);

  it("calls with the caller's rights: one without connection.use is refused in the handler", async () => {
    const executed = f.handed.length;
    const outcome = await callTool(f.lena, "lookup_py", { text: "x" });
    expect(outputOf(outcome)).toEqual({ code: "forbidden" });
    expect(f.handed.length).toBe(executed);
  });

  describe("the folded policy", () => {
    it("asks a declared operation's confirm once, on the tool's call, before the handler starts", async () => {
      const executed = f.handed.length;
      // `write` is changing: the default asks to confirm it, so the tool's call asks.
      const refused = await callTool(f.kai, "write_py", { text: "note", mode: "write" });
      expect(refused.result).toMatchObject({ status: "denied" });
      const held = await callTool(
        f.kai,
        "write_py",
        { text: "note", mode: "write" },
        { fenced: true }
      );
      expect(held.result.status).toBe("pending_confirmation");
      expect(f.handed.length).toBe(executed);
    });

    it("makes the handler's call without asking again once the tool's call was confirmed", async () => {
      const { call, runtime } = toolCall(
        f.kai,
        "write_py",
        { text: "confirmed", mode: "write" },
        { fenced: true }
      );
      const held = await runOperation(call, f.operationCalls.deps, runtime);
      expect(held.result.status).toBe("pending_confirmation");
      await withTestSql(
        (sql) => sql`
          update operation_runs
          set decision = ${sql.json({ mode: "confirmed", by: f.kai.id, at: new Date().toISOString() })}
          where id = ${held.run.id}`
      );
      const ended = await executeConfirmedOperation(
        { runId: held.run.id, call },
        f.operationCalls.deps,
        { runtime }
      );
      expect(ended).toMatchObject({ execution: "done" });
      const inner = (await f.runs()).find(
        (run) => run.origin.kind === "agent" && run.origin.byTool?.runId === held.run.id
      );
      expect(inner).toMatchObject({
        operation: "connection.crm.write",
        status: "done",
        decision: { mode: "direct", reason: "tool_call" }
      });
    });

    it("asks nothing where the declared operations are allowed, and a setting on the tool lowers none", async () => {
      f.state.centralSettings = [{ operation: toolCallOperationName("write_py"), value: "allow" }];
      expect(
        (await callTool(f.kai, "write_py", { text: "n", mode: "write" })).result
      ).toMatchObject({
        status: "denied"
      });
      f.state.centralSettings = [{ operation: "connection.crm.write", value: "allow" }];
      const outcome = await callTool(f.kai, "write_py", { text: "note", mode: "write" });
      expect(outputOf(outcome)).toEqual({ note: "note" });
    });

    it("refuses the tool's call where a declared operation is denied", async () => {
      f.state.centralSettings = [{ operation: "connection.crm.echo", value: "deny" }];
      const executed = f.handed.length;
      const outcome = await callTool(f.kai, "lookup_py", { text: "x" });
      expect(outcome.result).toMatchObject({ status: "denied" });
      expect(f.handed.length).toBe(executed);
    });
  });

  it("reaches the Connection's test credential from a draft agent's Try", async () => {
    const testValue = generateTestSecret();
    const read = await f.call(f.admin.id, "assets.get", {
      params: { kind: "connection", name: "crm" }
    });
    const set = await f.call(f.admin.id, "connections.set_test_credential", {
      params: { name: "crm" },
      payload: {
        value: testValue,
        expectedVersion: null,
        expectedRevision: revisionSchema.parse(read.json()).revision
      }
    });
    expect(set.statusCode, set.body).toBe(200);
    try {
      const before = f.handed.length;
      const outcome = await callTool(f.kai, "lookup_py", { text: "try" }, { preview: true });
      expect(outputOf(outcome)).toEqual({ text: "try" });
      expect(f.handed.slice(before)).toEqual([testValue]);
      const inner = (await f.runs()).find(
        (run) => run.origin.kind === "agent" && run.origin.byTool?.runId === outcome.run.id
      );
      expect(inner).toMatchObject({ target: "test", status: "done" });
    } finally {
      await f.stores.connections.deleteConnectionTestCredential({
        clientInstanceId,
        connectionAssetId: crm
      });
      await f.stores.connections.deleteSecrets({
        clientInstanceId,
        connectionAssetId: crm,
        subject: TEST_CREDENTIAL_SUBJECT
      });
    }
  });
});
