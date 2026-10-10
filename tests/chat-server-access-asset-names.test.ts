import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId, setupAccessInstance as setup, skill } from "./support/access-instance";

// A grant row names the asset it applies to. The name is itself something to read: a caller
// who administers users without reading agents and skills is given the row without it.

describe("what a grant row says to a caller who may not read agents and skills", () => {
  it("leaves the asset's name out and keeps the scope id and whether the asset exists", async () => {
    const t = await setup();
    const usersOnly = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Users only",
      roles: ["user"],
      permissions: ["users.manage"]
    });
    for (const name of ["kai-secret", "kai-gone"]) {
      await t.expectOk(t.admin.id, "config_assets.put", {
        params: { kind: "skill", name },
        payload: { config: skill(name) }
      });
    }
    const secretId = await t.assetId("skill", "kai-secret");
    const goneId = await t.assetId("skill", "kai-gone");
    const deny = (scopeId: string) => ({
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "skill.read",
        scopeKind: "asset",
        scopeId,
        effect: "deny"
      }
    });
    const row = z.object({ scopeId: z.string(), scopeAsset: z.unknown() });

    // The caller's own write answers without the name, too.
    const written = await t.expectOk(usersOnly.id, "permissions.grant", deny(secretId));
    expect(row.parse(written.json())).toEqual({
      scopeId: secretId,
      scopeAsset: { kind: "skill", active: true }
    });
    await t.expectOk(t.admin.id, "permissions.grant", deny(goneId));
    await t.expectOk(t.admin.id, "config_assets.delete", {
      params: { kind: "skill", name: "kai-gone" },
      payload: {}
    });

    const list = z.object({ items: z.array(row) });
    const listed = list.parse((await t.expectOk(usersOnly.id, "permissions.list")).json());
    expect(listed.items).toEqual(
      expect.arrayContaining([
        { scopeId: secretId, scopeAsset: { kind: "skill", active: true } },
        { scopeId: goneId, scopeAsset: { kind: "skill", active: false } }
      ])
    );
    expect(JSON.stringify(listed)).not.toMatch(/kai-secret|kai-gone/u);
    // A caller who reads skills is still given the names.
    const named = list.parse((await t.expectOk(t.admin.id, "permissions.list")).json());
    expect(JSON.stringify(named)).toMatch(/kai-secret/u);
    expect(JSON.stringify(named)).toMatch(/kai-gone/u);
  });
});
