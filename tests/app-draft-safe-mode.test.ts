import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appActionSchema, appActionsSchema } from "@work-shape/catalyst-api-contract";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import {
  appSource,
  resultSchema,
  setupAppActions,
  type AppActionsInstance,
  type Frame
} from "./support/app-actions";

// The draft of an App in safe mode (ADR-0031, APP-4), on the real call path and Postgres:
// acceptance checks 7 and 8 of apps-and-pages. A changing action called from a draft answers
// what it would have done and leaves a run with the target `dry_run`; "Run live once" carries
// out the switcher's own next call, through central policy, and is used up by it. The App
// `orders` has a published revision 1 and a draft; its action `save` calls `crm.write`. `kai`
// is a member of the App's workspace; here he also writes the App and uses `crm`, and does
// not publish.

describe("the draft of an App in safe mode", () => {
  let t: AppActionsInstance;
  /** The draft revision the Actions list shows, which a switch names. */
  let draftRevision: number;

  beforeAll(async () => {
    t = await setupAppActions();
    for (const right of ["app.read", "app.write"]) await inWorkspace(t.kai.id, right);
    await t.grant(t.kai.id, "connection.use", { assetId: t.crm });
  });
  afterAll(() => t.closeAll());
  beforeEach(async () => {
    t.state.centralSettings = [];
    const listed = await t.listed("orders");
    draftRevision = listed.draftRevision ?? listed.revision;
  });

  /** A right of the kind in the App's workspace, as a role there carries it. */
  const inWorkspace = (userId: string, action: string) =>
    t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: userId,
      action,
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
  const save = (userId: string, frame: Frame, note: string) =>
    t.callAction(userId, frame, "save", { note }, { "idempotency-key": crypto.randomUUID() });
  const switchOn = (userId: string, revision = draftRevision) =>
    t.call(userId, "assets.run_live_once", {
      params: { kind: "app", name: "orders" },
      payload: { part: "save", expectedRevision: revision, workspaceId: t.workspaceId }
    });
  /** The audit rows of "Run live once" since `since`, oldest first, as type and actor. */
  const switchRows = async (since: number) => {
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    return events
      .filter((event) => event.type.startsWith("live_once."))
      .reverse()
      .slice(since)
      .map((event) => ({ type: event.type, part: event.metadata?.part }));
  };
  /** The `live_once.cleared` rows since `since`, as who wrote them and whose switch it was. */
  const clearedRows = async (since: number) => {
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    return events
      .filter((event) => event.type.startsWith("live_once."))
      .reverse()
      .slice(since)
      .filter((event) => event.type === "live_once.cleared")
      .map((event) => ({
        actor: event.actor?.userId,
        switchedBy: event.metadata?.switchedBy,
        part: event.metadata?.part
      }));
  };
  const switchRowCount = async () => (await switchRows(0)).length;
  const listedTarget = async (userId: string) => {
    const response = await t.call(userId, "apps.actions.list", { query: { app: "orders" } });
    expectStatus(response, 200);
    const actions = appActionsSchema.parse(response.json()).apps[0]?.actions ?? [];
    return Object.fromEntries(
      actions.map((entry) => [entry.name, appActionSchema.parse(entry).target])
    );
  };

  // Acceptance check 7.
  it("answers a changing action of a draft with what it would have done, changes nothing and records dry_run", async () => {
    const frame = await t.openApp(t.admin.id, "draft");
    const before = t.handed.length;

    const response = await save(t.admin.id, frame, "draft note");

    expectStatus(response, 200);
    expect(response.json()).toEqual({
      status: "dry_run",
      message: expect.stringMatching(
        /^Would have called the action 'save' with \{"note":"draft note"\}\. The draft of an App runs in safe mode/u
      ),
      result: { note: "draft note" }
    });
    expect(t.handed.length).toBe(before);
    expect(await t.runOf(response.headers["operation-run-id"])).toMatchObject({
      operation: "app.orders.save",
      effect: "changing",
      target: "dry_run",
      status: "done",
      actor: { kind: "user", id: t.admin.id }
    });
    // The frame is told the policy's word, not a refusal: the call can be tried.
    expect(await t.can(t.admin.id, frame)).toMatchObject({ save: "confirm", load: "allow" });
    // A reading action of the draft reads live.
    const read = await t.callAction(t.admin.id, frame, "load", { text: "live read" });
    expectStatus(read, 200);
    expect(await t.runOf(resultSchema.parse(read.json()).runId)).toMatchObject({ target: "live" });
  });

  it("says in a simulated call where the live call would wait for an approval", async () => {
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "approval" }];
    const frame = await t.openApp(t.admin.id, "draft");

    const response = await save(t.admin.id, frame, "held");

    expectStatus(response, 200);
    expect(response.json()).toMatchObject({
      status: "dry_run",
      message: expect.stringContaining("Live, the call would wait for another person's approval.")
    });
    expect(await t.runOf(response.headers["operation-run-id"])).toMatchObject({
      target: "dry_run"
    });
  });

  // Acceptance check 8.
  it("runs the switcher's next call live under confirm, then simulates again, and audits both", async () => {
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "confirm" }];
    const frame = await t.openApp(t.kai.id, "draft");
    const rows = await switchRowCount();
    expect((await listedTarget(t.kai.id)).save).toBe("dry_run");

    expectStatus(await switchOn(t.kai.id), 200);
    expect(await listedTarget(t.kai.id)).toMatchObject({ save: "live", load: "live" });
    const before = t.handed.length;
    // A direct call of a person counts as the confirmation.
    const live = await save(t.kai.id, frame, "carried out");
    const again = await save(t.kai.id, frame, "simulated again");

    expectStatus(live, 200);
    const answer = resultSchema.parse(live.json());
    expect(answer).toMatchObject({ status: "done", result: { note: "carried out" } });
    expect(await t.runOf(answer.runId)).toMatchObject({
      target: "live",
      status: "done",
      actor: { kind: "user", id: t.kai.id }
    });
    expect(t.handed.length - before).toBe(1);
    expectStatus(again, 200);
    expect(again.json()).toMatchObject({ status: "dry_run" });
    expect(await t.runOf(again.headers["operation-run-id"])).toMatchObject({
      target: "dry_run"
    });
    expect(await switchRows(rows)).toEqual([
      { type: "live_once.switched_on", part: "save" },
      { type: "live_once.used", part: "save" }
    ]);
    expect((await listedTarget(t.kai.id)).save).toBe("dry_run");
  });

  it("keeps another member's call simulated while the switch waits for its owner", async () => {
    const kaiFrame = await t.openApp(t.kai.id, "draft");
    const adminFrame = await t.openApp(t.admin.id, "draft");
    expectStatus(await switchOn(t.kai.id), 200);
    const before = t.handed.length;

    const other = await save(t.admin.id, adminFrame, "not mine");
    expect(other.json()).toMatchObject({ status: "dry_run" });
    expect(t.handed.length).toBe(before);
    // The list says so to each: live for the switcher, simulated for the other.
    expect((await listedTarget(t.admin.id)).save).toBe("dry_run");
    expect((await listedTarget(t.kai.id)).save).toBe("live");

    const own = await save(t.kai.id, kaiFrame, "mine");
    expect(resultSchema.parse(own.json()).status).toBe("done");
    expect(t.handed.length - before).toBe(1);
  });

  it("keeps each member's switch on the same action: another's switch replaces none and uses none", async () => {
    const kaiFrame = await t.openApp(t.kai.id, "draft");
    const adminFrame = await t.openApp(t.admin.id, "draft");
    const rows = await switchRowCount();
    expectStatus(await switchOn(t.kai.id), 200);
    expectStatus(await switchOn(t.admin.id), 200);
    expect((await listedTarget(t.kai.id)).save).toBe("live");
    expect((await listedTarget(t.admin.id)).save).toBe("live");
    const before = t.handed.length;

    const own = await save(t.kai.id, kaiFrame, "mine");
    expect(resultSchema.parse(own.json()).status).toBe("done");
    // Kai's call used Kai's switch; the admin's waits for the admin.
    expect((await listedTarget(t.admin.id)).save).toBe("live");
    const theirs = await save(t.admin.id, adminFrame, "theirs");
    expect(resultSchema.parse(theirs.json()).status).toBe("done");
    expect(t.handed.length - before).toBe(2);
    expect(await switchRows(rows)).toEqual([
      { type: "live_once.switched_on", part: "save" },
      { type: "live_once.switched_on", part: "save" },
      { type: "live_once.used", part: "save" },
      { type: "live_once.used", part: "save" }
    ]);
  });

  it("clears an unused switch with the next save of the draft, and audits the clearing then, in the saver's name", async () => {
    expectStatus(await switchOn(t.kai.id), 200);
    const rows = await switchRowCount();
    expectStatus(await t.putApp(t.admin.id, "orders", appSource("saved again")), 200);
    // The save clears it: the row is written by the save, names its author and whose it was.
    expect(await clearedRows(rows)).toEqual([
      { actor: t.admin.id, switchedBy: t.kai.id, part: "save" }
    ]);
    const frame = await t.openApp(t.kai.id, "draft");
    const before = t.handed.length;

    const response = await save(t.kai.id, frame, "after the save");

    expect(response.json()).toMatchObject({ status: "dry_run" });
    expect(t.handed.length).toBe(before);
    // The call finds nothing left to clear.
    expect(await switchRows(rows)).toEqual([{ type: "live_once.cleared", part: "save" }]);
    // A switch for a revision that is not the draft any more is refused.
    const stale = await switchOn(t.kai.id, draftRevision);
    expect(stale.statusCode).toBe(412);
    expect(t.refusal(stale).code).toBe("REVISION_CONFLICT");
  });

  it("clears an unused switch when the draft is discarded, in the name of who discarded it", async () => {
    expectStatus(await switchOn(t.kai.id), 200);
    const rows = await switchRowCount();
    expectStatus(
      await t.call(t.admin.id, "assets.discard_draft", {
        params: { kind: "app", name: "orders" },
        payload: { expectedRevision: draftRevision, workspaceId: t.workspaceId }
      }),
      200
    );

    expect(await clearedRows(rows)).toEqual([
      { actor: t.admin.id, switchedBy: t.kai.id, part: "save" }
    ]);
    const frame = await t.openApp(t.kai.id, "draft");
    expect((await save(t.kai.id, frame, "after the discard")).json()).toMatchObject({
      status: "dry_run"
    });
    // The draft is written again for the tests after this one.
    expectStatus(await t.putApp(t.admin.id, "orders", appSource("draft")), 200);
  });

  it("refuses the switch to a member who does not write the App", async () => {
    const lisa = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Lisa",
      roles: ["user"],
      permissions: []
    });
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: t.workspaceId,
      userId: lisa.id,
      role: "member"
    });
    await inWorkspace(lisa.id, "app.read");
    const rows = await switchRowCount();

    const refused = await switchOn(lisa.id);

    expect([403, 404]).toContain(refused.statusCode);
    expect(await switchRowCount()).toBe(rows);
    expect((await listedTarget(lisa.id)).save).toBeUndefined();
  });

  it("refuses a live call from a draft where the policy asks for an approval: a draft cannot wait", async () => {
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "approval" }];
    const frame = await t.openApp(t.kai.id, "draft");
    expectStatus(await switchOn(t.kai.id), 200);
    const before = t.handed.length;

    const response = await save(t.kai.id, frame, "needs an approval");

    expect(response.statusCode).toBe(403);
    expect(t.refusal(response)).toMatchObject({
      code: "POLICY_DENIED",
      details: { reason: "approval_unavailable" }
    });
    expect(t.handed.length).toBe(before);
  });
});
