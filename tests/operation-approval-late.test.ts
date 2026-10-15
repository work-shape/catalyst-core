import { describe, expect, it } from "vitest";
import { AppError } from "@work-shape/catalyst-core";
import { approvalSetting, fixture } from "./support/operation-approval";
import { getTestJobs } from "./support/test-instance";

// What becomes of an approved or still open call when something ends around it: the process
// that would execute it is told to stop, or what the call belongs to is deleted while somebody
// decides on it.

const EXECUTE_JOB = "operation_call.execute";

describe("an approved call when its worker is told to stop", () => {
  // Fails before the fix: the run was marked as started before the call was asked again, and
  // the operation was called with a signal that was already aborted, so the tool ran after
  // the stop and its run was recorded as interrupted.
  it("is not dispatched after the stop and stays queued for the next worker", async () => {
    let stopWorker: (() => Promise<void>) | undefined;
    const f = await fixture({
      // The policy is read while the call is asked again, before it is dispatched.
      settings: async () => {
        const stop = stopWorker;
        stopWorker = undefined;
        await stop?.();
        return [approvalSetting];
      }
    });
    const jobs = getTestJobs(f.app);
    const { runId, requestId } = await f.hold("at-deploy");
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(200);
    let stopped: Promise<void> | undefined;
    stopWorker = async () => {
      stopped = jobs.stop();
      // A pass of a stopping worker ends after the stop reached every job it holds.
      await jobs.runDue();
    };

    await f.runJobs();
    await stopped;

    expect(stopped).toBeDefined();
    expect(f.executed).toEqual([]);
    // Not marked as started: the run still waits, with the call it will be executed from.
    const waiting = await f.run(runId);
    expect(waiting.status).toBe("pending_approval");
    expect(waiting.decision).toBeUndefined();
    const request = await f.stored(requestId);
    expect(request).toMatchObject({ status: "approved", applyResult: { execution: "queued" } });
    expect(request.payload.input).toMatchObject({ name: "at-deploy" });
    // The job was given back without a failed attempt: the next worker executes the call.
    const queued = await f.app.call("instance.jobs.list", {
      query: { status: "queued" },
      headers: f.as("root")
    });
    expect(
      queued
        .json<{ items: { kind: string; status: string; attempts: number }[] }>()
        .items.filter((job) => job.kind === EXECUTE_JOB)
    ).toMatchObject([{ status: "queued", attempts: 0 }]);
  });

  // The other half, which held before the fix too: only a call that was dispatched is
  // recorded as interrupted.
  it("is recorded as interrupted when the stop comes while the call runs", async () => {
    const f = await fixture();
    const jobs = getTestJobs(f.app);
    const { runId, requestId } = await f.hold("slow-deploy");
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(200);

    const running = f.runJobs();
    await expect.poll(() => f.executed, { timeout: 30_000 }).toEqual(["requester:slow-deploy"]);
    await jobs.stop();
    await running;

    // The implementation was told to stop through its signal, and the call ran once.
    expect(f.stopped).toEqual(["slow-deploy"]);
    expect(await f.run(runId)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(await f.stored(requestId)).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "interrupted" }
    });
  });
});

describe("a held call whose deletion met a decision that failed", () => {
  // Fails before the fix: the deletion skipped the request somebody was deciding and never
  // came back, and the cleanup job left every open request alone, so the request stayed open
  // with its input for good.
  it("is ended and loses its input in the cleanup job once the account is gone", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("secret-locked");
    // A decision that holds the request and fails in the end, as one whose commit fails.
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail: () => void = () => undefined;
    const failing = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const decision = f.app.stores.approvals
      .transitionPendingApprovalRequest({
        clientInstanceId: f.clientInstanceId,
        requestId,
        resolve: async () => {
          entered();
          await failing;
          throw new AppError("INTERNAL", "The decision could not be recorded");
        }
      })
      .catch(() => undefined);
    await holding;
    const deleted = await f.app.call("users.delete", {
      params: { userId: await f.userId("Requester") },
      headers: f.as("root")
    });
    expect(deleted.statusCode).toBeLessThan(300);
    fail();
    await decision;
    // The deletion could not end it: it is open, with what the person entered.
    expect(await f.stored(requestId)).toMatchObject({ status: "pending" });
    expect((await f.stored(requestId)).payload.input).toBeDefined();

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
    expect(JSON.stringify(request)).not.toContain("secret-locked");
    expect((await f.run(runId)).status).toBe("denied");
    expect(f.executed).toEqual([]);
  });
});
