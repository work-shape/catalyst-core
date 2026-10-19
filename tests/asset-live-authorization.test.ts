import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAppAssetKind,
  createWorkflowLiveCheck,
  requireWorkflowRunAs,
  type PageBuildRunner
} from "@work-shape/catalyst-server";
import {
  accessHolderFromIdentity,
  asServicePrincipalId,
  createActorAccess,
  createPlatformId,
  legacyGrantRows,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { createTestUser } from "./support/fixtures";

// Who may make a revision live, where the revision lends more than its kind's publish right
// covers. The kind under test is the App kind with the check of the Workflow kind on it, read
// from a `runAs` in its manifest: a kind with a draft and a published revision, which is what
// the hook is for. The publisher holds every right of the principal, or the revision stays a
// draft (RIGHTS-1a, check 38): no role and no right over principals stands in for that. Each
// test fails without `authorizeLive`: the holder of the publish right published every revision.

const manifestSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kit: z.string(),
  entry: z.string()
});
/** A build that keeps every key of the manifest, `runAs` among them. */
const build: PageBuildRunner = ({ files }) => {
  const manifestFile = files.find((file) => file.path === "app.yaml");
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestFile?.bytes ?? new Uint8Array()))
  );
  return Promise.resolve({
    status: "built",
    manifest,
    kitVersion: manifest.kit,
    files: files.filter((file) => file.path !== "app.yaml").map((file) => ({ ...file }))
  });
};
const runAsOf = (config: unknown) =>
  z.object({ manifest: z.object({ runAs: z.unknown() }) }).safeParse(config).data?.manifest.runAs;

