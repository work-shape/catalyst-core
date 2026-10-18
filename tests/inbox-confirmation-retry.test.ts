import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type OperationCall } from "@work-shape/catalyst-core";
import { executeInboxConfirmedOperation, runOperation } from "@work-shape/catalyst-tool-execution";
import { context, createCallPath } from "./support/data-tools-fixture";

describe("a retried Inbox confirmation", () => {
  it("still reports held after moving to a newer approval request", async () => {
    const requests: string[] = [];
    const path = createCallPath({
      agentToolNames: {},
      approvals: {
        request() {
          const approvalRequestId = `request-${requests.length + 1}`;
          requests.push(approvalRequestId);
          return Promise.resolve({ approvalRequestId });
        }
      }
    });
    let executions = 0;
    path.deps.registry.register({
      name: "test.publish",
      effect: "changing",
      action: null,
      authorize: () => ({ allowed: true }),
      scope: null,
      auth: "principal",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      resource: () => undefined,
      timeoutMs: 30_000,
      execute: async () => {
        executions++;
        return {};
      }
    });
    path.deps.events = {
      emit: async (_name, _payload, event) => ({
        outcome: event.phase === "before" ? "require_approval" : "allow",
        guardrails: []
      })
    };
    const call: OperationCall = {
      operation: "test.publish",
      effect: "changing",
      input: {},
      actor: context.user,
      origin: { kind: "cli", unattended: true },
      correlationId: "confirmation-retry"
    };
    const held = await runOperation(call, path.deps);
    expect(held.result).toMatchObject({ status: "pending_confirmation" });
    const requestId = held.run.approvalRequestId;
    if (!requestId) throw new Error("Expected the confirmation request");
    await path.runs.approveWaiting({
      clientInstanceId: path.deps.clientInstanceId,
      id: held.run.id,
      decision: { mode: "confirmed", by: call.actor.id, at: new Date().toISOString() }
    });
    const waiting = { runId: held.run.id, call };
    const options = { requestId };
    const first = await executeInboxConfirmedOperation(waiting, path.deps, options);
    expect(first).toMatchObject({ execution: "held", approvalRequestId: "request-2" });

    // Recording R1's outcome failed after R2 was filed. The job retries R1's frozen call.
    const retried = await executeInboxConfirmedOperation(waiting, path.deps, options);

    expect(retried).toMatchObject({ execution: "held", approvalRequestId: "request-2" });
    expect(path.runs.runs[0]).toMatchObject({
      status: "pending_approval",
      approvalRequestId: "request-2"
    });
    expect(requests).toEqual(["request-1", "request-2"]);
    expect(executions).toBe(0);
  });
});
