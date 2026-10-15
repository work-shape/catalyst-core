import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import { appSource, setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { getTestJobs, getTestOperationCalls } from "./support/test-instance";

// Verifier's repros for PR 69 on real rows. A call held for an approval before the removal of
// `connections.call` is a run of `connection.crm.write` with the origin `app` and the action
// name `connections.call`; it is made here on the call path as the removed route made it.

describe("PR 69 on an instance", () => {
  let t: AppActionsInstance;
  beforeAll(async () => {
    t = await setupAppActions();
  });
  afterAll(() => t.closeAll());

  const publishApp = async (name: string) => {
    expectStatus(await t.putApp(t.admin.id, name, appSource("published", name)), 200);
    expectStatus(await t.publish(t.admin.id, name, 1), 200);
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name
    });
    if (!asset?.publishedRevisionId) throw new Error("not published");
    return asset.publishedRevisionId;
  };

  /**
   * A direct call of the Connection as the removed route made it, held for an approval. It is
   * made on the registry without the App origin guard, as the release before the removal let it
   * wait; the guard ends such a call now, when it is made and when it is executed.
   */
  const holdLegacyDirectCall = async (app: string, revisionId: string, key: string) => {
    const kai = t.kai;
    const calls = await getTestOperationCalls(t.instance);
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "approval" }];
    try {
      const outcome = await runOperation(
        {
          operation: "connection.crm.write",
          effect: "changing",
          input: { note: key },
          actor: {
            id: kai.id,
            externalUserId: kai.id,
            displayLabel: kai.displayLabel,
            roles: kai.roles,
            permissions: kai.permissions,
            permissionRefs: kai.permissionRefs,
            clientInstanceId,
            authSource: "test",
            scopes: ["*"]
          },
          origin: {
            kind: "app",
            appName: app,
            appRevisionId: revisionId,
            actionName: "connections.call",
            pageSessionId: `ps_${key}`,
            target: { connection: "crm", operation: "write" }
          },
          workspaceId: t.workspaceId,
          idempotencyKey: key,
          correlationId: `corr_${key}`
        },
        { ...calls.deps, registry: calls.registry }
      );
      expect(outcome.result.status).toBe("pending_approval");
      const run = await t.runOf(outcome.run.id);
      if (run.approvalRequestId === undefined) throw new Error("The run names no request");
      return { runId: run.id, requestId: run.approvalRequestId };
    } finally {
      t.state.centralSettings = [];
    }
  };
  const approve = async (requestId: string) => {
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
  };

  // Check 46: "no Operation Run reaches the Connection" for a call of `connections.call`. A
  // call held before the removal is ended when it is executed after it (manager, F1).
  it("does not carry out a held connections.call approved after the removal", async () => {
    const revision = await publishApp("legacy-held");
    await t.withRight(t.kai.id, "connection.use", { assetId: t.crm }, async () => {
      const held = await holdLegacyDirectCall("legacy-held", revision, "legacy-1");
      const handed = t.handed.length;
      await approve(held.requestId);
      expect(t.handed.length, "the Connection was reached").toBe(handed);
      expect(await t.runOf(held.runId)).toMatchObject({
        operation: "connection.crm.write",
        status: "failed",
        error: {
          code: "CONFLICT",
          message: expect.stringContaining("connections.call was removed")
        }
      });
    });
  });

  // The only purpose app-origin-guard.ts keeps; PR 69 removed every test of it.
  it("ends a held connections.call whose App was removed, before the Connection", async () => {
    const revision = await publishApp("legacy-gone");
    await t.withRight(t.kai.id, "connection.use", { assetId: t.crm }, async () => {
      const held = await holdLegacyDirectCall("legacy-gone", revision, "legacy-2");
      expectStatus(
        await t.call(t.admin.id, "assets.delete", {
          params: { kind: "app", name: "legacy-gone" },
          payload: { expectedRevision: 1, workspaceId: t.workspaceId }
        }),
        200
      );
      const handed = t.handed.length;
      await approve(held.requestId);
      expect(t.handed.length).toBe(handed);
      expect(await t.runOf(held.runId)).toMatchObject({
        operation: "connection.crm.write",
        status: "failed",
        error: { code: "NOT_FOUND" }
      });
    });
  });

  // Check 47 on the save path (assets.put, which the CLI push uses): refused, no revision.
  it("refuses an App with 'rights' on assets.put with key_reserved and writes no revision", async () => {
    const before = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "orders"
    });
    const files = appSource("rights").map((file) =>
      file.path === "app.yaml" && "text" in file
        ? { ...file, text: JSON.stringify({ ...JSON.parse(file.text), rights: ["orders.read"] }) }
        : file
    );
    const refused = await t.putApp(t.admin.id, "orders", files);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("key_reserved");
    expect(refused.body).toContain("'rights' is reserved");
    const after = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "orders"
    });
    expect(after?.revision).toBe(before?.revision);
  });
});
