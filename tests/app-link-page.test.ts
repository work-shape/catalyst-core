import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  previewSchema,
  setupAppInstance,
  type AppInstance
} from "./support/app-instance";

// A Page is put into an App that is not its own: one saved before Apps remembered their Page,
// or one that is updated from another Page. The App is the Page's from then on, because the
// App's Page is the one its newest revision with a Page names. Every test here fails without
// `link` on `apps.update_from_page` and `candidate` on `apps.get_from_page`: the first was
// refused as an unknown key, and an App's Page was read from its first revision alone.

const linkSchema = z.object({
  app: z
    .object({ name: z.string(), draftRevision: z.number(), draftFromPage: z.boolean() })
    .nullable(),
  candidate: z
    .object({
      name: z.string(),
      title: z.string(),
      workspaceId: z.string(),
      draftRevision: z.number(),
      page: z.string()
    })
    .nullable()
    .optional()
});

type PageRef = { conversationId: string; pageId: string };

describe("a Page put into an App that is not its own", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({ explicitCredentials: true });
  });
  afterAll(async () => {
    await t.close();
  });

  const update = (
    userId: string,
    page: PageRef,
    app: string,
    expectedRevision: number,
    extra: { link?: boolean; headers?: Record<string, string> } = {}
  ) =>
    t.call(userId, "apps.update_from_page", {
      params: { app },
      payload: {
        ...page,
        workspaceId: t.workspaceId,
        expectedRevision,
        ...(extra.link ? { link: true } : {})
      },
      headers: extra.headers ?? {}
    });
  /** What the surface of a Page is told, and with `app` what putting it into that App meets. */
  const asked = async (userId: string, page: PageRef, app?: string) =>
    linkSchema.parse(
      (
        await t.expectOk(userId, "apps.get_from_page", {
          params: page,
          ...(app === undefined ? {} : { query: { app } })
        })
      ).json()
    );
  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const draftBody = async (app: string, mode: "draft" | "published" = "draft") => {
    const response = await t.expectOk(t.admin.id, "apps.preview", {
      params: { app },
      payload: { mode }
    });
    return (await t.open(previewSchema.parse(response.json()).url)).body;
  };
  /** `app.write` in the workspace is held through a role; the row a role stands for, once. */
  let kaiWriting: Promise<unknown> | undefined;
  const kaiWrites = () =>
    (kaiWriting ??= t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    }));
  const refusalOf = (response: Awaited<ReturnType<AppInstance["call"]>>) =>
    errorSchema.parse(response.json()).error;
  const updatedEvents = async (correlationId: string) =>
    (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
      (event) => event.correlationId === correlationId && event.type === "config_asset.updated"
    );

  it("puts a Page into an App from before Apps remembered their Page, and the Page updates it from then on", async () => {
    // An App as an earlier release left it, published, and the Page at its third revision.
    expectStatus(await t.putApp(t.admin.id, "earlier", appFiles("as it was saved")), 200);
    expectStatus(await t.publish(t.admin.id, "earlier", 1), 200);
    const page = await t.storePage("first");
    await t.storePage("second", {}, page);
    await t.storePage("third", {}, page);
    expect(await asked(t.admin.id, page, "earlier")).toMatchObject({
      app: null,
      candidate: {
        name: "earlier",
        workspaceId: t.workspaceId,
        draftRevision: 1,
        page: "none"
      }
    });
    const correlationId = randomUUID();

    const linked = await update(t.admin.id, page, "earlier", 1, {
      link: true,
      headers: { "x-correlation-id": correlationId }
    });

    expectStatus(linked, 200);
    expect(await stored("earlier")).toMatchObject({ revision: 2 });
    expect(await draftBody("earlier")).toContain("third");
    // Nothing is published by it.
    expect(await draftBody("earlier", "published")).toContain("as it was saved");
    expect(await t.listed("earlier")).toMatchObject({ draftRevision: 2, publishedRevision: 1 });
    // One event, which says that the write made the App the Page's.
    const events = await updatedEvents(correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      kind: "app",
      name: "earlier",
      revision: 2,
      pageId: page.pageId,
      pageLinked: true
    });

    // The Page names the App now, and updates it without saying `link`.
    expect((await asked(t.admin.id, page)).app).toEqual({
      name: "earlier",
      draftRevision: 2,
      draftFromPage: true
    });
    await t.storePage("fourth", {}, page);
    const again = randomUUID();
    expectStatus(
      await update(t.admin.id, page, "earlier", 2, { headers: { "x-correlation-id": again } }),
      200
    );
    expect(await draftBody("earlier")).toContain("fourth");
    expect((await updatedEvents(again))[0]?.metadata).not.toHaveProperty("pageLinked");
  });

  it("offers nothing to a reader of the Page who may not write the App, and refuses the call", async () => {
    expectStatus(await t.putApp(t.admin.id, "not-kais", appFiles("the administrator's")), 200);
    const page = await t.storePage("shared with kai", {}, { shared: true });

    expect(await asked(t.kai.id, page, "not-kais")).toEqual({ app: null, candidate: null });
    // An id nobody has answers the same.
    expect((await asked(t.kai.id, page, "nobodys")).candidate).toBeNull();
    const refused = await update(t.kai.id, page, "not-kais", 1, { link: true });

    expectStatus(refused, 403);
    expect(refusalOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "app.write", reason: "no_grant" }
    });
    expect(await stored("not-kais")).toMatchObject({ revision: 1 });
    expect((await asked(t.kai.id, page)).app).toBeNull();
  });

  it("reads an App's Page from its newest revision that names one", async () => {
    const first = await t.storePage("the first page");
    const second = await t.storePage("the second page");
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...first, name: "moves", title: "Moves", workspaceId: t.workspaceId }
    });
    expect((await asked(t.admin.id, second, "moves")).candidate).toMatchObject({
      page: "other_conversation"
    });
    // Without `link` an App of another Page is not written.
    const refused = await update(t.admin.id, second, "moves", 1);
    expectStatus(refused, 409);
    expect(refusalOf(refused).details).toMatchObject({ reason: "app_not_from_page" });

    expectStatus(await update(t.admin.id, second, "moves", 1, { link: true }), 200);

    // The App is the second Page's, and the first Page's no more.
    expect((await asked(t.admin.id, second)).app).toMatchObject({ name: "moves" });
    expect(await asked(t.admin.id, first, "moves")).toMatchObject({
      app: null,
      candidate: { page: "other_conversation" }
    });
    expectStatus(await update(t.admin.id, first, "moves", 2), 409);
    expect((await asked(t.admin.id, second, "moves")).candidate).toMatchObject({ page: "this" });

    // A write that names no Page leaves the App with the Page of the revision before it.
    expectStatus(
      await t.call(t.admin.id, "assets.put", {
        params: { kind: "app", name: "moves" },
        payload: {
          files: appFiles("written with its files"),
          workspaceId: t.workspaceId,
          expectedRevision: 2
        }
      }),
      200
    );
    expect((await asked(t.admin.id, second)).app).toEqual({
      name: "moves",
      draftRevision: 3,
      draftFromPage: false
    });
    expect((await asked(t.admin.id, first)).app).toBeNull();
  });

  it("does not put a Page into an App whose draft moved since it was read", async () => {
    expectStatus(await t.putApp(t.admin.id, "moved", appFiles("read at one")), 200);
    expectStatus(
      await t.call(t.admin.id, "assets.put", {
        params: { kind: "app", name: "moved" },
        payload: {
          files: appFiles("written meanwhile"),
          workspaceId: t.workspaceId,
          expectedRevision: 1
        }
      }),
      200
    );
    const page = await t.storePage("to be linked");

    const stale = await update(t.admin.id, page, "moved", 1, { link: true });

    expectStatus(stale, 412);
    expect(refusalOf(stale).code).toBe("REVISION_CONFLICT");
    expect(await stored("moved")).toMatchObject({ revision: 2 });
    expect(await draftBody("moved")).toContain("written meanwhile");
    expect((await asked(t.admin.id, page)).app).toBeNull();
  });

  it("refuses an update of an App that another write gave another Page while the update was on its way", async () => {
    const own = await t.storePage("the page of the app", {}, { shared: false });
    const other = await t.storePage("the page of the other writer");
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...own, name: "raced", title: "Raced", workspaceId: t.workspaceId }
    });
    expectStatus(await t.publish(t.admin.id, "raced", 1), 200);
    // The second writer comes in after the update read which Page the App has: it puts the
    // other Page into the App and discards that draft, so the App is at revision 1 again.
    const store = t.stores.configAssets;
    const read = store.getConfigAssetPageOrigin.bind(store);
    let waiting = true;
    const spy = vi.spyOn(store, "getConfigAssetPageOrigin").mockImplementation(async (input) => {
      const answer = await read(input);
      if (waiting) {
        waiting = false;
        expectStatus(await update(t.admin.id, other, "raced", 1, { link: true }), 200);
        expectStatus(
          await t.call(t.admin.id, "assets.discard_draft", {
            params: { kind: "app", name: "raced" },
            payload: { expectedRevision: 2, workspaceId: t.workspaceId }
          }),
          200
        );
      }
      return answer;
    });

    const late = await update(t.admin.id, own, "raced", 1);
    spy.mockRestore();

    // The revision the update names is the draft's again, and the App is the other Page's now.
    expectStatus(late, 409);
    expect(refusalOf(late).details).toMatchObject({ reason: "app_not_from_page" });
    expect(
      await t.stores.configAssets.listConfigAssetRevisions({
        clientInstanceId,
        kind: "app",
        name: "raced"
      })
    ).toHaveLength(2);
    expect((await asked(t.admin.id, other)).app).toMatchObject({ name: "raced" });
    expect((await asked(t.admin.id, own)).app).toBeNull();
  });

  it("copies no file for an update that names another revision than the draft's", async () => {
    const page = await t.storePage("copied once");
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "not-copied", title: "Not copied", workspaceId: t.workspaceId }
    });
    const puts = vi.spyOn(t.objects, "put");

    const stale = await update(t.admin.id, page, "not-copied", 7);
    const copied = puts.mock.calls.length;
    puts.mockRestore();

    // Refused before the files of the Page are copied below the App, not by the store after.
    expectStatus(stale, 412);
    expect(copied).toBe(0);
  });

  it("finds an App the caller may write behind more than one read of other people's Apps", async () => {
    const page = await t.storePage("saved very often", {}, { shared: true });
    const elsewhere = await t.sharedWorkspace("Elsewhere");
    // Fifty Apps of the Page in a workspace where kai writes nothing, as their saves left them.
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: {
        ...(await t.storePage("another page")),
        name: "as-saved",
        title: "As saved",
        workspaceId: t.workspaceId
      }
    });
    const asSaved = (await stored("as-saved"))?.config ?? {};
    for (let index = 0; index < 50; index += 1) {
      const name = `elsewhere-${String(index).padStart(2, "0")}`;
      await t.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [`app:${name}`]: null },
        origin: { kind: "page", ...page, fileSetNumber: 1 },
        mutations: [
          {
            type: "upsert",
            kind: "app",
            name,
            config: { ...asSaved, name, title: name },
            scope: { kind: "workspace", workspaceId: elsewhere },
            draft: true
          }
        ]
      });
    }
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "the-51st", title: "The 51st", workspaceId: t.workspaceId }
    });
    await kaiWrites();

    expect((await asked(t.kai.id, page)).app).toMatchObject({ name: "the-51st" });
  });

  it("checks the write right again on the App it writes, whatever was decided when the call came in", async () => {
    const page = await t.storePage("checked twice", {}, { shared: true });
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "checked-twice", title: "Checked", workspaceId: t.workspaceId }
    });
    const app = await stored("checked-twice");
    if (!app) throw new Error("The App was not saved");
    // Kai writes the Apps of the workspace and is denied this one.
    await kaiWrites();
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.write",
      effect: "deny",
      scopeKind: "asset",
      scopeId: app.id,
      grantedBy: t.admin.id
    });
    // The check of the incoming call is answered an App of the name that is not the denied
    // one, as if the name had been another App's a moment before. The write reads the real one.
    const store = t.stores.configAssets;
    const read = store.getConfigAsset.bind(store);
    let first = true;
    const spy = vi.spyOn(store, "getConfigAsset").mockImplementation(async (input) => {
      const row = await read(input);
      if (first && row?.name === "checked-twice") {
        first = false;
        return { ...row, id: "cfga_another" };
      }
      return row;
    });

    const refused = await update(t.kai.id, page, "checked-twice", 1);
    spy.mockRestore();

    expect(first).toBe(false);
    expectStatus(refused, 403);
    expect(refusalOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "app.write" }
    });
    expect(await stored("checked-twice")).toMatchObject({ revision: 1 });
  });
});
