import { describe, expect, it } from "vitest";
import { clientInstanceId, grantSchema } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { forWorkflows, setup } from "./support/principal-grants";

// Browser conversion: a manager of principals needs no user administration, but may only
// give a right they hold, on a Connection that still exists.
describe("a principal manager without user administration", () => {
  it("grants only its held Connection rights and refuses a deleted Connection without writing a row", async () => {
    const s = await setup();
    const { t, ops, principal } = s;
    try {
      await t.stores.users.updateUser({
        clientInstanceId,
        userId: ops.id,
        permissions: ["!users.manage", "api_access.manage"]
      });
      const crm = await t.seed("held-crm", forWorkflows);
      const restricted = await t.seed("restricted-crm", forWorkflows);
      const gone = await t.seed("gone-crm", forWorkflows);
      await t.grant(ops.id, "connection.use", { assetId: restricted }, "deny");

      await t.expectOk(ops.id, "permissions.effective", {
        query: { holderKind: "user", holderId: ops.id }
      });
      const query = { holderKind: "service_principal", holderId: principal.id };
      await t.expectOk(ops.id, "permissions.list", { query });
      await t.expectRefused(
        ops.id,
        "permissions.list",
        { query: { holderKind: "user", holderId: t.kai.id } },
        { status: 403, code: "FORBIDDEN" }
      );

      const granted = grantSchema.parse(
        (await t.expectOk(ops.id, "permissions.grant", { payload: s.payload(crm) })).json()
      );
      expect(granted).toMatchObject({
        holderKind: "service_principal",
        holderId: principal.id,
        action: "connection.use",
        scopeKind: "asset",
        scopeId: crm
      });
      await t.expectRefused(
        ops.id,
        "permissions.grant",
        { payload: s.payload(restricted) },
        t.forbidden("connection.use", "denied")
      );

      await applyAtCurrentRevisions(t.stores.configAssets, {
        clientInstanceId,
        mutations: [{ type: "delete", kind: "connection", name: "gone-crm" }]
      });
      await t.expectRefused(
        ops.id,
        "permissions.grant",
        { payload: s.payload(gone) },
        { status: 422, code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } }
      );
      expect((await s.principalRows()).map((row) => row.id)).toEqual([granted.id]);
      await t.expectOk(ops.id, "permissions.revoke", { params: { grantId: granted.id } });
      expect(await s.principalRows()).toEqual([]);
    } finally {
      await t.instance.close();
    }
  });
});
