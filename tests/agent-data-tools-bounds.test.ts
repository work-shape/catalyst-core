import { describe, expect, it } from "vitest";
import { describeAgentDataTools } from "@work-shape/catalyst-agent-runtime";
import { createOperationRegistry, type OperationCall } from "@work-shape/catalyst-core";
import {
  DataToolSourceBusyError,
  createBoundedDataToolSource,
  createToolOperationRunner,
  executeApprovedOperation
} from "@work-shape/catalyst-tool-execution";
import {
  ECHO,
  WRITE,
  agent,
  context,
  createCallPath,
  createFakeConnection,
  toolRequest
} from "./support/data-tools-fixture";

describe("a call that waited for an approval", () => {
  it("is refused without a read of the source when the tool left the agent meanwhile", async () => {
    const connection = createFakeConnection({ writePolicy: "approval" });
    const agentToolNames: Record<string, readonly string[]> = { data_agent: [WRITE] };
    const held: OperationCall[] = [];
    const path = createCallPath({
      agentToolNames,
      connection,
      approvals: {
        request({ call }) {
          held.push(call);
          return Promise.resolve({ approvalRequestId: "approval_1" });
        }
      }
    });
    const waiting = await path.runTool(toolRequest(WRITE, "data_agent"), context);
    expect(waiting).toMatchObject({ status: "success", output: { status: "pending_approval" } });
    const [call] = held;
    const [run] = path.runs.runs;
    if (!call || !run) throw new Error("Expected one held call with its run");
    const approver = { id: "approver", label: "Approver", at: new Date().toISOString() };

    // The tool leaves the agent while the approval waits, and the source is down.
    agentToolNames.data_agent = [];
    connection.source.answers = "throws";
    const readsBefore = [connection.resolveCalls.length, connection.describeCalls.length];

    const end = await executeApprovedOperation({ runId: run.id, call }, approver, path.deps);

    expect(end).toMatchObject({ execution: "refused", error: { code: "FORBIDDEN" } });
    expect(path.runs.runs[0]).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: `agent_tool:${WRITE}`, reason: "no_grant" }
    });
    expect(connection.executed).toEqual([]);
    expect([connection.resolveCalls.length, connection.describeCalls.length]).toEqual(readsBefore);
  });

  it("runs once approved while the agent still lists the tool", async () => {
    const connection = createFakeConnection({ writePolicy: "approval" });
    const held: OperationCall[] = [];
    const path = createCallPath({
      agentToolNames: { data_agent: [WRITE] },
      connection,
      approvals: {
        request({ call }) {
          held.push(call);
          return Promise.resolve({ approvalRequestId: "approval_1" });
        }
      }
    });
    await path.runTool(toolRequest(WRITE, "data_agent"), context);
    const [call] = held;
    const [run] = path.runs.runs;
    if (!call || !run) throw new Error("Expected one held call with its run");

    const end = await executeApprovedOperation(
      { runId: run.id, call },
      { id: "approver", label: "Approver", at: new Date().toISOString() },
      path.deps
    );

    expect(end).toMatchObject({ execution: "done" });
    expect(connection.executed).toEqual([WRITE]);
  });
});

describe("a bounded data tool source", () => {
  it("shares one outstanding read among callers that ask for the same tools", async () => {
    const connection = createFakeConnection();
    const bounded = createBoundedDataToolSource(connection.toolSource);

    const answers = await Promise.all([
      bounded.describe([ECHO, WRITE], {}),
      bounded.describe([WRITE, ECHO], {}),
      bounded.describe([ECHO, WRITE, ECHO], {})
    ]);

    expect(connection.describeCalls).toEqual([[ECHO, WRITE]]);
    expect(answers.map((answer) => answer.map((tool) => tool.name))).toEqual([
      [ECHO, WRITE],
      [ECHO, WRITE],
      [ECHO, WRITE]
    ]);
    // An answered read is not kept: the next caller reads again.
    expect(bounded.outstanding).toBe(0);
    await bounded.describe([ECHO, WRITE], {});
    expect(connection.describeCalls).toHaveLength(2);
  });

  it("holds a stalled source to its ceiling and answers further reads at once", async () => {
    const connection = createFakeConnection();
    connection.source.answers = "never";
    const bounded = createBoundedDataToolSource(connection.toolSource, { maxOutstanding: 2 });
    const path = createCallPath({ agentToolNames: { data_agent: [ECHO, WRITE] }, connection });
    const runTool = createToolOperationRunner(path.deps, path.toolRegistry, {
      source: bounded,
      describeTimeoutMs: 50
    });

    // Many calls of two tools, each abandoned by its caller after the timeout.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        runTool(toolRequest(index % 2 === 0 ? ECHO : WRITE, "data_agent"), context)
      )
    );
    expect(new Set(results.map((result) => result.status))).toEqual(new Set(["failed"]));
    // Two reads reached the source and two stay outstanding, whatever the number of callers.
    expect(connection.describeCalls).toEqual([[ECHO], [WRITE]]);
    expect(bounded.outstanding).toBe(2);

    // A third key is above the ceiling: refused at once, and the source is not asked.
    await expect(bounded.describe([ECHO, WRITE], {})).rejects.toBeInstanceOf(
      DataToolSourceBusyError
    );
    const started = Date.now();
    const atRunStart = await describeAgentDataTools(
      agent("data_agent", [ECHO, WRITE]),
      bounded,
      60_000
    );
    expect(atRunStart).toEqual({
      described: [],
      missing: [ECHO, WRITE],
      sourceFailure: "failed"
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.describeCalls).toHaveLength(2);
  });
});

describe("the operation registry", () => {
  it("refuses a release operation that takes a name of a data operation", async () => {
    const connection = createFakeConnection();
    const registry = createOperationRegistry();
    registry.addSource(connection.operationSource);
    const fromSource = await registry.resolve(ECHO);
    if (!fromSource) throw new Error("Expected the source to contribute the operation");

    // Registered, it would be resolved before the source and stand in for the data operation.
    expect(() => registry.register({ ...fromSource, name: ECHO })).toThrow(
      /starts with 'connection\.', which names operations that come from data/u
    );
    expect(() => registry.register({ ...fromSource, name: "connection.other" })).toThrow();
    expect(await registry.resolve(ECHO)).toBe(fromSource);
    // The plural prefix of the management operations is free.
    expect(() => registry.register({ ...fromSource, name: "connections.test" })).not.toThrow();
  });
});
