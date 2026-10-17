import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRANTABLE_ACTIONS } from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

describe("retired Namespace scope", () => {
  let t: AccessInstance;
  beforeAll(async () => {
    t = await setupAccessInstance({
      modules: {
        connections: { enabled: true },
        workflows: { enabled: true },
        apps: { enabled: true },
        dataStores: { enabled: true },
        knowledge: { enabled: true }
      }
    });
    await t.createNamespace("old-");
  });
  afterAll(async () => {
    await t.instance.close();
  });

  it("refuses every new Namespace row with the existing invalid_scope shape", async () => {
    for (const action of GRANTABLE_ACTIONS) {
      const response = await t.call(t.admin.id, "permissions.grant", {
        payload: {
          holderKind: "user",
          holderId: t.kai.id,
          action,
          effect: "allow",
          scopeKind: "namespace",
          namespace: "old-"
        }
      });
      expect(response.statusCode, action).toBe(422);
      expect(response.json(), action).toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } }
      });
    }
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);
  });

  it("still reads, lists and revokes a row written before Namespace retirement", async () => {
    const row = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "agent.read",
      effect: "allow",
      scopeKind: "namespace",
      namespace: "old-",
      grantedBy: t.admin.id
    });
    await t.putAgent(t.admin.id, "old-helper");
    await t.expectOk(t.kai.id, "assets.get", { params: { kind: "agent", name: "old-helper" } });
    const listed = await t.expectOk(t.admin.id, "permissions.list");
    expect(listed.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: row.id, scopeKind: "namespace", namespace: "old-" })
      ])
    });
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: row.id } });
    expect(
      (await t.call(t.kai.id, "assets.get", { params: { kind: "agent", name: "old-helper" } }))
        .statusCode
    ).toBe(403);
  });
});
