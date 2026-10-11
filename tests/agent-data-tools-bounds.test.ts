import { describe, expect, it } from "vitest";
import { createOperationRegistry, type OperationCall } from "@vivd-catalyst/core";
import { executeApprovedOperation } from "@vivd-catalyst/tool-execution";
import {
  ECHO,
  WRITE,
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
