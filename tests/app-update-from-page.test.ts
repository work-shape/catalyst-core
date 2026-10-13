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

// An App that was saved from a Page takes the Page's newest revision as its next draft: who may
// ask for that, which App a Page's surface names, and what the draft and the published revision
// are afterwards. Every test here fails without `apps.update_from_page` and
// `apps.get_from_page`: neither operation existed, and no revision named a Page.

const writtenSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  revision: z.number(),
  fileSetId: z.string()
});
const linkSchema = z.object({
  app: z
    .object({
      name: z.string(),
      title: z.string(),
      workspaceId: z.string(),
      draftRevision: z.number(),
      draftFromPage: z.boolean()
    })
    .nullable()
});

type PageRef = { conversationId: string; pageId: string };

describe("an App updated from the Page it was saved from", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({ explicitCredentials: true });
  });
  afterAll(async () => {
    await t.close();
  });

  /** Saves the newest revision of a Page as an App of the workspace, as `userId`. */
  const save = async (userId: string, page: PageRef, name: string, title = name) =>
    writtenSchema.parse(
      (
        await t.expectOk(userId, "apps.create_from_page", {
          payload: { ...page, name, title, workspaceId: t.workspaceId }
        })
      ).json()
    );
  const update = (
    userId: string,
    page: PageRef,
    app: string,
    expectedRevision: number,
    headers: Record<string, string> = {}
  ) =>
    t.call(userId, "apps.update_from_page", {
      params: { app },
      payload: { ...page, workspaceId: t.workspaceId, expectedRevision },
      headers
    });
  /** The App the surface of a Page is told of, for `userId`. */
  const appOf = async (userId: string, page: PageRef) =>
    linkSchema.parse((await t.expectOk(userId, "apps.get_from_page", { params: page })).json()).app;
  /** `app.write` in the workspace is held through a role; a test writes the row a role stands for. */
  const letWrite = (userId: string) =>
    t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: userId,
      action: "app.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const revisions = (name: string) =>
    t.stores.configAssets.listConfigAssetRevisions({ clientInstanceId, kind: "app", name });
  /** What a person is shown who opens the App in a mode. */
  const shown = async (userId: string, app: string, mode: "draft" | "published") => {
    const response = await t.expectOk(userId, "apps.preview", {
      params: { app },
      payload: { mode }
    });
    const answer = previewSchema.parse(response.json());
    return { revision: answer.revision, body: (await t.open(answer.url)).body };
  };
  const refusalOf = (response: Awaited<ReturnType<AppInstance["call"]>>) =>
    errorSchema.parse(response.json()).error;

  it("writes the Page's newest revision as a new draft, leaves the published one and records one event", async () => {
    const page = await t.storePage("first state");
    await save(t.admin.id, page, "budget", "Budget 2026");
    expectStatus(await t.publish(t.admin.id, "budget", 1), 200);
    await t.storePage("second state", {}, page);
    await t.storePage("third state", {}, page);
    expect(await appOf(t.admin.id, page)).toEqual({
      name: "budget",
      title: "Budget 2026",
      workspaceId: t.workspaceId,
      draftRevision: 1,
      draftFromPage: true
    });
    const correlationId = randomUUID();
    const runsBefore = await t.stores.operationRuns.list({ clientInstanceId });

    const response = await update(t.admin.id, page, "budget", 1, {
      "x-correlation-id": correlationId
    });

    expectStatus(response, 200);
    const asset = await stored("budget");
    expect(writtenSchema.parse(response.json())).toEqual({
      id: asset?.id,
      name: "budget",
      workspaceId: t.workspaceId,
      revision: 2,
      fileSetId: asset?.fileSetId
    });
    // The draft is the Page as it is now. Its users are served what they were served before.
    expect(await shown(t.admin.id, "budget", "draft")).toMatchObject({ revision: 2 });
    expect((await shown(t.admin.id, "budget", "draft")).body).toContain("third state");
    const served = await shown(t.kai.id, "budget", "published");
    expect(served.revision).toBe(1);
    expect(served.body).toContain("first state");
    expect(await t.listed("budget")).toMatchObject({ draftRevision: 2, publishedRevision: 1 });
    // The name people read is the one it was saved with, whatever the Page's manifest says.
    expect(asset?.config).toMatchObject({ name: "budget", title: "Budget 2026" });
    // The revision says which revision of which Page it copies.
    expect((await revisions("budget")).map((revision) => revision.origin)).toEqual([
      { kind: "page", ...page, fileSetNumber: 1 },
      { kind: "page", ...page, fileSetNumber: 3 }
    ]);
    expect(await appOf(t.admin.id, page)).toMatchObject({ draftRevision: 2, draftFromPage: true });

    const runs = (await t.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => !runsBefore.some((earlier) => earlier.id === run.id)
    );
    expect(runs.map((run) => `${run.operation}:${run.status}`)).toEqual([
      "apps.update_from_page:done"
    ]);
    const written = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
      (event) => event.correlationId === correlationId && event.type.startsWith("config_asset.")
    );
    expect(written.map((event) => [event.type, event.metadata])).toEqual([
      [
        "config_asset.updated",
        expect.objectContaining({ kind: "app", name: "budget", revision: 2, pageId: page.pageId })
      ]
    ]);

    // Publishing stays its own step, and works as before.
    expectStatus(await t.publish(t.admin.id, "budget", 2), 200);
    expect((await shown(t.kai.id, "budget", "published")).body).toContain("third state");
  });

  it("tells a reader of the Page who may not write the App nothing, and refuses the call", async () => {
    const page = await t.storePage("seen by kai", {}, { shared: true });
    await save(t.admin.id, page, "seen");
    await t.storePage("seen by kai, later", {}, page);
    // Kai reads the Page.
    await t.expectOk(t.kai.id, "pages.get", { params: page });

    expect(await appOf(t.kai.id, page)).toBeNull();
    const correlationId = randomUUID();
    const refused = await update(t.kai.id, page, "seen", 1, { "x-correlation-id": correlationId });

    expectStatus(refused, 403);
    expect(refusalOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "app.write", reason: "no_grant" }
    });
    const audit = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter((event) => event.correlationId === correlationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    expect(audit.map((event) => `${event.type}:${event.status}`)).toEqual([
      "operation.authorization_checked:denied",
      "operation.denied:denied"
    ]);
    expect(await stored("seen")).toMatchObject({ revision: 1 });
  });

  it("refuses a writer of the App who does not read the Page", async () => {
    const page = await t.storePage("private to the administrator");
    await save(t.admin.id, page, "private-page");
    await letWrite(t.lena.id);
    expectStatus(
      await t.call(t.lena.id, "assets.get", {
        params: { kind: "app", name: "private-page" },
        query: { workspaceId: t.workspaceId }
      }),
      200
    );

    const refused = await update(t.lena.id, page, "private-page", 1);

    expectStatus(refused, 404);
    expect(await stored("private-page")).toMatchObject({ revision: 1 });
    expectStatus(await t.call(t.lena.id, "apps.get_from_page", { params: page }), 404);
  });

  it("names no App for a Page whose App was made before Apps remembered their Page, and says why an update is refused", async () => {
    const page = await t.storePage("an earlier save");
    // An App as an earlier release left it: its first revision names no Page.
    expectStatus(await t.putApp(t.admin.id, "earlier", appFiles("an earlier save")), 200);

    expect(await appOf(t.admin.id, page)).toBeNull();
    const refused = await update(t.admin.id, page, "earlier", 1);

    expectStatus(refused, 409);
    expect(refusalOf(refused)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "app_not_from_page", kind: "app", name: "earlier" }
    });
    expect(await stored("earlier")).toMatchObject({ revision: 1 });
    // Saving the Page under that id is refused as before: the interface says what to do then.
    const taken = await t.call(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "earlier", title: "Earlier", workspaceId: t.workspaceId }
    });
    expectStatus(taken, 409);
    expect(refusalOf(taken).details).toMatchObject({ reason: "app_id_taken" });
  });

  it("refuses to write an App from another Page than the one it was saved from", async () => {
    const page = await t.storePage("its own page");
    const other = await t.storePage("another page");
    await save(t.admin.id, page, "own-page");

    const refused = await update(t.admin.id, other, "own-page", 1);

    expectStatus(refused, 409);
    expect(refusalOf(refused).details).toMatchObject({ reason: "app_not_from_page" });
    expect((await shown(t.admin.id, "own-page", "draft")).body).toContain("its own page");
  });

  it("names the App a person saved before an earlier one of somebody else, and the earliest of several", async () => {
    const page = await t.storePage("saved more than once", {}, { shared: true });
    await save(t.admin.id, page, "team-first");
    await save(t.admin.id, page, "team-second");
    // Kai comes to write Apps of the workspace and saves the Page too.
    await letWrite(t.kai.id);
    expect(await appOf(t.kai.id, page)).toMatchObject({ name: "team-first" });
    await save(t.kai.id, page, "kais-own");

    // Each person is named the App they saved; without one of their own, the earliest.
    expect(await appOf(t.kai.id, page)).toMatchObject({ name: "kais-own" });
    expect(await appOf(t.admin.id, page)).toMatchObject({ name: "team-first" });
    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "app", name: "kais-own" },
      payload: { workspaceId: t.workspaceId }
    });
    expect(await appOf(t.kai.id, page)).toMatchObject({ name: "team-first" });

    // Every App that was saved from the Page takes its update when it is named.
    await t.storePage("saved more than once, later", {}, page);
    expectStatus(await update(t.admin.id, page, "team-second", 1), 200);
    expect(await stored("team-second")).toMatchObject({ revision: 2 });
    expect(await stored("team-first")).toMatchObject({ revision: 1 });
  });

  it("carries a Page of an earlier kit into the App as it was built", async () => {
    const page = await t.storePage("built with kit 1.0.0");
    const app = await save(t.admin.id, page, "older-kit");
    await t.storePage("built with kit 1.2.0", {}, { ...page, kitVersion: "1.2.0" });

    expectStatus(await update(t.admin.id, page, "older-kit", 1), 200);

    const asset = await stored("older-kit");
    const fileSet = asset?.fileSetId
      ? await t.stores.pages.getAssetFileSet({
          clientInstanceId,
          assetId: app.id,
          fileSetId: asset.fileSetId
        })
      : undefined;
    expect(fileSet).toMatchObject({ kitVersion: "1.2.0", manifest: { kit: "1.2.0" } });
    expect(asset?.config).toMatchObject({ manifest: { kit: "1.2.0" } });
    expect((await shown(t.admin.id, "older-kit", "draft")).body).toContain("built with kit 1.2.0");
  });

  it("names no App once it was deleted, refuses its update, and lets the Page be saved again", async () => {
    const page = await t.storePage("deleted and saved again");
    await save(t.admin.id, page, "short-lived");
    await t.expectOk(t.admin.id, "assets.delete", {
      params: { kind: "app", name: "short-lived" },
      payload: { workspaceId: t.workspaceId }
    });

    expect(await appOf(t.admin.id, page)).toBeNull();
    expectStatus(await update(t.admin.id, page, "short-lived", 1), 404);

    await save(t.admin.id, page, "short-lived");
    expect(await appOf(t.admin.id, page)).toMatchObject({ name: "short-lived", draftRevision: 1 });
  });

  it("does not overwrite a draft that was written another way until the call names its revision", async () => {
    const page = await t.storePage("from the page");
    await save(t.admin.id, page, "edited-elsewhere");
    await t.storePage("from the page, later", {}, page);
    // Somebody writes the draft with its files, as the CLI and an agent do.
    expectStatus(await t.putApp(t.admin.id, "edited-elsewhere", appFiles("from the CLI")), 200);

    // The surface is told that the draft is not the Page's any more.
    expect(await appOf(t.admin.id, page)).toMatchObject({
      draftRevision: 2,
      draftFromPage: false
    });
    const stale = await update(t.admin.id, page, "edited-elsewhere", 1);

    expectStatus(stale, 412);
    expect(refusalOf(stale)).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason: "revision_conflict", conflicts: [{ currentRevision: 2 }] }
    });
    expect((await shown(t.admin.id, "edited-elsewhere", "draft")).body).toContain("from the CLI");

    // Naming the revision that is there is the deliberate overwrite.
    expectStatus(await update(t.admin.id, page, "edited-elsewhere", 2), 200);
    expect((await shown(t.admin.id, "edited-elsewhere", "draft")).body).toContain(
      "from the page, later"
    );
    expect(await appOf(t.admin.id, page)).toMatchObject({ draftRevision: 3, draftFromPage: true });
  });

  it("commits the update to the App's repository on the commit of the draft it replaces", async () => {
    const page = await t.storePage("committed once");
    const app = await save(t.admin.id, page, "committed");
    await t.storePage("committed twice", {}, page);

    expectStatus(await update(t.admin.id, page, "committed", 1), 200);

    const [first, second] = await revisions("committed");
    expect(first?.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(second?.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(second?.commit).not.toBe(first?.commit);
    expect(await stored("committed")).toMatchObject({ revision: 2, commit: second?.commit });
    // The ledger: the bundle of the save, and one on top of it that ends at the update's commit.
    expect(
      await t.stores.configAssets.listAssetRepoBundles({ clientInstanceId, assetId: app.id })
    ).toMatchObject([
      { kind: "full", tipCommit: first?.commit },
      { kind: "incremental", tipCommit: second?.commit, prerequisiteCommit: first?.commit }
    ]);
  });

  it("lets one of two updates at the same revision through and leaves no files of the other", async () => {
    const page = await t.storePage("asked for twice");
    const app = await save(t.admin.id, page, "twice");
    await t.storePage("asked for twice, later", {}, page);

    const answers = await Promise.all([
      update(t.admin.id, page, "twice", 1),
      update(t.admin.id, page, "twice", 1)
    ]);

    expect(answers.filter((answer) => answer.statusCode === 200)).toHaveLength(1);
    // The files of an App are a repository, and the two updates make the same commit. The one
    // that comes second is refused where it is met: at the bundle the first named, at the
    // draft that moved, or at the revision.
    const refused = answers.find((answer) => answer.statusCode !== 200);
    expect(["VALIDATION_FAILED", "CONFLICT", "REVISION_CONFLICT"]).toContain(
      refused && refusalOf(refused).code
    );
    expect((await revisions("twice")).map((revision) => revision.revision)).toEqual([1, 2]);
    // Two file sets: the one of the save and the one of the update that was let through.
    const fileSets = new Set(
      t
        .objectKeys(app.id)
        .filter((key) => !key.endsWith(".bundle"))
        .map((key) => key.split("/").slice(0, 3).join("/"))
    );
    expect(fileSets.size).toBe(2);
  });
});