describe("making a revision live that names a service principal", () => {
  let t: AppInstance;
  let stores: PlatformStores | undefined;
  let inaId = "";
  const storesOf = () => {
    if (!stores) throw new Error("The instance is not set up");
    return stores;
  };
  const runAs: Parameters<typeof createWorkflowLiveCheck>[0] = {
    clientInstanceId,
    apiAccess: {
      findServicePrincipalByName: (input) => storesOf().apiAccess.findServicePrincipalByName(input),
      findServicePrincipalByOwner: (input) =>
        storesOf().apiAccess.findServicePrincipalByOwner(input)
    },
    access: {
      loadPersistedAccess: (input) => storesOf().access.loadPersistedAccess(input),
      listGrantScopeAssets: (input) => storesOf().access.listGrantScopeAssets(input)
    }
  };
  /** Writes a row for a principal as the store holds it, at the whole instance. */
  const allowPrincipal = async (principalId: string, action: string) => {
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principalId,
      action,
      effect: "allow",
      scopeKind: "instance",
      grantedBy: t.root.id
    });
  };

  beforeAll(async () => {
    t = await setupAppInstance({
      build,
      appKind: {
        ...createAppAssetKind(),
        authorizeLive: createWorkflowLiveCheck(runAs, runAsOf)
      }
    });
    stores = t.stores;
    const created: Record<string, string> = {};
    for (const name of ["booking-check", "payroll", "releaser"]) {
      const principal = await t.stores.apiAccess.createServicePrincipal({
        clientInstanceId,
        name,
        displayLabel: name
      });
      created[name] = principal.id;
    }
    // Ina administers the instance, and a deny takes the Connections from her.
    const ina = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Ina",
      roles: ["user", "admin"],
      permissions: []
    });
    inaId = ina.id;
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: ina.id,
      action: "connection.use",
      effect: "deny",
      scopeKind: "instance",
      grantedBy: t.root.id
    });
    // `booking-check` calls Connections; `payroll` holds nothing; `releaser` releases config.
    await allowPrincipal(created["booking-check"] ?? "", "connection.use");
    for (const row of legacyGrantRows(["config_assets.release"])) {
      await allowPrincipal(created.releaser ?? "", row.action);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const write = async (userId: string, principal: string) => {
    const response = await t.putApp(
      userId,
      "offers",
      appFiles(principal, { id: "offers", runAs: principal })
    );
    expectStatus(response, 200);
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  };
  const refused = async (userId: string, revision: number) => {
    const response = await t.publish(userId, "offers", revision);
    expectStatus(response, 403);
    return errorSchema.parse(response.json()).error;
  };
  const published = async () =>
    (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "offers" }))
      ?.publishedRevisionId;

  it("lets whoever holds every right of the principal publish, a new revision and an earlier one", async () => {
    const first = await write(t.admin.id, "booking-check");
    const denied = await refused(inaId, first);
    expect(denied.details).toEqual({ action: "connection.use", reason: "denied" });
    expect(denied.message).toBe(
      "'connection.use' on the whole instance is denied to this call, and 'booking-check' would act with it. Only a holder of a right gives or lends it"
    );
    expect(await published()).toBeUndefined();

    // The administrator is no superadmin and holds no `api_access.manage`: she holds the right.
    expectStatus(await t.publish(t.admin.id, "offers", first), 200);
    const live = await published();
    expect(live).toBeDefined();

    // A principal that holds nothing lends nothing: the publish right is enough.
    const second = await write(t.admin.id, "payroll");
    expectStatus(await t.publish(inaId, "offers", second), 200);
    expect(await published()).not.toBe(live);

    // Going back to the earlier revision makes its principal act again: the same question.
    expect((await refused(inaId, first)).details).toEqual({
      action: "connection.use",
      reason: "denied"
    });
    expectStatus(await t.publish(t.admin.id, "offers", first), 200);
    expect(await published()).toBe(live);
  });

  it("lets nobody publish a revision that runs as a principal releasing config, superadmins included", async () => {
    const revision = await write(t.admin.id, "releaser");
    for (const userId of [t.admin.id, t.root.id]) {
      const denied = await refused(userId, revision);
      expect(denied.details).toEqual({ action: "config_assets.release", reason: "no_grant" });
    }
  });

  // Fails without the delete clearing the published revision: the row kept it, so the write
  // that restores the name made the earlier revision live again, and nobody was asked.
  it("leaves a deleted Workflow that is written again a draft, until someone who may publishes it", async () => {
    const revision = await write(t.admin.id, "booking-check");
    expectStatus(await t.publish(t.admin.id, "offers", revision), 200);
    expect(await published()).toBeDefined();

    expectStatus(
      await t.call(t.admin.id, "assets.delete", {
        params: { kind: "app", name: "offers" },
        payload: { workspaceId: t.workspaceId, expectedRevision: revision }
      }),
      200
    );
    expect(await published()).toBeUndefined();

    // A holder of the write right restores the name. It is a draft and nothing is served.
    const restored = await write(t.admin.id, "booking-check");
    expect(await published()).toBeUndefined();
    expect((await refused(inaId, restored)).details).toEqual({
      action: "connection.use",
      reason: "denied"
    });
    expect(await published()).toBeUndefined();
    expectStatus(await t.publish(t.admin.id, "offers", restored), 200);
    expect(await published()).toBeDefined();
  });
  // Fails without the check of the status: a revision went live whose runs could act as
  // nobody, or as a principal an administrator had switched off.
  it("refuses a principal that is disabled, with the name", async () => {
    const principal = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "retired",
      displayLabel: "Retired"
    });
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: principal.id,
      status: "disabled"
    });
    const revision = await write(t.admin.id, "retired");
    const response = await t.publish(t.root.id, "offers", revision);
    expectStatus(response, 422);
    expect(errorSchema.parse(response.json()).error.details).toEqual({
      reason: "run_as_disabled",
      runAs: "retired",
      principalDisplayLabel: "Retired"
    });
    expect(errorSchema.parse(response.json()).error.message).toContain(
      "technical account 'Retired'"
    );
    expect(errorSchema.parse(response.json()).error.message).toContain("Settings > API access");
  });

  it("refuses a name no principal of the instance has, with the name", async () => {
    const revision = await write(t.admin.id, "nobody");
    const response = await t.publish(t.root.id, "offers", revision);
    expectStatus(response, 422);
    expect(errorSchema.parse(response.json()).error.details).toMatchObject({
      reason: "run_as_unknown",
      runAs: "nobody"
    });
    expect(errorSchema.parse(response.json()).error.message).toContain(
      "technical account 'nobody'"
    );
    expect(errorSchema.parse(response.json()).error.message).toContain("Settings > API access");
  });

  it("asks the rights of the principal of a caller's key, and never lets a service principal pass", async () => {
    const superadmin = createTestUser("user-1", clientInstanceId);
    const administrator = { ...superadmin, id: "user-2", roles: ["user", "admin"] };
    const ask = (
      actor: Parameters<typeof accessOf>[0],
      access: ReturnType<typeof accessOf> = accessOf(actor)
    ) =>
      requireWorkflowRunAs(
        runAs,
        { actor, access },
        { workflow: "booking-check", runAs: "booking-check" }
      );

    await expect(ask(superadmin)).resolves.toMatchObject({ name: "booking-check" });
    await expect(ask(administrator)).resolves.toMatchObject({ name: "booking-check" });
    // A personal key lends what its scopes cover: one that names no Connection lends none.
    await expect(
      ask(
        administrator,
        createActorAccess(
          accessHolderFromIdentity(administrator),
          { holderActive: true, grants: [] },
          ["app.publish"]
        )
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { action: "connection.use", reason: "outside_key_scope" }
    });
    // A run acts as a principal and holds what it was granted: it lends no other principal.
    await expect(
      ask({
        kind: "service",
        id: asServicePrincipalId("spn_1"),
        displayLabel: "Runner",
        permissionRefs: [],
        permissions: ["api_access.manage"],
        clientInstanceId,
        authSource: "workflow_run",
        scopes: [],
        workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requireWorkflowRunAs(
        runAs,
        { actor: superadmin, access: accessOf(superadmin) },
        { workflow: "booking-check", runAs: undefined }
      )
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "run_as_missing" } });
  });
});
