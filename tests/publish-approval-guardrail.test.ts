import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PUBLISH_APPROVAL_GUARDRAIL, WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs } from "./support/test-instance";
import type { WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";

// GR-PUB-1: the guardrail the release ships, "Publishing needs an instance admin's approval".
// A member who may publish an App and may not approve it waits for an admin; an admin's own
// Publish is the approval; an admin can switch the guardrail off, and the switch is audited.

/** The run of a held call, as its 202 answers it. */
const heldSchema = z
  .object({ id: z.string(), status: z.literal("pending_approval"), approvalRequestId: z.string() })
  .transform(({ id, approvalRequestId }) => ({ runId: id, approvalRequestId }));
const shippedSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      enabled: z.boolean(),
      switchedBy: z.object({ id: z.string(), label: z.string() }).optional(),
      canSwitch: z.boolean()
    })
  )
});
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  canDecide: z.boolean(),
  preview: z.looseObject({ review: z.looseObject({}).optional() }),
  applyResult: z.looseObject({}).optional()
});

describe("publishing needs an instance admin's approval", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
      })
    });
    // Kai may write and publish the workspace's Apps, and may not approve a publish. No
    // operation grants App rights yet (RIGHTS-1c), so the rows are written as a role would.
    for (const action of ["app.read", "app.write", "app.publish"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        grantedBy: t.admin.id
      });
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const created = async (name: string) => {
    expectStatus(await t.putApp(t.admin.id, name, appFiles(`${name} 1`, { id: name })), 200);
  };
  const request = async (userId: string, requestId: string) =>
    requestSchema.parse(
      (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json()
    );
  const decide = (userId: string, requestId: string, decision: "approve" | "reject") =>
    t.call(userId, "approval_requests.decide", {
      params: { requestId },
      payload: { decision }
    });
  const switchTo = (userId: string, enabled: boolean) =>
    t.call(userId, "guardrails.switch_shipped", {
      params: { name: PUBLISH_APPROVAL_GUARDRAIL.name },
      payload: { enabled }
    });

  it("holds a member's publish as an app_publish request the admin decides, and the member does not", async () => {
    await created("offers");

    const response = await t.publish(t.kai.id, "offers", 1);

    expectStatus(response, 202);
    const held = heldSchema.parse(response.json());
    expect((await stored("offers"))?.publishedRevision).toBeUndefined();
    const filed = await request(t.admin.id, held.approvalRequestId);
    expect(filed).toMatchObject({ kind: "app_publish", status: "pending", canDecide: true });
    expect(filed.preview.review).toMatchObject({
      kind: "app",
      name: "offers",
      revision: 1,
      liveRevision: null,
      files: [
        { path: "app.yaml", change: "added" },
        { path: "index.html", change: "added" }
      ]
    });
    // The member reads their own request and cannot decide it.
    expect(await request(t.kai.id, held.approvalRequestId)).toMatchObject({ canDecide: false });
    expectStatus(await decide(t.kai.id, held.approvalRequestId, "approve"), 403);
    const hits = await t.stores.guardrails.listHits({
      clientInstanceId,
      guardrailName: PUBLISH_APPROVAL_GUARDRAIL.name,
      limit: 10
    });
    expect(hits).toContainEqual(
      expect.objectContaining({ outcome: "require_approval", subjectName: "offers" })
    );
  });

  it("publishes exactly the held revision once an admin approves, as the member with the admin as approver", async () => {
    await created("rates");
    const held = heldSchema.parse((await t.publish(t.kai.id, "rates", 1)).json());

    expectStatus(await decide(t.admin.id, held.approvalRequestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();

    expect((await stored("rates"))?.publishedRevision).toBe(1);
    const run = await t.stores.operationRuns.get({ clientInstanceId, id: held.runId });
    expect(run).toMatchObject({
      status: "done",
      actor: { id: t.kai.id },
      decision: { mode: "approved", by: t.admin.id }
    });
  });

  it("makes an admin's own publish live at once, recorded as publisher and approver, with no request", async () => {
    await created("catalog");
    const before = await t.stores.approvals.countApprovalRequests({
      clientInstanceId,
      kinds: ["app_publish"]
    });

    const response = await t.publish(t.admin.id, "catalog", 1);

    expectStatus(response, 200);
    expect((await stored("catalog"))?.publishedRevision).toBe(1);
    const runId = response.headers["operation-run-id"];
    const run = await t.stores.operationRuns.get({ clientInstanceId, id: String(runId) });
    expect(run).toMatchObject({
      actor: { id: t.admin.id },
      decision: { mode: "approved", reason: "approved_by_caller", by: t.admin.id }
    });
    expect(
      await t.stores.approvals.countApprovalRequests({ clientInstanceId, kinds: ["app_publish"] })
    ).toBe(before);
  });

  it("refuses to approve a request whose draft moved, and lets a newer request replace the open one", async () => {
    await created("menu");
    const first = heldSchema.parse((await t.publish(t.kai.id, "menu", 1)).json());
    const second = heldSchema.parse((await t.publish(t.kai.id, "menu", 1)).json());
    expect((await request(t.admin.id, first.approvalRequestId)).status).toBe("superseded");

    expectStatus(await t.putApp(t.kai.id, "menu", appFiles("menu 2", { id: "menu" })), 200);
    expect((await request(t.admin.id, second.approvalRequestId)).preview.review).toMatchObject({
      stale: expect.stringContaining("draft")
    });
    expectStatus(await decide(t.admin.id, second.approvalRequestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();

    expect(await request(t.admin.id, second.approvalRequestId)).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused" }
    });
    expect((await stored("menu"))?.publishedRevision).toBeUndefined();
    const run = await t.stores.operationRuns.get({ clientInstanceId, id: second.runId });
    expect(run).toMatchObject({ status: "denied" });
  });

  it("is switched off only by a holder of guardrail.publish, audited, and then a member's click publishes", async () => {
    const listed = shippedSchema.parse(
      (await t.expectOk(t.admin.id, "guardrails.list_shipped")).json()
    );
    // On as the release ships it, on an instance where nobody switched it.
    expect(listed.items).toEqual([
      { name: PUBLISH_APPROVAL_GUARDRAIL.name, enabled: true, canSwitch: true }
    ]);
    const refused = await switchTo(t.kai.id, false);
    expectStatus(refused, 403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: "guardrail.publish"
    });

    expectStatus(await switchTo(t.admin.id, false), 200);

    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "guardrail.shipped_switched",
        actor: expect.objectContaining({ userId: t.admin.id }),
        metadata: expect.objectContaining({ name: PUBLISH_APPROVAL_GUARDRAIL.name, enabled: false })
      })
    );
    expect(
      shippedSchema.parse((await t.expectOk(t.admin.id, "guardrails.list_shipped")).json()).items
    ).toEqual([
      {
        name: PUBLISH_APPROVAL_GUARDRAIL.name,
        enabled: false,
        switchedBy: { id: t.admin.id, label: t.admin.displayLabel },
        canSwitch: true
      }
    ]);
    await created("specials");
    expectStatus(await t.publish(t.kai.id, "specials", 1), 200);
    expect((await stored("specials"))?.publishedRevision).toBe(1);

    expectStatus(await switchTo(t.admin.id, true), 200);
    await created("archive");
    expectStatus(await t.publish(t.kai.id, "archive", 1), 202);
  });
});

describe("publishing a Workflow under the shipped guardrail", () => {
  let open: WorkflowFixture | undefined;
  afterAll(async () => {
    await open?.instance.close();
  });

  it("makes an approver's own publish live, through the guardrail and the kind's approve right", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      {
        definitions: "assets",
        events: (stores) => guardedEvents(stores, {}, { shipped: true }).events
      }
    );
    const put = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "notify-clients" },
      payload: {
        config: { name: "notify-clients", manifest: notifyClients() },
        expectedRevision: null
      }
    });
    const { revision } = z.object({ revision: z.number() }).parse(put.json());

    const published = await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "notify-clients" },
      payload: { revision }
    });

    const run = await t.stores.operationRuns.get({
      clientInstanceId,
      id: String(published.headers["operation-run-id"])
    });
    expect(run).toMatchObject({
      decision: { mode: "approved", reason: "approved_by_caller", by: t.root.id }
    });
    const hits = await t.stores.guardrails.listHits({
      clientInstanceId,
      guardrailName: PUBLISH_APPROVAL_GUARDRAIL.name,
      limit: 10
    });
    expect(hits).toContainEqual(
      expect.objectContaining({ event: "workflow.before_publish", subjectName: "notify-clients" })
    );
  });
});
