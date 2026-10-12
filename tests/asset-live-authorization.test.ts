import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAppAssetKind,
  createWorkflowLiveCheck,
  requireWorkflowRunAs,
  type PageBuildRunner
} from "@vivd-catalyst/chat-server";
import { asServicePrincipalId, createPlatformId, type PlatformStores } from "@vivd-catalyst/core";
import { accessOf } from "./support/access";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { createTestUser } from "./support/fixtures";

// Who may make a revision live, where the revision lends more than its kind's publish right
// covers. The kind under test is the App kind with the check of the Workflow kind on it, read
// from a `runAs` in its manifest: a kind with a draft and a published revision, which is what
// the hook is for. Each test fails without `authorizeLive`: the holder of the publish right
// published every revision.

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
  const apiAccess: Parameters<typeof createWorkflowLiveCheck>[0]["apiAccess"] = {
    findServicePrincipalByName: (input) => {
      if (!stores) throw new Error("The instance is not set up");
      return stores.apiAccess.findServicePrincipalByName(input);
    }
  };
  const runAs = { clientInstanceId, apiAccess };

  beforeAll(async () => {
    t = await setupAppInstance({
      build,
      appKind: {
        ...createAppAssetKind(),
        authorizeLive: createWorkflowLiveCheck(runAs, runAsOf)
      }
    });
    stores = t.stores;
    for (const name of ["booking-check", "payroll"]) {
      await t.stores.apiAccess.createServicePrincipal({
        clientInstanceId,
        name,
        displayLabel: name
      });
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

  it("refuses the holder of the publish right alone, for a new revision and for an earlier one", async () => {
    // The administrator holds `app.write` and `app.publish`, and does not administer principals.
    const first = await write(t.admin.id, "booking-check");
    const denied = await refused(t.admin.id, first);
    expect(denied.details).toEqual({ action: "api_access.manage", reason: "no_grant" });
    expect(denied.message).toContain("booking-check");
    expect(await published()).toBeUndefined();

    // Whoever administers service principals lets the Workflow act as one.
    expectStatus(await t.publish(t.root.id, "offers", first), 200);
    const live = await published();
    expect(live).toBeDefined();

    // A writer changes the principal. The publish right alone does not carry that either.
    const second = await write(t.admin.id, "payroll");
    expect((await refused(t.admin.id, second)).details).toEqual({
      action: "api_access.manage",
      reason: "no_grant"
    });
    expect(await published()).toBe(live);
    expectStatus(await t.publish(t.root.id, "offers", second), 200);

    // Going back to the earlier revision makes its principal act again: the same question.
    expect((await refused(t.admin.id, first)).details).toEqual({
      action: "api_access.manage",
      reason: "no_grant"
    });
    expectStatus(await t.publish(t.root.id, "offers", first), 200);
  });

  it("refuses a name no principal of the instance has, with the name", async () => {
    const revision = await write(t.admin.id, "nobody");
    const response = await t.publish(t.root.id, "offers", revision);
    expectStatus(response, 422);
    expect(errorSchema.parse(response.json()).error.details).toMatchObject({
      reason: "run_as_unknown",
      runAs: "nobody"
    });
  });

  it("asks the same of a test run, and never lets a service principal pass", async () => {
    const superadmin = createTestUser("user-1", clientInstanceId);
    const administrator = { ...superadmin, id: "user-2", roles: ["user", "admin"] };
    const ask = (actor: Parameters<typeof accessOf>[0]) =>
      requireWorkflowRunAs(
        runAs,
        { actor, access: accessOf(actor) },
        { workflow: "booking-check", runAs: "booking-check", operation: "workflows.test" }
      );

    await expect(ask(superadmin)).resolves.toMatchObject({ name: "booking-check" });
    await expect(ask(administrator)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { action: "api_access.manage", reason: "no_grant" }
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
        { workflow: "booking-check", runAs: undefined, operation: "workflows.test" }
      )
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "run_as_missing" } });
  });
});
