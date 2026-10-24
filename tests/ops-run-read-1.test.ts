import { describe, expect, it } from "vitest";
import { asToolCallId } from "@work-shape/catalyst-core";
import { agentOrigin, fixture, operationOf } from "./support/connection-operations";

// OPS-RUN-READ-1: the person a held call waits on reads that call's run while it waits, so the
// approval card shows the request, without `audit.view`. Every other run stays governance
// evidence: nobody reads it, or lists runs, on the right that decides one request.

const HELD = [operationOf("write", { effect: "changing", policy: "approval" })];

/** Kai's held call on each of two Connections: its run and the request it waits on. */
async function heldOnTwo() {
  const t = await fixture();
  const crm = await t.seed("crm", { operations: HELD, origin: "runtime" });
  const ledger = await t.seed("ledger", { operations: HELD, origin: "runtime" });
  for (const assetId of [crm, ledger]) await t.grant(t.kai.id, "connection.use", { assetId });
  t.state.agentTools.set("assistant", ["connection.crm.write", "connection.ledger.write"]);
  const hold = async (name: string) => {
    const operation = `connection.${name}.write`;
    const origin = agentOrigin(operation);
    if (origin.kind !== "agent") throw new Error("Expected an agent origin");
    const outcome = await t.invoke(
      t.kai,
      operation,
      {},
      {
        origin: { ...origin, toolCallId: asToolCallId(`call_${name}`) },
        effect: "changing",
        idempotencyKey: `held-${name}`
      }
    );
    expect(outcome.result).toMatchObject({ status: "pending_approval" });
    const requestId = outcome.run.approvalRequestId;
    if (!requestId) throw new Error(`The call on ${name} filed no request`);
    return { runId: outcome.run.id, requestId };
  };
  const held = { crm: await hold("crm"), ledger: await hold("ledger") };
  const read = (userId: string, runId: string) =>
    t.call(userId, "operations.get_run", { params: { runId } });
  return { t, crm, ledger, held, read };
}

describe("the run of a held call, to the person it waits on", () => {
  it("is read by who decides its request, while it waits, and no other run", async () => {
    const { t, crm, held, read } = await heldOnTwo();
    // Without the deciding right, Lena reads no run of Kai's.
    await t.expectRefused(
      t.lena.id,
      "operations.get_run",
      { params: { runId: held.crm.runId } },
      t.forbidden("audit.view", "no_grant")
    );

    await t.grant(t.lena.id, "connection.approve", { assetId: crm });
    const run = await read(t.lena.id, held.crm.runId);
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      id: held.crm.runId,
      status: "pending_approval",
      approvalRequestId: held.crm.requestId
    });
    // The call on the other Connection does not wait on her, and the list is still evidence.
    expect((await read(t.lena.id, held.ledger.runId)).statusCode).toBe(403);
    await t.expectRefused(
      t.lena.id,
      "operations.list_runs",
      {},
      t.forbidden("system.view", "no_grant")
    );
    // Decided, the run waits on nobody, and it is evidence again.
    const decided = await t.call(t.lena.id, "approval_requests.decide", {
      params: { requestId: held.crm.requestId },
      payload: { decision: "approve" }
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await read(t.lena.id, held.crm.runId)).statusCode).toBe(403);
    // Its caller still reads it.
    await t.expectOk(t.kai.id, "operations.get_run", { params: { runId: held.crm.runId } });
  });

  it("gives way to a deny on the deciding right", async () => {
    const { t, crm, held, read } = await heldOnTwo();
    await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action: "connection.approve",
        effect: "allow",
        scopeKind: "instance"
      }
    });
    expect((await read(t.lena.id, held.crm.runId)).statusCode).toBe(200);
    expect((await read(t.lena.id, held.ledger.runId)).statusCode).toBe(200);

    await t.grant(t.lena.id, "connection.approve", { assetId: crm }, "deny");
    expect((await read(t.lena.id, held.crm.runId)).statusCode).toBe(403);
    expect((await read(t.lena.id, held.ledger.runId)).statusCode).toBe(200);
  });

  it("is read on audit.view as before, decided or not", async () => {
    const { t, held, read } = await heldOnTwo();
    // An administrator holds audit.view by their role.
    expect((await read(t.admin.id, held.crm.runId)).statusCode).toBe(200);
    expect((await read(t.root.id, held.ledger.runId)).statusCode).toBe(200);
  });
});
