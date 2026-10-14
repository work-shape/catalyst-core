import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, type UserRecord } from "@vivd-catalyst/core";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import {
  NOTE,
  failingFor,
  holdingFirst,
  notifyClients,
  reach,
  readyWorkflows,
  start,
  stepRunsOf
} from "./support/workflow-runs";

// Verification of EW-5t (PR 60), written by the verifier and not by the builder: what "Run live
// once" must not do. A switch covers its step for the whole next test run, every item of a
// loop included, and does not carry to a published run, to another tester or past that run.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const writeSchema = z.object({ revision: z.number() });

describe("Run live once in a test run (EW-5t verification)", () => {
  let open: WorkflowFixture | undefined;
  const hanging: (() => void)[] = [];
  afterEach(async () => {
    for (const letGo of hanging.splice(0)) letGo();
    await open?.instance.close();
    open = undefined;
  });

  async function ready(manifest: unknown = notifyClients()) {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    for (const tester of [t.kai, t.lena]) {
      await t.allow({ kind: "user", id: tester.id }, "connection.use");
      await t.allow({ kind: "user", id: tester.id }, "workflow.write");
    }
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest }, expectedRevision: null }
    });
    writeSchema.parse(response.json());
    return t;
  }

  async function startTest(t: WorkflowFixture, tester: UserRecord) {
    const response = await t.expectOk(tester.id, "workflows.test", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });
    return runSchema.parse(response.json());
  }

  const switchOn = (t: WorkflowFixture, tester: UserRecord = t.kai) =>
    t.expectOk(tester.id, "assets.run_live_once", {
      params: address,
      payload: { part: "send", expectedRevision: 1 }
    });

  const sendTargets = async (t: WorkflowFixture, runId: string) =>
    (await stepRunsOf(t, runId))
      .filter((step) => step.stepId === "send")
      .map((step) => step.target);

  const writes = (t: WorkflowFixture) => t.executed.filter((call) => call.operation === "write");

  // Defect: the switch is noted on the run only after the first item's call returned, so the
  // items of a loop that run at once beside it find neither the switch nor the note.
  it("covers every item of a loop that runs its items at once", async () => {
    const t = await ready(notifyClients({ concurrency: 3 }));
    await switchOn(t);
    const { inCall, letGo } = holdingFirst(t, "write", hanging);

    const run = await startTest(t, t.kai);
    await reach(t, inCall);
    // The other items run while the first item's live call is with the outside system.
    const other = t.worker();
    for (let pass = 0; pass < 10; pass++) await other.runDue();
    letGo();
    const ended = await t.finish(run.id);

    expect(ended.status).toBe("done");
    expect(await sendTargets(t, run.id)).toEqual(["live", "live", "live"]);
    expect(writes(t)).toHaveLength(3);
  });

  // Follow-up for a decision: the switch is held per step and not per person, so a switch one
  // builder set is used by the next test run of anybody who may write the Workflow.
  // Defect, same cause: the switch is noted on the run only after a call that succeeded, so a
  // first item whose live call failed leaves the next items of the loop simulated.
  it("covers the next items of a loop after the first item's live call failed", async () => {
    const t = await ready(notifyClients({ onItemFailure: "continue" }));
    await switchOn(t);
    t.setBehaviour(failingFor(["client-anna"]));

    const run = await startTest(t, t.kai);
    await t.finish(run.id);

    expect(await sendTargets(t, run.id)).toEqual(["live", "live", "live"]);
  });

  it("does not let another tester's test run use a builder's switch", async () => {
    const t = await ready();
    await switchOn(t, t.kai);

    const lenas = await startTest(t, t.lena);
    await t.finish(lenas.id);

    expect(await sendTargets(t, lenas.id)).toEqual(["dry_run", "dry_run", "dry_run"]);
    expect(writes(t)).toEqual([]);
  });

  it("is neither used nor used up by a run of the published revision", async () => {
    const t = await ready();
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: 1 }
    });
    await t.allow({ kind: "user", id: t.root.id }, "workflow.use");
    await switchOn(t);

    const published = await start(t);
    await t.finish(published.id);
    expect(await sendTargets(t, published.id)).toEqual(["live", "live", "live"]);
    t.executed.length = 0;

    // The switch is still there for the next test run.
    const test = await startTest(t, t.kai);
    await t.finish(test.id);
    expect(await sendTargets(t, test.id)).toEqual(["live", "live", "live"]);
  });

  it("goes live in only one of two test runs started at once", async () => {
    const t = await ready();
    await switchOn(t);

    const [first, second] = await Promise.all([startTest(t, t.kai), startTest(t, t.kai)]);
    await Promise.all([t.finish(first.id, t.worker()), t.finish(second.id, t.worker())]);

    const targets = [await sendTargets(t, first.id), await sendTargets(t, second.id)];
    expect(targets.map((run) => run.join(",")).sort()).toEqual([
      "dry_run,dry_run,dry_run",
      "live,live,live"
    ]);
    expect(writes(t)).toHaveLength(3);
  });

  // Turn 2. A switch set again while a test run that used it goes on is for the next test run,
  // and the run that bound the first switch keeps every item of the step live.
  it("leaves a switch set again during a test run for the next test run", async () => {
    const t = await ready();
    await switchOn(t);
    const { inCall, letGo } = holdingFirst(t, "write", hanging);

    const first = await startTest(t, t.kai);
    await reach(t, inCall);
    // The first item of the first run is live with the outside system; Kai sets the switch again.
    await switchOn(t);
    letGo();
    await t.finish(first.id);
    expect(await sendTargets(t, first.id)).toEqual(["live", "live", "live"]);

    const second = await startTest(t, t.kai);
    await t.finish(second.id, t.worker());
    expect(await sendTargets(t, second.id)).toEqual(["live", "live", "live"]);
  });

  it("keeps every item of a running test run live when a switch set again is used by another run", async () => {
    const t = await ready();
    await switchOn(t);
    const { inCall, letGo } = holdingFirst(t, "write", hanging);

    const first = await startTest(t, t.kai);
    await reach(t, inCall);
    await switchOn(t);
    const second = await startTest(t, t.kai);
    await t.finish(second.id, t.worker());
    letGo();
    await t.finish(first.id);

    expect(await sendTargets(t, second.id)).toEqual(["live", "live", "live"]);
    expect(await sendTargets(t, first.id)).toEqual(["live", "live", "live"]);
  });

  // Turn 2: "a switch not yet used is cleared by the next save of the draft" (check 7), and
  // clearing is an audit event (operations-and-policy, Calls made by a draft).
  it("clears an unused switch with its audit event when the draft is saved", async () => {
    const t = await ready();
    await switchOn(t);
    await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: notifyClients() }, expectedRevision: 1 }
    });

    const audit = await t.stores.audit.listAuditEvents({
      clientInstanceId: t.principal.clientInstanceId,
      limit: 200
    });
    expect(
      audit
        .filter((event) => event.type === "live_once.cleared")
        .map((event) => [event.metadata?.part, event.actor?.userId])
    ).toEqual([["send", t.admin.id]]);
  });
});

