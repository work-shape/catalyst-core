import { describe, expect, it } from "vitest";
import { clientInstanceId } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { denied, forWorkflows, setup, type Setup } from "./support/principal-grants";
import { withTestSql } from "./support/test-sql";

// A grant row and the asset it names, where the two can part: a write beside the deletion
// of the asset. Each test here failed before its fix: the write read the asset outside its
// transaction and took no lock on it.

describe("a grant write and the deletion of the asset it names", () => {
  const row = (s: Setup, assetId: string, holder: "principal" | "user" = "principal") => ({
    clientInstanceId,
    holderKind: holder === "principal" ? ("service_principal" as const) : ("user" as const),
    holderId: holder === "principal" ? s.principal.id : s.t.kai.id,
    action: "connection.use",
    effect: "allow" as const,
    scopeKind: "asset" as const,
    scopeId: assetId,
    grantedBy: s.t.root.id
  });
  const deleteConnection = (s: Setup, name: string) =>
    applyAtCurrentRevisions(s.t.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "delete", kind: "connection", name }]
    });

  it("writes no row for an asset that was deleted after the operation read it", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    await deleteConnection(s, "crm");

    // The store is where the operation's read of the asset and the write of the row meet.
    for (const holder of ["principal", "user"] as const) {
      await expect(s.t.stores.access.createGrant(row(s, crm, holder))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: "invalid_scope" }
      });
    }
    await expect(s.t.stores.access.createGrant(row(s, "asset-missing"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    });
    expect(await s.t.stores.access.listGrants({ clientInstanceId })).toEqual([]);
  });

  it("waits for a deletion in flight and then writes no row", async () => {
    const s = await setup();
    const crm = await s.t.seed("crm", forWorkflows);
    let settled = false;
    let write: Promise<unknown> = Promise.resolve();
    await withTestSql((sql) =>
      sql.begin(async (tx) => {
        // What a deletion holds from its first write on the asset until it commits.
        await tx`select id from config_assets where id = ${crm} for update`;
        write = s.t.stores.access.createGrant(row(s, crm)).finally(() => {
          settled = true;
        });
        write.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await tx`update config_assets set status = 'deleted' where id = ${crm}`;
      })
    );
    await expect(write).rejects.toMatchObject({ details: { reason: "invalid_scope" } });
    expect(await s.principalRows()).toEqual([]);
  });

  it("leaves no allow row behind when the operation and a delete of the Connection run side by side", async () => {
    const s = await setup();
    const { t } = s;
    for (let round = 0; round < 12; round += 1) {
      const name = `crm-${round}`;
      const assetId = await t.seed(name, forWorkflows);
      const [granted] = await Promise.all([
        t.instance.call("permissions.grant", {
          payload: s.payload(assetId),
          headers: { "x-test-user": t.root.id }
        }),
        deleteConnection(s, name)
      ]);
      // Whichever came first: the Connection is gone, and so is every allow on it.
      expect(await s.principalRows(), `round ${round}: ${granted.statusCode}`).toEqual([]);
      // Stored again under the same name, it is reachable by nobody it was not given to.
      await t.seed(name, forWorkflows);
      expect((await s.step(name)).result).toMatchObject(denied("connection.use", "no_grant"));
    }
  });
});
