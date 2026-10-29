import { connectionAccessSchema } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { clientInstanceId } from "./support/access-instance";
import { forWorkflows, setup } from "./support/principal-grants";

// CONN-WHO-1: who may use a Connection is read under its page's read right. The roles come
// first, then each holder of a right of its own with its verbs; a reader who manages no users
// is told the built-in roles and a count, never who.
describe("connections.access", () => {
  it("names roles, then holders with their verbs, and only what the reader may see", async () => {
    const { t, grantTo } = await setup();
    try {
      const crm = await t.seed("crm", forWorkflows);
      await t.grant(t.kai.id, "connection.read", { assetId: crm });
      await t.grant(t.kai.id, "connection.use", { assetId: crm });
      // An allow that a deny on every Connection takes back is no right.
      await t.grant(t.lena.id, "connection.use", { assetId: crm });
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.lena.id,
        action: "connection.use",
        effect: "deny",
        scopeKind: "instance",
        grantedBy: t.root.id
      });
      await grantTo(crm);

      const read = async (userId: string) =>
        connectionAccessSchema.parse(
          (await t.expectOk(userId, "connections.access", { params: { name: "crm" } })).json()
        );

      const all = ["read", "use", "write", "delete", "approve"];
      const byAdmin = await read(t.admin.id);
      expect(byAdmin.roles.map(({ id, verbs }) => ({ id, verbs }))).toEqual([
        { id: "superadmin", verbs: all },
        { id: "admin", verbs: all }
      ]);
      expect(byAdmin.holders).toEqual([
        { kind: "user", id: t.kai.id, title: "Kai", verbs: ["read", "use"] },
        expect.objectContaining({
          kind: "service_principal",
          title: "Monthly check",
          verbs: ["use"]
        })
      ]);
      expect(byAdmin.hidden).toBe(0);

      // Kai reads the page and manages no users: the roles, and a count of the rest.
      const byKai = await read(t.kai.id);
      expect(byKai.roles.map(({ id }) => id)).toEqual(["superadmin", "admin"]);
      expect(byKai.holders).toEqual([]);
      expect(byKai.hidden).toBe(2);

      // Without the page's read right there is nothing to read.
      await t.expectRefused(
        t.lena.id,
        "connections.access",
        { params: { name: "crm" } },
        { status: 403, code: "FORBIDDEN" }
      );
    } finally {
      await t.instance.close();
    }
  });
});
