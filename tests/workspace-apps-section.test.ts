import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collaborationWorkspaceAgentsSchema } from "@work-shape/catalyst-api-contract";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// The Apps row of the sidebar (NAV-VIS-1): the workspace's list of agents names it where the
// Apps page of that workspace lists the caller an App, or the caller may write one there, in
// the workspace or on one of its Apps. A member is never shown an empty row. With the module
// off it is never named; `workspace-agents-section.test.ts` runs without it.

describe("the Apps row the workspace's list of agents names", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  const sections = async (userId: string) => {
    const response = await t.expectOk(userId, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: t.workspaceId }
    });
    return collaborationWorkspaceAgentsSchema.parse(response.json()).visibleSections;
  };
  const withGrant = async (
    scope: { scopeKind: "workspace"; scopeId: string } | { scopeKind: "asset"; scopeId: string },
    run: () => Promise<void>
  ) => {
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.write",
      effect: "allow",
      ...scope,
      grantedBy: t.admin.id
    });
    try {
      await run();
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
  };

  it("names the row to whoever may write an App, and to a member only once one is published", async () => {
    // No App yet: the builder gets the row to make the first one, the member none.
    expect(await sections(t.admin.id)).toContain("apps");
    expect(await sections(t.kai.id)).not.toContain("apps");

    // A draft alone shows the member nothing on the Apps page, so no row either.
    expectStatus(await t.putApp(t.admin.id, "sketch", appFiles("sketch", { name: "Sketch" })), 200);
    expect(await sections(t.kai.id)).not.toContain("apps");

    // A grant in the workspace or on its one App counts, without any role.
    await withGrant({ scopeKind: "workspace", scopeId: t.workspaceId }, async () => {
      expect(await sections(t.kai.id)).toContain("apps");
    });
    await withGrant({ scopeKind: "asset", scopeId: await t.assetId("app", "sketch") }, async () => {
      expect(await sections(t.kai.id)).toContain("apps");
    });
    expect(await sections(t.kai.id)).not.toContain("apps");

    // Published, the member opens it through the use right the membership brings.
    expectStatus(await t.publish(t.admin.id, "sketch", 1), 200);
    expect(await sections(t.kai.id)).toContain("apps");
  });
});
