import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type AuditEventInput,
  type AuditRecorder,
  type ToolExecutionContext,
  type ToolExecutionRequest
} from "@vivd-catalyst/core";
import { createOperationRegistry } from "@vivd-catalyst/core";
import {
  registerToolOperations,
  ToolRegistry,
  type OperationApprovalRequests
} from "@vivd-catalyst/tool-execution";
import { defineTool, toolFailed, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { createMemoryOperationRunStore } from "./support/memory-operation-runs";
import {
  createTestToolRunner,
  recordedAuditEvent,
  type TestToolRunnerOptions
} from "./support/tool-runner";

// An agent's tool call is a call of the operation the tool is registered as. These tests
// call as the agent runtime does and prove what the agent reads back, what the Operation Run
// records and what the audit log gets, for a call that runs and for each way it is refused.
// Each of them fails without the tool path on `runOperation`: there is no run to read.

const clientInstanceId = asClientInstanceId("demo-local");

function context(permissionRefs: string[] = ["demo-tools"]): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_test",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs,
      clientInstanceId,
      authSource: "test"
    }
  };
}

function request(toolName: string, input: unknown): ToolExecutionRequest {
  return {
    toolName,
    toolCallId: asToolCallId("toolcall_1"),
    agentRunId: asAgentRunId("run_1"),
    conversationId: asConversationId("conv_1"),
    agentName: "test_agent",
    input
  };
}

const executed: string[] = [];
const seenRuns: ToolExecutionContext["operationRun"][] = [];
const echo = defineTool({
  name: "demo.echo",
  description: "Echo text for tests.",
  effect: "changing",
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: z.object({ echoed: z.string() }),
  permission: { mode: "allow", requiredPermissionRefs: ["demo-tools"] },
  execute(input, toolContext) {
    executed.push(input.text);
    seenRuns.push(toolContext.operationRun);
    if (input.text === "throw") throw new Error("select * from secrets where token = 'abc'");
    if (input.text === "fail") return toolFailed("handler_failed", "The echo is out of order");
    return toolSuccess(
      { echoed: input.text },
      { auditSummary: { action: "demo.echoed", subject: "echo-1" } }
    );
  }
});
const denied = defineTool({
  name: "demo.denied",
  description: "A tool the release denies.",
  effect: "changing",
  inputSchema: z.object({}),
  permission: { mode: "deny", reason: "This tool is switched off for the pilot" },
  execute: () => toolSuccess({})
});

function setup(options: Partial<TestToolRunnerOptions> = {}) {
  executed.length = 0;
  seenRuns.length = 0;
  const auditEvents: Omit<AuditEventInput, "clientInstanceId">[] = [];
  const auditRecorder: AuditRecorder = {
    record(input) {
      auditEvents.push(input);
      return Promise.resolve(recordedAuditEvent(clientInstanceId, input));
    }
  };
  const runs = createMemoryOperationRunStore();
  const runTool = createTestToolRunner({
    registry: new ToolRegistry({ tools: [echo, denied] }),
    getAgentToolNames: () => ["demo.echo", "demo.denied"],
    auditRecorder,
    runs,
    ...options
  });
  return { runTool, runs: runs.runs, auditEvents };
}

