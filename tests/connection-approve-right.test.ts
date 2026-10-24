import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asToolCallId } from "@work-shape/catalyst-core";
import { agentOrigin, fixture, operationOf } from "./support/connection-operations";
import { connection } from "./support/connections";

// RIGHTS-1d: `connection.approve` decides an Approval Request for an operation or a
// configuration change on one Connection (connections-and-secrets.md, Rights), beside
// `operations.approve`, which decides every held call. It never lets the approver call the
// Connection or read it: the approved call runs as the person who made it.

const HELD = [operationOf("write", { effect: "changing", policy: "approval" })];

const listed = z.object({ items: z.array(z.object({ id: z.string(), canDecide: z.boolean() })) });

/** Two Connections whose changing operation waits for an approval, and Kai's held call on each. */
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
    const id = outcome.run.approvalRequestId;
    if (!id) throw new Error(`The call on ${name} filed no request`);
    return id;
  };
  const requests = { crm: await hold("crm"), ledger: await hold("ledger") };
  const decide = (userId: string, requestId: string) =>
    t.call(userId, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
  const list = async (userId: string) =>
    listed.parse((await t.expectOk(userId, "approval_requests.list")).json()).items;
  return { t, crm, ledger, requests, decide, list };
}

describe("connection.approve on one Connection", () => {
  it("decides the held calls on that Connection and sees no other", async () => {
    const { t, crm, requests, decide, list } = await heldOnTwo();
    await t.grant(t.lena.id, "connection.approve", { assetId: crm });

    expect(await list(t.lena.id)).toEqual([{ id: requests.crm, canDecide: true }]);
    // The request on another Connection does not exist for her.
    expect((await decide(t.lena.id, requests.ledger)).statusCode).toBe(404);
    expect(
      (await t.call(t.lena.id, "approval_requests.get", { params: { requestId: requests.ledger } }))
        .statusCode
    ).toBe(404);

    const decided = await decide(t.lena.id, requests.crm);
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ id: requests.crm, status: "approved" });
  });

  it("gives the approver no right on the Connection itself", async () => {
    const { t, crm, decide, requests } = await heldOnTwo();
    await t.grant(t.lena.id, "connection.approve", { assetId: crm });
    expect((await decide(t.lena.id, requests.crm)).statusCode).toBe(200);
    // She may not call it, read it or change it.
    t.state.agentTools.set("assistant", ["connection.crm.write"]);
    const own = await t.invoke(
      t.lena,
      "connection.crm.write",
      {},
      { origin: agentOrigin("connection.crm.write"), effect: "changing" }
    );
    expect(own.result).toMatchObject({ status: "denied" });
    expect(
      (await t.call(t.lena.id, "connections.get", { params: { name: "crm" } })).statusCode
    ).toBe(403);
    expect(
      (
        await t.call(t.lena.id, "assets.put", {
          params: { kind: "connection", name: "crm" },
          payload: {
            config: connection("crm", { connectorType: "test", origin: "runtime", enabled: false })
          }
        })
      ).statusCode
    ).toBe(403);
  });

  it("is refused where a deny lies on the Connection", async () => {
    const { t, crm, decide, requests, list } = await heldOnTwo();
    await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action: "connection.approve",
        effect: "allow",
        scopeKind: "instance"
      }
    });
    await t.grant(t.lena.id, "connection.approve", { assetId: crm }, "deny");
    expect((await list(t.lena.id)).map((item) => item.id)).toEqual([requests.ledger]);
    expect((await decide(t.lena.id, requests.crm)).statusCode).toBe(404);
    expect((await decide(t.lena.id, requests.ledger)).statusCode).toBe(200);
  });
});

describe("connection.approve on the instance", () => {
  it("decides the held calls on every Connection", async () => {
    const { t, decide, requests, list } = await heldOnTwo();
    await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action: "connection.approve",
        effect: "allow",
        scopeKind: "instance"
      }
    });
    expect((await list(t.lena.id)).map((item) => item.id).sort()).toEqual(
      [requests.crm, requests.ledger].sort()
    );
    for (const id of [requests.crm, requests.ledger])
      expect((await decide(t.lena.id, id)).statusCode).toBe(200);
  });
});

describe("a held call on a Connection without connection.approve", () => {
  it("is decided by operations.approve as before, and by nobody else", async () => {
    const { t, decide, requests } = await heldOnTwo();
    expect((await t.call(t.lena.id, "approval_requests.list")).statusCode).toBe(403);
    expect((await decide(t.lena.id, requests.crm)).statusCode).toBe(404);
    // The administrator holds `operations.approve` on the instance.
    expect((await decide(t.admin.id, requests.crm)).statusCode).toBe(200);
    expect((await decide(t.admin.id, requests.ledger)).statusCode).toBe(200);
  });
});

describe("a held change of a Connection's configuration", () => {
  it("is decided by connection.approve on that Connection", async () => {
    const t = await fixture();
    const crm = await t.seed("crm", { origin: "runtime" });
    const ledger = await t.seed("ledger", { origin: "runtime" });
    for (const assetId of [crm, ledger]) await t.grant(t.kai.id, "connection.write", { assetId });
    await t.grant(t.lena.id, "connection.approve", { assetId: crm });
    t.state.centralSettings = [{ operation: "assets.put", value: "approval" }];
    const hold = async (name: string) => {
      const held = await t.call(t.kai.id, "assets.put", {
        params: { kind: "connection", name },
        payload: {
          config: connection(name, { connectorType: "test", origin: "runtime", enabled: false })
        }
      });
      expect(held.statusCode).toBe(202);
      return z.object({ approvalRequestId: z.string() }).parse(held.json()).approvalRequestId;
    };
    const onCrm = await hold("crm");
    const onLedger = await hold("ledger");
    const decide = (requestId: string) =>
      t.call(t.lena.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
    expect((await decide(onLedger)).statusCode).toBe(404);
    expect((await decide(onCrm)).statusCode).toBe(200);
  });
});
