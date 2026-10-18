import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PRINCIPAL_GRANTABLE_ACTIONS, asUserId } from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";

// Giving a technical account a right on a resource that a workspace owns needs the giver's
// read right there as the resource's own read decides it: with the workspace. A read denied in
// the workspace refuses the grant and writes nothing; where the giver may read, it is given.

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "admin-1", roles: ["user", "admin"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
const asAdmin = { "x-dev-user-id": "admin-1" };

/** The kinds a workspace may own and a technical account may be given rights on. */
const owned = [
  {
    kind: "data_store",
    payload: (name: string) => ({
      files: [
        { path: "store.yaml", text: `id: ${name}\nname: Secret store\n` },
        { path: "migrations/0001_init.sql", text: "create table findings(id text);" }
      ]
    })
  },
  {
    kind: "knowledge_base",
    payload: (name: string) => ({
      config: {
        name,
        title: "Secret knowledge",
        description: "Kept by one team.",
        methods: ["keyword"]
      }
    })
  }
] as const;

const idSchema = z.object({ id: z.string() });
const principalSchema = z.object({ principal: z.object({ id: z.string() }) });

describe("a grant to a technical account on a resource a workspace owns", () => {
  const { start } = useDataStoreInstance();

  it("is refused to an administrator denied reading in that workspace, and nothing is written", async () => {
    const world = await start(true, undefined, developmentAuth, undefined, true);
    const { api, stores } = world;
    const made = await api.call("service_principals.create", {
      payload: { name: "workspace-runner", displayLabel: "Workspace runner" }
    });
    expect(made.statusCode, made.body).toBe(200);
    const principal = principalSchema.parse(made.json()).principal.id;
    const admin = asUserId(
      idSchema.parse((await api.call("me.get", { headers: asAdmin })).json()).id
    );
    const give = (action: string, scopeId: string) =>
      api.call("permissions.grant", {
        headers: asAdmin,
        payload: {
          holderKind: "service_principal",
          holderId: principal,
          action,
          effect: "allow",
          scopeKind: "asset",
          scopeId
        }
      });
    const rowsOn = async (scopeId: string) =>
      (await stores.access.listGrants({ clientInstanceId, holderId: principal })).filter(
        (row) => row.scopeId === scopeId
      );

    for (const { kind, payload } of owned) {
      const workspaceOf = async (label: string) =>
        (
          await stores.workspaces.createWorkspace({
            clientInstanceId,
            kind: "shared",
            name: `${label} ${kind}`,
            creatorUserId: admin
          })
        ).id;
      const put = async (name: string, workspaceId: string) => {
        const written = await api.call("assets.put", {
          params: { kind, name },
          payload: { ...payload(name), workspaceId, expectedRevision: null }
        });
        expect(written.statusCode, written.body).toBe(200);
        const asset = await stores.access.getGrantableAsset({
          clientInstanceId,
          assetId:
            (await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name }))?.id ?? ""
        });
        expect(asset?.workspaceId).toBe(workspaceId);
        return asset?.id ?? "";
      };
      const actions = PRINCIPAL_GRANTABLE_ACTIONS.filter((action) => action.startsWith(`${kind}.`));
      expect(actions.length).toBeGreaterThan(0);

      // Reading is denied in the workspace that owns the resource, not on the resource.
      const hiddenWorkspace = await workspaceOf("Hidden");
      const hidden = await put(`hidden-${kind.replace("_", "-")}`, hiddenWorkspace);
      await stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: admin,
        action: `${kind}.read`,
        effect: "deny",
        scopeKind: "workspace",
        scopeId: hiddenWorkspace,
        grantedBy: admin
      });
      for (const action of actions) {
        const refused = await give(action, hidden);
        expect(refused.statusCode, `${action} ${refused.body}`).toBe(403);
        expect(refused.json()).toMatchObject({ error: { details: { reason: "not_visible" } } });
      }
      expect(await rowsOn(hidden)).toEqual([]);

      // A resource of another workspace the administrator may read is given as before.
      const seenWorkspace = await workspaceOf("Seen");
      const seen = await put(`seen-${kind.replace("_", "-")}`, seenWorkspace);
      for (const action of actions) {
        const given = await give(action, seen);
        expect(given.statusCode, `${action} ${given.body}`).toBe(200);
      }
      expect((await rowsOn(seen)).map((row) => row.action).sort()).toEqual([...actions].sort());
    }
  });
});