describe("an agent's tool call as an operation", () => {
  it("runs the tool, answers its result and records one run that the tool is told of", async () => {
    const { runTool, runs, auditEvents } = setup();
    const call = request("demo.echo", { text: "hello" });
    const result = await runTool(call, context());

    expect(result).toMatchObject({ status: "success", output: { echoed: "hello" } });
    expect(executed).toEqual(["hello"]);

    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      operation: "demo.echo",
      effect: "changing",
      status: "done",
      actor: { kind: "user", id: "user-1", label: "User" },
      origin: {
        kind: "agent",
        agentName: "test_agent",
        toolName: "demo.echo",
        toolCallId: "toolcall_1",
        agentRunId: "run_1",
        conversationId: "conv_1"
      },
      conversationId: "conv_1",
      correlationId: "corr_test"
    });
    // The run keeps the hash of the input and never the input.
    expect(JSON.stringify({ ...run, output: undefined })).not.toContain("hello");

    // The tool is told which run its call is, so a model call it makes can name that run.
    expect(seenRuns).toEqual([{ id: run?.id }]);

    expect(auditEvents.map((event) => `${event.type}:${event.status}`)).toEqual([
      "operation.authorization_checked:success",
      "operation.started:success",
      "operation.completed:success"
    ]);
    for (const event of auditEvents) {
      expect(event).toMatchObject({
        subject: "demo.echo",
        correlationId: "corr_test",
        metadata: {
          operationRunId: run?.id,
          origin: "agent",
          agentName: "test_agent",
          conversationId: "conv_1",
          toolCallId: "toolcall_1"
        }
      });
    }
    // What the tool says it did is on the row that says the call completed.
    expect(auditEvents[2]?.metadata).toMatchObject({
      resultStatus: "success",
      auditAction: "demo.echoed",
      auditSubject: "echo-1"
    });
  });

  it("refuses a tool the agent's definition does not list, with a denied run", async () => {
    const { runTool, runs, auditEvents } = setup({ getAgentToolNames: () => ["demo.denied"] });
    const result = await runTool(request("demo.echo", { text: "hello" }), context());

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "not_allowed",
        message: "Agent 'test_agent' is not allowed to use 'demo.echo'",
        details: undefined
      }
    });
    expect(executed).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: "agent_tool:demo.echo", reason: "no_grant" }
    });
    expect(auditEvents.map((event) => `${event.type}:${event.status}`)).toEqual([
      "operation.authorization_checked:denied",
      "operation.denied:denied"
    ]);
    expect(auditEvents[0]?.metadata).toMatchObject({ operationRunId: runs[0]?.id });
  });

  it("refuses a person without the tool's permission reference, with a denied run", async () => {
    const { runTool, runs, auditEvents } = setup();
    const result = await runTool(request("demo.echo", { text: "hello" }), context([]));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: "User is missing permission 'demo-tools'" }
    });
    expect(executed).toEqual([]);
    expect(runs[0]).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: "ref:demo-tools" }
    });
    expect(auditEvents[0]).toMatchObject({
      type: "operation.authorization_checked",
      status: "denied",
      metadata: { operationRunId: runs[0]?.id, action: "ref:demo-tools" }
    });
  });

  it("refuses a tool the release denies with the reason the tool gives", async () => {
    const { runTool, runs } = setup();
    const result = await runTool(request("demo.denied", {}), context());
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: "This tool is switched off for the pilot" }
    });
    expect(runs[0]).toMatchObject({ status: "denied", denial: { kind: "policy" } });
  });

  it("answers that a tool is not registered without a run", async () => {
    const { runTool, runs } = setup();
    const result = await runTool(request("demo.unknown", {}), context());
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: "Tool 'demo.unknown' is not registered" }
    });
    expect(runs).toEqual([]);
  });

  // S3-22: an operation of a module that is off is not there. Fails without the module check
  // on the call path: the tool of the module ran.
  it("does not run a tool whose module is off, and starts no run for it", async () => {
    const { runTool, runs } = setup({
      modules: {
        modules: [],
        isEnabled: () => false,
        offModuleOf: (contribution, name) =>
          contribution === "tool" && name === "demo.echo" ? "documents" : undefined
      }
    });
    const result = await runTool(request("demo.echo", { text: "hello" }), context());
    // The agent reads what it reads for a tool that does not exist.
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: "Tool 'demo.echo' is not registered" }
    });
    expect(executed).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("answers an invalid input as the validation failure an agent has always read", async () => {
    const { runTool, runs } = setup();
    const result = await runTool(request("demo.echo", { text: "" }), context());
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: "Tool input or output failed validation",
        details: { issues: [{ path: "text" }] }
      }
    });
    expect(executed).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("answers an input that could not be read with what the reader said", async () => {
    const { runTool } = setup();
    const result = await runTool(request("demo.echo", {}), context(), {
      unreadableInput: { code: "invalid_json", message: "Tool input must be valid JSON" }
    });
    expect(result).toEqual({
      status: "failed",
      error: {
        code: "validation_failed",
        message: "Tool input must be valid JSON",
        details: {
          issues: [{ code: "invalid_json", path: "", message: "Tool input must be valid JSON" }]
        }
      }
    });
  });

  it("asks the surface before the input, so a tool that is not listed is refused as that", async () => {
    const { runTool } = setup({ getAgentToolNames: () => [] });
    const result = await runTool(request("demo.echo", { text: "" }), context());
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "not_allowed",
        message: "Agent 'test_agent' is not allowed to use 'demo.echo'"
      }
    });
  });

  it("hands on a failure the tool reports and records the run as failed with its code", async () => {
    const { runTool, runs, auditEvents } = setup();
    const result = await runTool(request("demo.echo", { text: "fail" }), context());
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "handler_failed", message: "The echo is out of order" }
    });
    expect(runs[0]).toMatchObject({ status: "failed", error: { code: "handler_failed" } });
    // What the tool said stays in the conversation; the run keeps the code alone.
    expect(JSON.stringify(runs[0])).not.toContain("out of order");
    expect(auditEvents.at(-1)).toMatchObject({ type: "operation.failed", status: "failed" });
  });

  it("tells the agent a reference and nothing of an error the tool threw", async () => {
    const { runTool, runs } = setup();
    const result = await runTool(request("demo.echo", { text: "throw" }), context());
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "The tool failed with an internal error. Reference: corr_test"
      }
    });
    expect(JSON.stringify([result, runs])).not.toContain("secrets");
    expect(runs[0]).toMatchObject({ status: "failed" });
  });
});

