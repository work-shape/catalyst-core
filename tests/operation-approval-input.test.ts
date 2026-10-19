import { describe, expect, it } from "vitest";
import { HELD_OPERATION_CALLS_PER_ACTOR } from "@work-shape/catalyst-server";
import { errorOf, fixture, HOUR_MS } from "./support/operation-approval";

// What a held call keeps of its input and how many calls may wait. Every test here fails
// without the change it names.

// What the approver is shown and what the request keeps. Before, the preview stopped at 50
// fields without a word, and the input stayed in the request for as long as the row did.
describe("the input of a held call", () => {
  it("counts every field and says how long a shortened value is", async () => {
    const f = await fixture();
    const long = "x".repeat(5_000);
    const { requestId } = await f.hold(long, "key-long");
    const detail = await f.app.call("approval_requests.get", {
      params: { requestId },
      headers: f.as("approver")
    });
    const body = detail.json();
    expect(body.preview.inputFieldCount).toBe(2);
    expect(body.preview.inputs).toEqual(
      expect.arrayContaining([
        { key: "name", value: "x".repeat(2_000), truncated: true, length: 5_000 },
        { key: "mode", value: "ok" }
      ])
    );
    // The request carries the whole input for the full view.
    expect(body.payload.input).toEqual({ name: long, mode: "ok" });
  });

  it("is removed when the call was executed, and the request keeps which call it was", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("secret-executed");
    expect((await f.stored(requestId)).payload.input).toEqual({
      name: "secret-executed",
      mode: "ok"
    });

    await f.approve("approver", requestId);

    const request = await f.stored(requestId);
    expect(JSON.stringify(request)).not.toContain("secret-executed");
    expect(request.payload).toEqual({
      runId,
      operation: "testRunChange",
      effect: "changing",
      actor: { id: await f.userId("Requester"), label: "Requester" },
      origin: { kind: "user" },
      expiresAt: expect.any(String),
      inputRemoved: true
    });
    const detail = await f.app.call("approval_requests.get", {
      params: { requestId },
      headers: f.as("approver")
    });
    expect(detail.json().preview).toMatchObject({ inputs: [], inputRemoved: true });
  });

  it("is removed when the call is rejected, withdrawn or expires", async () => {
    let now = new Date(Date.now() - 8 * 24 * HOUR_MS);
    const f = await fixture({ now: () => now });
    const expired = await f.hold("secret-expired", "key-expired");
    now = new Date();
    const rejected = await f.hold("secret-rejected", "key-rejected");
    const withdrawn = await f.hold("secret-withdrawn", "key-withdrawn");

    await f.decide("approver", rejected.requestId, "reject");
    await f.app.call("approval_requests.withdraw", {
      params: { requestId: withdrawn.requestId },
      headers: f.as("requester")
    });
    await f.runJobs();

    for (const [held, status] of [
      [rejected, "rejected"],
      [withdrawn, "withdrawn"],
      [expired, "superseded"]
    ] as const) {
      const request = await f.stored(held.requestId);
      expect(request.status).toBe(status);
      expect(request.payload).toMatchObject({ runId: held.runId, inputRemoved: true });
      expect(JSON.stringify(request)).not.toContain("secret-");
    }
  });

  it("is removed, and the call ended, when the account of the person who made it is deleted", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("secret-account");
    const deleted = await f.app.call("users.delete", {
      params: { userId: await f.userId("Requester") },
      headers: f.as("root")
    });
    expect(deleted.statusCode).toBeLessThan(300);

    await f.runJobs();

    const request = await f.stored(requestId);
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: {
        runId,
        execution: "refused",
        error: { message: "The account of the person who made this call was deleted." }
      },
      payload: { inputRemoved: true }
    });
    expect(JSON.stringify(request)).not.toContain("secret-account");
    expect((await f.run(runId)).status).toBe("denied");
    expect((await f.approve("approver", requestId)).statusCode).toBe(409);
    expect(f.executed).toEqual([]);
  });

  it.each(["expired", "failed"] as const)(
    "settles a request left pending after its run %s, then permits age pruning (LOWS-D)",
    async (status) => {
      const old = new Date(Date.now() - 400 * 24 * HOUR_MS);
      const f = await fixture({ now: () => old });
      const held = await f.hold("secret-cut-off");
      // Simulate a process cut off after the expiry statement but before request settlement.
      if (status === "expired") {
        expect(
          await f.app.stores.operationRuns.markExpired({
            clientInstanceId: f.clientInstanceId,
            limit: 10
          })
        ).toEqual(expect.arrayContaining([expect.objectContaining({ id: held.runId })]));
      } else {
        await f.app.stores.operationRuns.endWaiting({
          clientInstanceId: f.clientInstanceId,
          id: (await f.run(held.runId)).id,
          end: {
            status: "failed",
            finishedAt: old.toISOString(),
            error: { code: "interrupted", message: "Interrupted" }
          }
        });
      }
      expect((await f.stored(held.requestId)).status).toBe("pending");
      const orphan = await f.app.stores.approvals.createApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        kind: "operation_call",
        summary: "Old orphan",
        payload: { runId: "gone-before-0123" },
        requestedBy: { id: "gone", displayLabel: "Gone" }
      });
      await f.app.stores.approvals.transitionPendingApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId: orphan.id,
        resolve: async () => ({ status: "rejected" })
      });
      await f.runJobs();
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId: orphan.id
        })
      ).toBeUndefined();
      // The audit retention job repairs and prunes in one pass, regardless of schedule order.
      expect(
        await f.app.stores.operationRuns.get({
          clientInstanceId: f.clientInstanceId,
          id: held.runId
        })
      ).toBeUndefined();
      expect(
        await f.app.stores.approvals.getApprovalRequest({
          clientInstanceId: f.clientInstanceId,
          requestId: held.requestId
        })
      ).toBeUndefined();
      expect(f.executed).toEqual([]);
    }
  );

  it("is removed by the cleanup job from requests that ended before their input was removed", async () => {
    const f = await fixture();
    const ended = await f.hold("secret-old", "key-old");
    const open = await f.hold("secret-open", "key-open");
    const queued = await f.hold("secret-queued", "key-queued");
    // A request as a release before this one left it: ended, with its input.
    await f.app.stores.approvals.transitionPendingApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId: ended.requestId,
      resolve: () => Promise.resolve({ status: "superseded" })
    });
    expect((await f.stored(ended.requestId)).payload.input).toBeDefined();
    // Approved and not executed yet: its input is what the call will run with.
    await f.app.stores.approvals.transitionPendingApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId: queued.requestId,
      resolve: () => Promise.resolve({ status: "approved", applyResult: { execution: "queued" } })
    });

    await f.runJobs();

    expect((await f.stored(ended.requestId)).payload).toMatchObject({ inputRemoved: true });
    expect((await f.stored(ended.requestId)).payload.input).toBeUndefined();
    expect((await f.stored(open.requestId)).payload.input).toBeDefined();
    expect((await f.stored(queued.requestId)).payload.input).toBeDefined();
  });
});

