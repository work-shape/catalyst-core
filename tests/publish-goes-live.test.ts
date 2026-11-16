import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PUBLISH_APPROVAL_GUARDRAIL } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { guardedEvents } from "./support/guardrails";

// PUB-LIVE-1 (2026-11-16): a publish goes live directly. The shipped guardrail "Publishing needs
// an instance admin's approval" is off where nobody switched it, so a member who may publish
// makes a new version live with their own click. A guardrail the instance binds to a
// before-publish event still stops the publish.

const FORBIDDEN = "NICHT-VEROEFFENTLICHEN";

const shippedSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      enabled: z.boolean(),
      switchedBy: z.object({ id: z.string() }).optional()
    })
  )
});

describe("a publish goes live directly", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(
            stores,
            {
              no_marker_in_apps: {
                displayName: "No marker in published Apps",
                on: "app.before_publish",
                check: {
                  kind: "pattern",
                  pattern: FORBIDDEN,
                  reason: "Apps never carry the marker."
                },
                outcome: "block"
              }
            },
            { shipped: true }
          ).events
        }
      })
    });
    // Kai may write and publish the workspace's Apps, and may not approve a publish.
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

  it("ships the publish guardrail switched off", async () => {
    const listed = shippedSchema.parse(
      (await t.expectOk(t.admin.id, "guardrails.list_shipped", {})).json()
    );
    expect(listed.items).toContainEqual({ name: PUBLISH_APPROVAL_GUARDRAIL.name, enabled: false });
  });

  it("makes a member's publish live at once, with nothing waiting in an Inbox", async () => {
    expectStatus(
      await t.putApp(t.kai.id, "live-at-once", appFiles("Offers 1", { id: "live-at-once" })),
      200
    );
    const response = await t.publish(t.kai.id, "live-at-once", 1);
    expectStatus(response, 200);
    expect((await stored("live-at-once"))?.publishedRevision).toBe(1);
    const pending = await t.stores.approvals.listApprovalRequests({
      clientInstanceId,
      kinds: ["app_publish", "operation_call"],
      status: "pending"
    });
    expect(pending).toEqual([]);
  });

  it("is stopped by a guardrail the instance binds to the before-publish event", async () => {
    expectStatus(
      await t.putApp(t.kai.id, "stopped", appFiles(`Offers ${FORBIDDEN}`, { id: "stopped" })),
      200
    );
    const response = await t.publish(t.kai.id, "stopped", 1);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain("Apps never carry the marker.");
    expect((await stored("stopped"))?.publishedRevision).toBeUndefined();
  });

  it("holds a member's publish again once an instance admin switches the guardrail on", async () => {
    expectStatus(
      await t.call(t.admin.id, "guardrails.switch_shipped", {
        params: { name: PUBLISH_APPROVAL_GUARDRAIL.name },
        payload: { enabled: true }
      }),
      200
    );
    expectStatus(await t.putApp(t.kai.id, "held", appFiles("Offers 1", { id: "held" })), 200);
    const response = await t.publish(t.kai.id, "held", 1);
    expectStatus(response, 202);
    expect((await stored("held"))?.publishedRevision).toBeUndefined();
  });
});
