import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  PUBLISH_APPROVAL_GUARDRAIL,
  WORKFLOW_ASSET_KIND,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs, getTestOperationCalls } from "./support/test-instance";
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

  const publishAsAdmin = async (name: string, origin: OperationOrigin) => {
    const calls = await getTestOperationCalls(t.instance);
    return runOperation(
      {
        operation: "assets.publish",
        effect: "changing",
        input: { kind: "app", name, revision: 1, workspaceId: t.workspaceId },
        actor: { ...t.admin, externalUserId: t.admin.id, authSource: "test", scopes: ["*"] },
        origin,
        workspaceId: t.workspaceId,
        correlationId: `corr_${name}`
      },
      calls.deps
    );
  };

  it("holds a workspace approver's own publish for an instance approver", async () => {
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.approve",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
    try {
      await created("workspace-approver");
      const response = await t.publish(t.kai.id, "workspace-approver", 1);
      expectStatus(response, 202);
      const held = heldSchema.parse(response.json());
      expect((await stored("workspace-approver"))?.publishedRevision).toBeUndefined();
      expect(await request(t.kai.id, held.approvalRequestId)).toMatchObject({ canDecide: false });
      expectStatus(await decide(t.kai.id, held.approvalRequestId, "approve"), 403);
      expect(await request(t.admin.id, held.approvalRequestId)).toMatchObject({ canDecide: true });
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
  });

  it("never treats a CLI origin as self-approval, even for an instance approver", async () => {
    await created("cli-approver");
    const result = await publishAsAdmin("cli-approver", { kind: "cli" });
    expect(result.result.status).toBe("pending_approval");
    expect((await stored("cli-approver"))?.publishedRevision).toBeUndefined();
  });

  it("refuses an instance approver's MCP publish with the reason", async () => {
    await created("mcp-refused");
    const result = await publishAsAdmin("mcp-refused", { kind: "mcp", clientName: "test" });
    expect(result.result).toMatchObject({ status: "denied" });
    expect(result.run.error?.message).toContain("person's click");
    expect((await stored("mcp-refused"))?.publishedRevision).toBeUndefined();
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

  it("PUBQ-1: a held publish's Inbox item leads with the same sentence as the Publish dialog, in the approver's language", async () => {
    await created("narrated");
    const held = heldSchema.parse((await t.publish(t.kai.id, "narrated", 1)).json());
    const narrativeSchema = z.object({ summary: z.string().min(1), warnings: z.array(z.string()) });
    const reviewed = async () =>
      narrativeSchema.parse(
        z
          .object({ review: z.object({ publishNarrative: z.unknown() }) })
          .parse((await request(t.admin.id, held.approvalRequestId)).preview).review
          .publishNarrative
      );
    const asked = async () =>
      narrativeSchema.parse(
        z.object({ publishNarrative: z.unknown() }).parse(
          (
            await t.expectOk(t.admin.id, "assets.get", {
              params: { kind: "app", name: "narrated" },
              query: { workspaceId: t.workspaceId, revision: "1", audience: "workspace" }
            })
          ).json()
        ).publishNarrative
      );
    const english = await reviewed();
    expect(english.summary).toMatch(/^Offers opens for /u);
    expect(english).toEqual(await asked());
    await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, locale: "de" });
    try {
      const german = await reviewed();
      expect(german.summary).toMatch(/^Offers öffnet sich für /u);
      expect(german).toEqual(await asked());
    } finally {
      await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, locale: null });
    }
  });

  it.each(["en", "de"] as const)(
    "keeps the draft, Details and Inbox approval available after narration fails in %s",
    async (locale) => {
      const name = `summary-failure-${locale}`;
      await created(name);
      const held = heldSchema.parse((await t.publish(t.kai.id, name, 1)).json());
      const calls = await getTestOperationCalls(t.instance);
      const narrator = calls.publishNarrator;
      if (!narrator) throw new Error("The assembled test instance needs a publish narrator");
      const failed = vi
        .spyOn(narrator, "narrate")
        .mockRejectedValue(new Error("private Connection error"));
      await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, locale });
      try {
        const draft = (
          await t.expectOk(t.admin.id, "assets.get", {
            params: { kind: "app", name },
            query: { workspaceId: t.workspaceId, revision: "1" }
          })
        ).json();
        const review = (await request(t.admin.id, held.approvalRequestId)).preview.review;
        const summary =
          locale === "de"
            ? "Die Zusammenfassung konnte nicht erstellt werden. Die Details sind weiterhin verfügbar."
            : "The summary could not be prepared. Details are still available.";
        expect(draft.publishNarrative).toEqual({ summary, warnings: [] });
        expect(draft.allowed).toContain("publish");
        expect(review).toMatchObject({
          publishNarrative: { summary, warnings: [] },
          files: [
            { path: "app.yaml", change: "added" },
            { path: "index.html", change: "added" }
          ]
        });
        expect(JSON.stringify(review)).not.toContain("private Connection error");
        expectStatus(await decide(t.admin.id, held.approvalRequestId, "approve"), 200);
        await getTestJobs(t.instance).runDue();
        expect((await stored(name))?.publishedRevision).toBe(1);
      } finally {
        failed.mockRestore();
        await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, locale: null });
      }
    }
  );

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
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "operation.completed",
        actor: expect.objectContaining({ userId: t.admin.id }),
        metadata: expect.objectContaining({
          operationRunId: runId,
          decisionReason: "approved_by_caller"
        })
      })
    );
  });

  it("refuses to approve a request whose draft moved, and lets a newer request replace the open one", async () => {
    await created("menu");
    const first = heldSchema.parse((await t.publish(t.kai.id, "menu", 1)).json());
    const second = heldSchema.parse((await t.publish(t.kai.id, "menu", 1)).json());
    expect((await request(t.admin.id, first.approvalRequestId)).status).toBe("superseded");

    expectStatus(await t.putApp(t.kai.id, "menu", appFiles("menu 2", { id: "menu" })), 200);
    expect((await request(t.admin.id, second.approvalRequestId)).preview.review).toMatchObject({
      stale: "draft_moved"
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
    try {
      const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
      expect(audit).toContainEqual(
        expect.objectContaining({
          type: "guardrail.shipped_switched",
          actor: expect.objectContaining({ userId: t.admin.id }),
          metadata: expect.objectContaining({
            name: PUBLISH_APPROVAL_GUARDRAIL.name,
            enabled: false
          })
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
    } finally {
      // The switch is the instance's: every fixture of this file reads it. Nothing here
      // throws, so a failure above stays the one reported; the publish below proves it on.
      await switchTo(t.admin.id, true);
    }
    await created("archive");
    expectStatus(await t.publish(t.kai.id, "archive", 1), 202);
  });
});

describe("publishing a Workflow under the shipped guardrail", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** An instance whose call path runs the shipped guardrails, with no Workflow yet. */
  const guarded = () =>
    readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      {
        definitions: "assets",
        events: (stores) => guardedEvents(stores, {}, { shipped: true }).events
      }
    );
  /**
   * The root's own publish of a new Workflow, live on its click. Both tests share the file's
   * database, so each names its own. Answers the response.
   */
  const rootPublishes = async (t: WorkflowFixture, id: string) => {
    const put = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: {
        config: { name: id, manifest: { ...notifyClients(), id } },
        expectedRevision: null
      }
    });
    const { revision } = z.object({ revision: z.number() }).parse(put.json());
    return t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { revision }
    });
  };

  it("makes an approver's own publish live, through the guardrail and the kind's approve right", async () => {
    const t = await guarded();

    const published = await rootPublishes(t, "notify-clients");

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

  // With RIGHTS-1a a member who holds the publish right and every right of the principal may
  // publish a Workflow: under the guardrail that publish waits for a holder of workflow.approve.
  it("holds a member's publish as a workflow_publish request, and publishes it on approval", async () => {
    const t = await guarded();
    await rootPublishes(t, "notify-members");
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, "notify-members");
    await t.grant(t.kai.id, "workflow.read", { assetId: notify });
    await t.grant(t.kai.id, "workflow.write", { assetId: notify });
    await t.grant(t.kai.id, "workflow.publish", { assetId: notify });
    const put = await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "notify-members" },
      payload: {
        config: {
          name: "notify-members",
          manifest: { ...notifyClients(), id: "notify-members", name: "Notify members" }
        },
        expectedRevision: 1
      }
    });
    const { revision } = z.object({ revision: z.number() }).parse(put.json());
    const publish = {
      params: { kind: WORKFLOW_ASSET_KIND, name: "notify-members" },
      payload: { revision }
    };
    // RIGHTS-1a asks the member's rights against the principal's when the request is filed: a
    // member who could not make the revision live files nothing.
    const refused = await t.call(t.kai.id, "assets.publish", publish);
    expect(refused.statusCode, refused.body).toBe(403);
    // The principal may use the Connection on the whole instance, and so may the member now.
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");

    const response = await t.call(t.kai.id, "assets.publish", publish);

    expect(response.statusCode, response.body).toBe(202);
    const held = heldSchema.parse(response.json());
    const request = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: held.approvalRequestId
    });
    expect(request).toMatchObject({ kind: "workflow_publish", status: "pending" });
    const decided = await t.call(t.root.id, "approval_requests.decide", {
      params: { requestId: held.approvalRequestId },
      payload: { decision: "approve" }
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await getTestJobs(t.instance).runDue();
    const live = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: "notify-members"
    });
    const ended = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: held.approvalRequestId
    });
    expect(ended?.applyResult).toMatchObject({ execution: "done" });
    expect(live?.publishedRevision).toBe(revision);
  });
});