describe("an agent's tool call that needs another person's approval", () => {
  const filed: string[] = [];
  const approvals: OperationApprovalRequests = {
    request({ run }) {
      filed.push(run.id);
      return Promise.resolve({ approvalRequestId: `apr_${filed.length}` });
    }
  };

  it("files the request, runs nothing and tells the agent that the call waits", async () => {
    filed.length = 0;
    const { runTool, runs } = setup({
      centralSettings: [{ operation: "demo.echo", value: "approval" }],
      approvals
    });
    const result = await runTool(request("demo.echo", { text: "hello" }), context());

    expect(executed).toEqual([]);
    expect(runs[0]).toMatchObject({ status: "pending_approval", approvalRequestId: "apr_1" });
    expect(filed).toEqual([runs[0]?.id]);
    expect(result).toMatchObject({
      status: "success",
      output: { requestId: "apr_1", status: "pending_approval" },
      display: {
        kind: "catalyst.approval_request",
        version: 1,
        mode: "inline",
        data: { requestId: "apr_1", kind: "operation_call" }
      }
    });
  });

  it("refuses the call where this process cannot hold one for an approval", async () => {
    const { runTool, runs } = setup({
      centralSettings: [{ operation: "demo.echo", value: "approval" }]
    });
    const result = await runTool(request("demo.echo", { text: "hello" }), context());
    expect(result).toMatchObject({ status: "failed", error: { code: "not_allowed" } });
    expect(executed).toEqual([]);
    expect(runs[0]).toMatchObject({ status: "denied", denial: { kind: "policy" } });
  });
});

describe("a tool that declares less than a call of it needs", () => {
  const modeless = defineTool({
    name: "demo.modeless",
    description: "Changes something and names no permission mode.",
    effect: "changing",
    inputSchema: z.object({ text: z.string() }),
    execute(input) {
      executed.push(input.text);
      return toolSuccess({});
    }
  });
  const withModeless = (options: Partial<TestToolRunnerOptions> = {}) =>
    setup({
      registry: new ToolRegistry({ tools: [modeless] }),
      getAgentToolNames: () => [modeless.name],
      ...options
    });

  // Fails before the fix: a tool without a mode was registered with the default `allow`, so
  // it ran whatever the instance default said.
  it("takes the instance default where it names no mode, and is never allowed on its own", async () => {
    const confirmed = withModeless();
    const refused = await confirmed.runTool(request(modeless.name, { text: "one" }), context());
    // An agent's call cannot wait for its own caller, so `confirm` refuses it.
    expect(refused).toMatchObject({ status: "failed", error: { code: "not_allowed" } });
    expect(executed).toEqual([]);
    expect(confirmed.runs[0]).toMatchObject({ status: "denied", denial: { kind: "policy" } });

    const filed: string[] = [];
    const held = withModeless({
      changingDefault: "approval",
      approvals: {
        request({ run }) {
          filed.push(run.id);
          return Promise.resolve({ approvalRequestId: "apr_modeless" });
        }
      }
    });
    await held.runTool(request(modeless.name, { text: "two" }), context());
    expect(executed).toEqual([]);
    expect(held.runs[0]).toMatchObject({
      status: "pending_approval",
      approvalRequestId: "apr_modeless"
    });
    expect(filed).toEqual([held.runs[0]?.id]);

    const allowed = withModeless({ changingDefault: "allow" });
    const ran = await allowed.runTool(request(modeless.name, { text: "three" }), context());
    expect(ran).toMatchObject({ status: "success" });
    expect(executed).toEqual(["three"]);
  });

  // Fails before the fix: the tool was registered, and every call of it ended as INTERNAL.
  it("refuses to register a tool that declares no effect, with the name of the tool", () => {
    const effectless = Object.assign({}, modeless, { name: "demo.effectless", effect: undefined });
    expect(() =>
      registerToolOperations(createOperationRegistry(), [effectless], { clientInstanceId })
    ).toThrowError(
      "Tool 'demo.effectless' declares no effect. Declare effect 'reading' or 'changing' in its definition."
    );
  });
});
