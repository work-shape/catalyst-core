import { connectionAccessSchema } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { clientInstanceId, SCOPES_HEADER } from "./support/access-instance";
import { forWorkflows, setup } from "./support/principal-grants";

// CONN-WHO-1: who may use a Connection is read under its page's read right. Every reader gets
// the built-in roles with their verbs. Only a reader who manages users, with a credential that
// reads their administration, gets the custom roles, people and groups; service principals only
// where the reader sees them. Nothing else is named or counted.
describe("connections.access", () => {
  it("names roles, then holders with their verbs, and only what the reader may see", async () => {
    const { t, grantTo, manager } = await setup();
    try {
      const crm = await t.seed("crm", forWorkflows);
      for (const reader of [t.kai.id, manager.id]) {
        await t.grant(reader, "connection.read", { assetId: crm });
      }
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
      await t.expectOk(t.root.id, "roles.create", {
        payload: {
          name: "Sales",
          grants: [{ action: "connection.use", effect: "allow", scopeKind: "asset", scopeId: crm }]
        }
      });
      await grantTo(crm);

      const read = async (userId: string, scopes?: string) =>
        connectionAccessSchema.parse(
          (
            await t.expectOk(userId, "connections.access", {
              params: { name: "crm" },
              ...(scopes ? { headers: { [SCOPES_HEADER]: scopes } } : {})
            })
          ).json()
        );

      const all = ["read", "use", "write", "delete", "approve"];
      const kai = { kind: "user", id: t.kai.id, title: "Kai", verbs: ["read", "use"] };
      const byAdmin = await read(t.admin.id);
      // A built-in role by its id, a custom one by its name.
      const named = (roles: { id: string; name: string; builtIn: boolean }[]) =>
        roles.map((role) => (role.builtIn ? role.id : role.name));
      expect(byAdmin.roles.map(({ verbs }) => verbs)).toEqual([all, all, ["use"]]);
      expect(named(byAdmin.roles)).toEqual(["superadmin", "admin", "Sales"]);
      expect(byAdmin.holders).toEqual([
        kai,
        expect.objectContaining({ kind: "user", title: "Manager", verbs: ["read"] }),
        expect.objectContaining({
          kind: "service_principal",
          title: "Monthly check",
          verbs: ["use"]
        })
      ]);
      expect(byAdmin.holdersShown).toBe(true);

      // A user manager who sees no service principals: the people, and no principal at all.
      const byManager = await read(manager.id);
      expect(named(byManager.roles)).toEqual(["superadmin", "admin", "Sales"]);
      expect(byManager.holders.map(({ kind }) => kind)).toEqual(["user", "user"]);
      expect(byManager.holdersShown).toBe(true);
      expect(byManager).not.toHaveProperty("hidden");

      // Without the scope that reads the administration of users, the manager names no one.
      const byManagerKey = await read(manager.id, "config_assets:read");
      expect(byManagerKey.roles.map(({ id }) => id)).toEqual(["superadmin", "admin"]);
      expect(byManagerKey.holders).toEqual([]);
      expect(byManagerKey.holdersShown).toBe(false);

      // Kai reads the page and manages no users: the built-in roles, and nothing counted.
      const byKai = await read(t.kai.id);
      expect(byKai).toEqual({
        roles: [
          expect.objectContaining({ id: "superadmin" }),
          expect.objectContaining({ id: "admin" })
        ],
        holders: [],
        holdersShown: false
      });

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
