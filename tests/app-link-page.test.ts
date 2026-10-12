import { randomUUID } from "node:crypto";
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
});