describe("rights of a test run (EW-5t verification)", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: notifyClients() }, expectedRevision: null }
    });
    return t;
  }

  const startTest = async (t: WorkflowFixture, tester: UserRecord) =>
    runSchema.parse(
      (
        await t.expectOk(tester.id, "workflows.test", {
          params: { workflow: WORKFLOW },
          payload: { input: { note: NOTE } }
        })
      ).json()
    );

  it("names the tester where neither the tester nor the principal holds the right", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.write");
    const clientInstanceId = t.principal.clientInstanceId;
    const grants = await t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "connection.use"
    });
    for (const grant of grants) {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }

    const run = await startTest(t, t.lena);
    const ended = await t.finish(run.id);
    expect(ended.status).toBe("failed");
    const clients = (await stepRunsOf(t, run.id)).find((step) => step.stepId === "clients");
    expect(clients).toMatchObject({ status: "failed", error: { code: "tester_missing_right" } });
    expect(t.executed).toEqual([]);
  });

  it("stops with run_as_disabled when the principal is disabled after the start", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    const run = await startTest(t, t.kai);
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId: t.principal.clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });

    const ended = await t.finish(run.id);
    expect(ended).toMatchObject({ status: "failed", error: { code: "run_as_disabled" } });
    expect(t.executed).toEqual([]);
  });
});
