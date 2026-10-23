import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

const publishedTitle = "Published customer offers";
const draftTitle = "Confidential expansion plan";
const listSchema = z.object({
  items: z.array(z.object({ name: z.string(), title: z.string() }))
});

describe("asset list search respects revision access", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
    expectStatus(
      await t.putApp(t.admin.id, "offers", appFiles("published", { name: publishedTitle })),
      200
    );
    expectStatus(await t.publish(t.admin.id, "offers", (await t.listed("offers")).revision), 200);
    expectStatus(
      await t.putApp(t.admin.id, "offers", appFiles("draft", { name: draftTitle })),
      200
    );
    await t.grant(t.lena.id, "app.read", { workspaceId: t.workspaceId });
    await t.grant(t.kai.id, "app.write", { workspaceId: t.workspaceId });
  });
  afterAll(async () => {
    await t?.close();
  });

  const list = async (userId: string, text?: string) =>
    listSchema.parse(
      (
        await t.expectOk(userId, "assets.list", {
          params: { kind: "app" },
          query: { workspaceId: t.workspaceId, text }
        })
      ).json()
    ).items;

  it("does not match the draft title for a read-only user", async () => {
    expect(await list(t.lena.id, draftTitle)).toEqual([]);
  });

  it("matches the draft title for a writer", async () => {
    expect(await list(t.kai.id, draftTitle)).toEqual([{ name: "offers", title: draftTitle }]);
  });

  it("matches the published title for readers and writers", async () => {
    expect(await list(t.lena.id, publishedTitle)).toEqual([
      { name: "offers", title: publishedTitle }
    ]);
    expect(await list(t.kai.id, publishedTitle)).toEqual([{ name: "offers", title: draftTitle }]);
  });

  it("shows a read-only user the same published title without a search", async () => {
    expect(await list(t.lena.id)).toEqual([{ name: "offers", title: publishedTitle }]);
  });
});
