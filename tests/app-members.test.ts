import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  previewSchema,
  setupAppInstance,
  type AppInstance
} from "./support/app-instance";

// What a member of an App's workspace is shown, who holds the use right and no other: the
// published revision in the list and in a read, and nothing of a draft.

const itemSchema = z.looseObject({ name: z.string(), title: z.string(), revision: z.number() });
const listSchema = z.object({ items: z.array(itemSchema) });

describe("the Apps a member of the workspace is shown", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
    // `offers` is published as "Offers" and has a draft ahead that renames it.
    await put("offers", "live", "Offers");
    expectStatus(await t.publish(t.admin.id, "offers", 1), 200);
    expectStatus(await t.putApp(t.admin.id, "offers", appFiles("ahead", { name: "Renamed" })), 200);
    // `sketch` has a draft and was never published.
    await put("sketch", "sketch", "Sketch");
  });
  afterAll(async () => {
    await t.close();
  });

  const put = async (name: string, marker: string, title: string) =>
    expectStatus(
      await t.instance.call("assets.put", {
        params: { kind: "app", name },
        payload: { files: appFiles(marker, { name: title }), workspaceId: t.workspaceId },
        headers: { "x-test-user": t.admin.id }
      }),
      200
    );
  const list = async (userId: string) => {
    const response = await t.call(userId, "assets.list", {
      params: { kind: "app" },
      query: { workspaceId: t.workspaceId }
    });
    expectStatus(response, 200);
    return listSchema.parse(response.json()).items;
  };
  const get = (userId: string, name: string, query: Record<string, string> = {}) =>
    t.call(userId, "assets.get", {
      params: { kind: "app", name },
      query: { workspaceId: t.workspaceId, ...query }
    });
  const revisions = (userId: string, name: string) =>
    t.call(userId, "assets.revisions.list", {
      params: { kind: "app", name },
      query: { workspaceId: t.workspaceId }
    });
  const refusedFor = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details;
  const withGrant = async (action: string, run: () => Promise<void>) => {
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action,
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
    try {
      await run();
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
  };

  it("lists the published App with the title it was published under, and no App with a draft alone", async () => {
    const items = await list(t.kai.id);

    expect(items.map((item) => item.name)).toEqual(["offers"]);
    expect(items[0]).toMatchObject({ title: "Offers", revision: 1, publishedRevision: 1 });
    expect(items[0]).not.toHaveProperty("draftRevision");
    expect(JSON.stringify(items)).not.toContain("Renamed");
    // Somebody outside the workspace is shown nothing.
    expect(await list(t.lena.id)).toEqual([]);
  });

  it("answers a member's read with the published revision and nothing of the draft", async () => {
    const reads: Record<string, string>[] = [{}, { revision: "published" }];
    for (const query of reads) {
      const response = await get(t.kai.id, "offers", query);
      expectStatus(response, 200);
      const body = z
        .looseObject({ config: z.looseObject({ title: z.string() }) })
        .parse(response.json());
      expect(body).toMatchObject({
        name: "offers",
        revision: 1,
        contentRevision: 1,
        publishedRevision: 1,
        config: { title: "Offers" }
      });
      expect(body).not.toHaveProperty("draftRevision");
      expect(body).not.toHaveProperty("files");
      expect(response.body).not.toContain("Renamed");
    }
    // What the list and the read name is what `apps.preview` opens.
    const preview = await t.expectOk(t.kai.id, "apps.preview", {
      params: { app: "offers" },
      payload: { mode: "published" }
    });
    expect((await t.open(previewSchema.parse(preview.json()).url)).body).toContain("live");
  });

  it("refuses a member the draft, a numbered revision, the files, the history and an App that is not published", async () => {
    for (const query of [{ revision: "draft" }, { revision: "2" }, { revision: "1" }]) {
      const response = await get(t.kai.id, "offers", query);
      expectStatus(response, 403);
      expect(refusedFor(response), JSON.stringify(query)).toMatchObject({ action: "app.write" });
    }
    const files = await get(t.kai.id, "offers", { files: "true", revision: "published" });
    expectStatus(files, 403);
    expect(refusedFor(files)).toMatchObject({ action: "app.read" });
    const history = await revisions(t.kai.id, "offers");
    expectStatus(history, 403);
    expect(refusedFor(history)).toMatchObject({ action: "app.write" });

    // An App without a published revision answers as one that does not exist.
    const sketch = await get(t.kai.id, "sketch");
    const missing = await get(t.kai.id, "no-such-app");
    expectStatus(sketch, 403);
    expect(refusedFor(sketch)).toEqual(refusedFor(missing));
    expectStatus(await get(t.lena.id, "offers"), 403);
  });

  it("leaves a reader, a writer and a publisher what they were shown", async () => {
    await withGrant("app.read", async () => {
      const items = await list(t.kai.id);
      expect(items.map((item) => item.name)).toEqual(["offers", "sketch"]);
      expect(items[0]).toMatchObject({
        title: "Renamed",
        revision: 2,
        draftRevision: 2,
        publishedRevision: 1
      });
      // The draft is not a reader's: a read that names no revision answers the published view,
      // and a read that names the draft is refused.
      const plain = await get(t.kai.id, "offers");
      expectStatus(plain, 200);
      expect(plain.json()).toMatchObject({ revision: 1, contentRevision: 1 });
      expect(plain.json()).not.toHaveProperty("draftRevision");
      expectStatus(await get(t.kai.id, "offers", { revision: "draft" }), 403);
      expectStatus(await get(t.kai.id, "sketch"), 403);
      const published = await get(t.kai.id, "offers", { revision: "published" });
      expectStatus(published, 200);
      expect(published.json()).toMatchObject({ revision: 2, draftRevision: 2, contentRevision: 1 });
      // The history holds the drafts.
      const history = await revisions(t.kai.id, "offers");
      expectStatus(history, 403);
      expect(refusedFor(history)).toMatchObject({ action: "app.write" });
    });
    for (const action of ["app.write", "app.publish"]) {
      await withGrant(action, async () => {
        const draft = await get(t.kai.id, "offers");
        expectStatus(draft, 200);
        expect(draft.json(), action).toMatchObject({
          revision: 2,
          draftRevision: 2,
          contentRevision: 2,
          config: { title: "Renamed" }
        });
        expectStatus(await get(t.kai.id, "sketch"), 200);
        const history = await revisions(t.kai.id, "offers");
        expectStatus(history, 200);
        expect(z.object({ items: z.array(z.unknown()) }).parse(history.json()).items).toHaveLength(
          2
        );
      });
    }
    const all = await list(t.admin.id);
    expect(all.map((item) => item.name)).toEqual(["offers", "sketch"]);
    expect(all[0]).toMatchObject({ title: "Renamed", draftRevision: 2, publishedRevision: 1 });
  });
});