// Counting and filing happen under one lock. Before, each call counted first and inserted
// afterwards, and calls made at the same moment all counted the same number.
describe("the limit of calls one person may have waiting", () => {
  it("holds exactly the limit when forty calls are made at the same moment", async () => {
    const f = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        f.call("requester", `burst-${index}`, `key-burst-${index}`)
      )
    );
    const codes = responses.map((response) => response.statusCode);
    expect(codes.filter((code) => code === 202)).toHaveLength(HELD_OPERATION_CALLS_PER_ACTOR);
    expect(codes.filter((code) => code === 429)).toHaveLength(40 - HELD_OPERATION_CALLS_PER_ACTOR);
    const refused = responses.find((response) => response.statusCode === 429);
    expect(refused ? errorOf(refused).message : "").toContain(
      `${HELD_OPERATION_CALLS_PER_ACTOR} of your calls already wait for an approval`
    );
    const pending = await f.app.stores.approvals.countPendingApprovalRequests({
      clientInstanceId: f.clientInstanceId,
      kinds: ["operation_call"]
    });
    expect(pending).toBe(HELD_OPERATION_CALLS_PER_ACTOR);
    // Another person is not held back by it.
    expect((await f.call("approver", "other", "key-other")).statusCode).toBe(202);
  }, 60_000);
});
