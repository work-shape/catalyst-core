import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// T34: a person renames an App where it stands. The name people read changes at once for the
// draft and what is published, without a revision, and no later write of the App changes it.

const titleSchema = z.looseObject({ config: z.looseObject({ title: z.string() }) });
const listSchema = z.object({
  items: z.array(z.looseObject({ name: z.string(), title: z.string() }))
});

describe("renaming an App", () => {
  const open: AppInstance[] = [];
  const setup = async () => {
    const t = await setupAppInstance();
    open.push(t);
    return t;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });

  const rename = (t: AppInstance, userId: string, app: string, title: string) =>
    t.call(userId, "apps.rename", {
      params: { app },
      payload: { workspaceId: t.workspaceId, title }
    });
  const read = async (t: AppInstance, revision: "draft" | "published") =>
    titleSchema.parse(
      (
        await t.expectOk(t.admin.id, "assets.get", {
          params: { kind: "app", name: "offers" },
          query: { workspaceId: t.workspaceId, revision }
        })
      ).json()
    ).config.title;
  const listed = async (t: AppInstance) =>
    listSchema
      .parse(
        (
          await t.expectOk(t.admin.id, "assets.list", {
            params: { kind: "app" },
            query: { workspaceId: t.workspaceId }
          })
        ).json()
      )
      .items.find((item) => item.name === "offers")?.title;

  it("names the draft and what is published at once, keeps the id, and writes no revision", async () => {
    const t = await setup();
    expectStatus(await t.putApp(t.admin.id, "offers", appFiles("one")), 200);
    expectStatus(await t.publish(t.admin.id, "offers", 1), 200);
    expect(await listed(t)).toBe("Offers");

    const response = await rename(t, t.admin.id, "offers", "Fee calculator");

    expectStatus(response, 200);
    expect(response.json()).toEqual({ name: "offers", title: "Fee calculator" });
    expect(await read(t, "draft")).toBe("Fee calculator");
    expect(await read(t, "published")).toBe("Fee calculator");
    expect(await listed(t)).toBe("Fee calculator");
    expect(
      await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "offers" })
    ).toMatchObject({ revision: 1, publishedRevision: 1, personTitle: "Fee calculator" });

    // The event names the App, never the name.
    const events = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
      (event) => event.type === "app.renamed"
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ kind: "app", name: "offers" });
    expect(JSON.stringify(events[0])).not.toContain("Fee calculator");
  });

  it("keeps the name over a later write whose manifest names another", async () => {
    const t = await setup();
    expectStatus(await t.putApp(t.admin.id, "offers", appFiles("one")), 200);
    expectStatus(await rename(t, t.admin.id, "offers", "Fee calculator"), 200);

    expectStatus(
      await t.putApp(t.admin.id, "offers", appFiles("two", { name: "Commission tool" })),
      200
    );

    expect(await read(t, "draft")).toBe("Fee calculator");
    expect(await listed(t)).toBe("Fee calculator");
  });

  it("asks the right that edits the App, and leaves the name of a refused call", async () => {
    const t = await setup();
    expectStatus(await t.putApp(t.admin.id, "offers", appFiles("one")), 200);

    // Lena is no member of the workspace: she may not edit its Apps.
    expect((await rename(t, t.lena.id, "offers", "Taken over")).statusCode).toBeGreaterThanOrEqual(
      400
    );
    expect(await read(t, "draft")).toBe("Offers");
    // An App that is not there is not found, and an empty name is no name.
    expectStatus(await rename(t, t.admin.id, "nothing-here", "Anything"), 404);
    expectStatus(await rename(t, t.admin.id, "offers", "   "), 422);
  });
});
