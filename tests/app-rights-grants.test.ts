import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assetSchema, assetSummarySchema } from "@work-shape/catalyst-api-contract";
import { ROLE_DEFAULT_ACTIONS, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, grantSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// RIGHTS-1c: the rights of Apps are granted to a person, in one workspace, on one App or for
// the whole instance. Access acceptance check 39 and D3. Fails without the App rows of
// `GRANTABLE_ACTION_SCOPES`: every grant here was refused with `action_not_grantable`.

const revisionSchema = z.object({ revision: z.number() });

describe("check 39: a right on Apps given in one workspace", () => {
  let t: AppInstance;
  let other: CollaborationWorkspaceId;
  beforeAll(async () => {
    t = await setupAppInstance();
    other = await t.sharedWorkspace("Other");
    // Kai is a member of both workspaces: only the right tells them apart.
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: other,
      userId: t.kai.id,
      role: "member"
    });
    for (const workspaceId of [t.workspaceId, other]) {
      for (const name of ["offers", "drop"]) {
        expectStatus(await putIn(t.admin.id, workspaceId, nameIn(workspaceId, name), "admin"), 200);
      }
    }
  });
  afterAll(async () => {
    await t.close();
  });

  // An App's name is the instance's: each workspace has its own.
  const nameIn = (workspaceId: string, name: string) =>
    workspaceId === t.workspaceId ? name : `${name}-other`;
  const putIn = (userId: string, workspaceId: string, name: string, marker: string) =>
    t.call(userId, "assets.put", {
      params: { kind: "app", name },
      payload: { files: appFiles(marker, { name: "Offers" }), workspaceId }
    });
  const giveInW = (action: string) =>
    t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId
      }
    });
  const refusedAction = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details;

  it("lets the member save a draft in the workspace, and not in another", async () => {
    expect(refusedAction(await putIn(t.kai.id, t.workspaceId, "offers", "kai"))).toMatchObject({
      action: "app.write"
    });
    await giveInW("app.write");
    expectStatus(await putIn(t.kai.id, t.workspaceId, "offers", "kai"), 200);
    const elsewhere = await putIn(t.kai.id, other, nameIn(other, "offers"), "kai");
    expectStatus(elsewhere, 403);
    expect(refusedAction(elsewhere)).toMatchObject({ action: "app.write" });
  });

  it("publishes in the workspace, and not in another", async () => {
    const publish = async (workspaceId: string) => {
      const name = nameIn(workspaceId, "offers");
      const listed = await t.expectOk(t.admin.id, "assets.get", {
        params: { kind: "app", name },
        query: { workspaceId }
      });
      const { revision } = revisionSchema.parse(listed.json());
      return t.call(t.kai.id, "assets.publish", {
        params: { kind: "app", name },
        payload: { revision, workspaceId }
      });
    };
    expect(refusedAction(await publish(t.workspaceId))).toMatchObject({ action: "app.publish" });
    await giveInW("app.publish");
    expectStatus(await publish(t.workspaceId), 200);
    const elsewhere = await publish(other);
    expectStatus(elsewhere, 403);
    expect(refusedAction(elsewhere)).toMatchObject({ action: "app.publish" });
  });

  it("deletes in the workspace, and not in another", async () => {
    const remove = async (workspaceId: string) => {
      const name = nameIn(workspaceId, "drop");
      const listed = await t.expectOk(t.admin.id, "assets.get", {
        params: { kind: "app", name },
        query: { workspaceId }
      });
      const { revision } = revisionSchema.parse(listed.json());
      return t.call(t.kai.id, "assets.delete", {
        params: { kind: "app", name },
        payload: { expectedRevision: revision, workspaceId }
      });
    };
    expect(refusedAction(await remove(t.workspaceId))).toMatchObject({ action: "app.delete" });
    await giveInW("app.delete");
    expectStatus(await remove(t.workspaceId), 200);
    const elsewhere = await remove(other);
    expectStatus(elsewhere, 403);
    expect(refusedAction(elsewhere)).toMatchObject({ action: "app.delete" });
  });
});

describe("a right for the whole instance (D3)", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  const onInstance = (action: string) => ({
    payload: {
      holderKind: "user",
      holderId: t.lena.id,
      action,
      effect: "allow",
      scopeKind: "instance"
    }
  });

  it("is written, listed and revoked for a right no legacy key carries", async () => {
    const granted = grantSchema.parse(
      (await t.expectOk(t.admin.id, "permissions.grant", onInstance("app.read"))).json()
    );
    const listed = z
      .object({ items: z.array(z.object({ id: z.string() }).loose()) })
      .parse((await t.expectOk(t.admin.id, "permissions.list")).json());
    expect(listed.items.map((item) => item.id)).toContain(granted.id);
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: granted.id } });
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.lena.id })).toEqual([]);
  });

  it("is refused for a right a legacy key carries, and with a place named", async () => {
    await t.expectRefused(t.admin.id, "permissions.grant", onInstance("agent.read"), {
      status: 422,
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    });
    const named = onInstance("app.read");
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload: { ...named.payload, scopeId: t.workspaceId } },
      { status: 422, code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } }
    );
  });

  it("gives the member role no right to publish a Workflow", () => {
    expect(ROLE_DEFAULT_ACTIONS.user).not.toContain("workflow.publish");
  });
});

describe("App list and record rights", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  const grant = (
    action: string,
    effect: "allow" | "deny",
    scopeKind: "workspace" | "asset",
    scopeId: string
  ) =>
    t.expectOk(t.admin.id, "permissions.grant", {
      payload: { holderKind: "user", holderId: t.kai.id, action, effect, scopeKind, scopeId }
    });
  const get = async (userId: string, name: string) =>
    assetSchema.parse(
      (
        await t.expectOk(userId, "assets.get", {
          params: { kind: "app", name },
          query: { workspaceId: t.workspaceId }
        })
      ).json()
    );
  const list = async () =>
    z.object({ items: z.array(assetSummarySchema) }).parse(
      (
        await t.expectOk(t.kai.id, "assets.list", {
          params: { kind: "app" },
          query: { workspaceId: t.workspaceId }
        })
      ).json()
    ).items;

  it("lists an unpublished App for its asset-only writer with the same rights as its record", async () => {
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "app", name: "asset-writer" },
      payload: { files: appFiles("draft"), workspaceId: t.workspaceId }
    });
    const asset = await get(t.admin.id, "asset-writer");
    expect((await list()).find((item) => item.id === asset.id)).toBeUndefined();
    await grant("app.write", "allow", "asset", asset.id);
    const record = await get(t.kai.id, "asset-writer");
    const row = (await list()).find((item) => item.id === asset.id);
    expect(row).toMatchObject({ draftRevision: record.draftRevision, allowed: ["write"] });
    expect(record.allowed).toEqual(["write"]);
    expect(row?.allowed).toEqual(record.allowed);
  });

  it("applies an asset delete deny over a workspace grant, without borrowing read", async () => {
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "app", name: "asset-deny" },
      payload: { files: appFiles("draft"), workspaceId: t.workspaceId }
    });
    const asset = await get(t.admin.id, "asset-deny");
    await grant("app.read", "allow", "asset", asset.id);
    await grant("app.delete", "allow", "workspace", t.workspaceId);
    await grant("app.delete", "deny", "asset", asset.id);
    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "app", name: asset.name },
      payload: { revision: asset.revision, workspaceId: t.workspaceId }
    });
    const record = await get(t.kai.id, asset.name);
    const row = (await list()).find((item) => item.id === asset.id);
    expect(record.allowed).toEqual(["read"]);
    expect(row?.allowed).toEqual(record.allowed);
  });
});
