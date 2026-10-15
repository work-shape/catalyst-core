import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appInterfacePath } from "@work-shape/catalyst-api-contract";
import { createAppAssetKind } from "@work-shape/catalyst-server";
import {
  ASSET_GET_FILES_MAX_BYTES,
  ASSET_PUT_FILES_MAX_BYTES,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  ROLE_DEFAULT_ACTIONS,
  WORKSPACE_MEMBER_ACTIONS,
  asClientInstanceId,
  asUserId,
  defineAssetKind,
  evaluateAccess,
  liveRevisionId,
  type AccessHolder,
  type PersistedAccess
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, setupAppInstance, type AppInstance } from "./support/app-instance";
import { createNoticeKind, noticeSchema } from "./support/notice-kind";

// The two things a kind says about its revisions: which one is live, and what one holds. The
// kind `app` is the first that has a draft beside the published revision and files beside the
// config; a made-up kind proves the published pointer belongs to the registry, not to Apps.

const pointersSchema = z.looseObject({
  revision: z.number(),
  draftRevision: z.number().optional(),
  publishedRevision: z.number().optional()
});
const writeSchema = z.looseObject({ version: z.number(), revision: z.number() });
const contextSchema = z.looseObject({
  kinds: z.array(
    z.looseObject({
      kind: z.string(),
      lifecycle: z.string(),
      representation: z.string(),
      actions: z.record(z.string(), z.string()),
      manifestFile: z.string().optional(),
      limits: z.record(z.string(), z.number()).optional()
    })
  ),
  actions: z.array(z.string())
});
const effectiveSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      action: z.string(),
      scopeKind: z.string(),
      scopeId: z.string().optional(),
      source: z.string()
    })
  )
});

describe("the lifecycle and the representation of an asset kind", () => {
  it("defaults a kind to an active revision that is its config", () => {
    const app = createAppAssetKind();

    expect({
      lifecycle: app.lifecycle,
      representation: app.representation,
      manifestFile: app.manifestFile,
      owners: app.owners,
      actions: app.actions
    }).toEqual({
      lifecycle: "draft_published",
      representation: "files",
      manifestFile: "app.yaml",
      owners: ["workspace"],
      actions: {
        read: "app.read",
        write: "app.write",
        delete: "app.delete",
        publish: "app.publish",
        approve: "app.approve",
        use: "app.use"
      }
    });
    const plain = defineAssetKind({
      kind: "plain",
      plural: "plains",
      schema: noticeSchema,
      nameRule: { pattern: /^[a-z]+$/u, maxLength: 10, description: "letters" },
      actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" },
      validate: () => [],
      summarize: (plain) => ({ name: plain.name, title: plain.text })
    });
    expect({
      lifecycle: plain.lifecycle,
      representation: plain.representation,
      owners: plain.owners,
      manifestFile: plain.manifestFile
    }).toEqual({
      lifecycle: "active",
      representation: "config",
      owners: ["instance"],
      manifestFile: undefined
    });
  });

  it("refuses a kind with a published revision and no publish right, and files without a manifest file", () => {
    const base = {
      kind: "broken",
      plural: "brokens",
      schema: noticeSchema,
      nameRule: { pattern: /^[a-z]+$/u, maxLength: 10, description: "letters" },
      actions: { read: "app.read", write: "app.write", delete: "app.delete" },
      validate: () => [],
      summarize: (broken: { name: string; text: string }) => ({
        name: broken.name,
        title: broken.text
      })
    };

    expect(() => defineAssetKind({ ...base, lifecycle: "draft_published" })).toThrow(
      "names no publish action"
    );
    expect(() => defineAssetKind({ ...base, representation: "files" })).toThrow(
      "names no manifest file"
    );
  });

  it("says how a kind that holds files keeps them, and the App keeps a repository", () => {
    const base = {
      kind: "notice",
      plural: "notices",
      schema: noticeSchema,
      nameRule: { pattern: /^[a-z]+$/u, maxLength: 10, description: "letters" },
      actions: { read: "app.read", write: "app.write", delete: "app.delete" },
      validate: () => [],
      summarize: (notice: { name: string; text: string }) => ({
        name: notice.name,
        title: notice.text
      })
    };
    const files = { representation: "files", manifestFile: "notice.yaml" } as const;
    expect(defineAssetKind(base).content).toBeUndefined();
    expect(defineAssetKind({ ...base, ...files }).content).toBe("file_set");
    expect(defineAssetKind({ ...base, ...files, content: "repository" }).content).toBe(
      "repository"
    );
    expect(() => defineAssetKind({ ...base, content: "repository" })).toThrow("holds no files");
    expect(createAppAssetKind().content).toBe("repository");
  });

  it("answers the active revision of an active kind and the published one of a kind with a draft", () => {
    const active = { lifecycle: "active" } as const;
    const drafted = { lifecycle: "draft_published" } as const;

    expect(liveRevisionId({ activeRevisionId: "rev_2" }, active)).toBe("rev_2");
    // A published pointer on an active kind is not read: its newest write is live.
    expect(
      liveRevisionId({ activeRevisionId: "rev_2", publishedRevisionId: "rev_1" }, active)
    ).toBe("rev_2");
    expect(liveRevisionId({ activeRevisionId: "rev_2" }, drafted)).toBeUndefined();
    expect(
      liveRevisionId({ activeRevisionId: "rev_2", publishedRevisionId: "rev_1" }, drafted)
    ).toBe("rev_1");
  });

  it("builds the path of an App in the interface from one function", () => {
    expect(appInterfacePath({ workspaceId: "ws_1", app: "offers", mode: "published" })).toBe(
      "/w/ws_1/apps/offers"
    );
    expect(appInterfacePath({ workspaceId: "ws_1", app: "offers", mode: "draft" })).toBe(
      "/w/ws_1/app-drafts/offers"
    );
  });
});

describe("the rights of an App", () => {
  const holder = (roles: string[]): AccessHolder => ({
    kind: "user",
    id: "user_1",
    clientInstanceId: asClientInstanceId("demo-local"),
    roles,
    permissionRefs: []
  });
  const app = (workspaceId: string) => ({ kind: "app", name: "offers", workspaceId });

  it("gives the administrator reading, writing, publishing and deleting on the whole instance", () => {
    for (const action of ["app.read", "app.write", "app.publish", "app.delete"] as const) {
      expect(ROLE_DEFAULT_ACTIONS.admin, action).toContain(action);
      expect(ROLE_DEFAULT_ACTIONS.user, action).not.toContain(action);
    }
  });

  it("reads a membership as the right to open what the workspace published, and as nothing more", () => {
    const member = { holderActive: true, grants: [], memberWorkspaceIds: ["ws_sales"] };
    const decide = (action: string, workspaceId: string, persisted: PersistedAccess = member) =>
      evaluateAccess({
        holder: holder(["user"]),
        persisted,
        action,
        resource: app(workspaceId)
      });

    expect(WORKSPACE_MEMBER_ACTIONS).toEqual(["app.use"]);
    expect(decide("app.use", "ws_sales")).toEqual({ allowed: true, source: "membership" });
    expect(decide("app.use", "ws_other")).toEqual({ allowed: false, reason: "no_grant" });
    for (const action of ["app.read", "app.write", "app.publish", "app.delete"]) {
      expect(decide(action, "ws_sales"), action).toEqual({ allowed: false, reason: "no_grant" });
    }
    // Asked about the instance as a whole, a membership answers nothing.
    expect(
      evaluateAccess({ holder: holder(["user"]), persisted: member, action: "app.use" })
    ).toEqual({ allowed: false, reason: "no_grant" });
    expect(decide("app.use", "ws_sales", { ...member, holderActive: false })).toEqual({
      allowed: false,
      reason: "holder_inactive"
    });
    // Somebody who holds no membership holds none through the field being absent.
    expect(decide("app.use", "ws_sales", { holderActive: true, grants: [] })).toEqual({
      allowed: false,
      reason: "no_grant"
    });
  });

  it("lets a deny on the App refuse a member", () => {
    const decision = evaluateAccess({
      holder: holder(["user"]),
      persisted: {
        holderActive: true,
        memberWorkspaceIds: ["ws_sales"],
        grants: [
          {
            id: "grant_1",
            clientInstanceId: asClientInstanceId("demo-local"),
            holderKind: "user",
            holderId: "user_1",
            action: "app.use",
            effect: "deny",
            scopeKind: "asset",
            scopeId: "cfga_1",
            grantedBy: asUserId("user_admin"),
            createdAt: new Date(0).toISOString()
          }
        ]
      },
      action: "app.use",
      resource: { ...app("ws_sales"), assetId: "cfga_1" }
    });

    expect(decision).toEqual({ allowed: false, reason: "denied" });
  });
});

describe("a kind with a draft and a published revision on an instance", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({ furtherKinds: [createNoticeKind()] });
  });
  afterAll(async () => {
    await t.close();
  });

  const notice = (name: string, text: string) => ({
    params: { kind: "notice", name },
    payload: { config: { name, text } }
  });
  const stateVersion = async () =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version;
  const read = async (name: string) =>
    pointersSchema.parse(
      (await t.expectOk(t.admin.id, "assets.get", { params: { kind: "notice", name } })).json()
    );

  it("reports the lifecycle, the representation and the limits of a kind that holds files", async () => {
    const context = contextSchema.parse(
      (await t.expectOk(t.admin.id, "platform.context.get")).json()
    );
    const byKind = new Map(context.kinds.map((kind) => [kind.kind, kind]));

    expect(byKind.get("agent")).toMatchObject({ lifecycle: "active", representation: "config" });
    expect(byKind.get("agent")?.limits).toBeUndefined();
    expect(byKind.get("notice")).toMatchObject({
      lifecycle: "draft_published",
      representation: "config"
    });
    expect(byKind.get("app")).toMatchObject({
      lifecycle: "draft_published",
      representation: "files",
      manifestFile: "app.yaml",
      actions: { publish: "app.publish", use: "app.use" },
      limits: {
        FILE_SET_MAX_FILES,
        FILE_SET_MAX_FILE_BYTES,
        FILE_SET_MAX_TOTAL_BYTES,
        ASSET_PUT_FILES_MAX_BYTES,
        ASSET_GET_FILES_MAX_BYTES
      }
    });
    expect(context.actions).toEqual(expect.arrayContaining(["app.write", "app.publish"]));
  });

  it("moves only the draft pointer on a write and leaves the version of the asset set", async () => {
    const before = await stateVersion();

    const first = writeSchema.parse(
      (await t.expectOk(t.admin.id, "assets.put", notice("welcome", "one"))).json()
    );

    expect(first).toMatchObject({ revision: 1, version: before });
    expect(await stateVersion()).toBe(before);
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "notice",
      name: "welcome"
    });
    expect(stored?.publishedRevisionId).toBeUndefined();
    expect(stored && liveRevisionId(stored, createNoticeKind())).toBeUndefined();
    expect(await read("welcome")).toMatchObject({ revision: 1, draftRevision: 1 });
    expect((await read("welcome")).publishedRevision).toBeUndefined();

    // An agent written beside it still moves the version: only a draft leaves it.
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "helper" },
      payload: {
        config: {
          name: "helper",
          displayName: "Helper",
          instructions: "Help.",
          modelProviderId: "local",
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        }
      }
    });
    expect(await stateVersion()).toBe(before + 1);
  });

  it("publishes a numbered revision, goes back by publishing an earlier number, and numbers on after a discard", async () => {
    await t.expectOk(t.admin.id, "assets.put", notice("banner", "one"));
    const publish = (revision: number) =>
      t.call(t.admin.id, "assets.publish", {
        params: { kind: "notice", name: "banner" },
        payload: { revision }
      });

    expect((await publish(1)).json()).toEqual({ draftRevision: 1, publishedRevision: 1 });
    await t.expectOk(t.admin.id, "assets.put", notice("banner", "two"));
    expect(await read("banner")).toMatchObject({
      revision: 2,
      draftRevision: 2,
      publishedRevision: 1
    });
    expect((await publish(2)).json()).toEqual({
      draftRevision: 2,
      publishedRevision: 2,
      replacedRevision: 1
    });
    // The way back is a publish of the earlier number. The draft stays where it is.
    expect((await publish(1)).json()).toEqual({
      draftRevision: 2,
      publishedRevision: 1,
      replacedRevision: 2
    });
    await t.expectRefused(
      t.admin.id,
      "assets.publish",
      { params: { kind: "notice", name: "banner" }, payload: { revision: 9 } },
      { status: 404, code: "NOT_FOUND" }
    );
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "notice",
      name: "banner"
    });
    expect(stored?.publishedRevision).toBe(1);

    const discarded = await t.expectOk(t.admin.id, "assets.discard_draft", {
      params: { kind: "notice", name: "banner" },
      payload: { expectedRevision: 2 }
    });
    expect(discarded.json()).toEqual({ draftRevision: 1, publishedRevision: 1 });
    expect(await read("banner")).toMatchObject({ draftRevision: 1, publishedRevision: 1 });

    // Revision 2 exists, so the next write is 3: a number is never given twice.
    const next = writeSchema.parse(
      (await t.expectOk(t.admin.id, "assets.put", notice("banner", "three"))).json()
    );
    expect(next.revision).toBe(3);
    expect(await read("banner")).toMatchObject({ draftRevision: 3, publishedRevision: 1 });
  });

  it("refuses a discard before the first publish and against another draft", async () => {
    await t.expectOk(t.admin.id, "assets.put", notice("fresh", "one"));

    const never = await t.expectRefused(
      t.admin.id,
      "assets.discard_draft",
      { params: { kind: "notice", name: "fresh" }, payload: { expectedRevision: 1 } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(never.details).toMatchObject({ reason: "nothing_published" });
    await t.expectRefused(
      t.admin.id,
      "assets.discard_draft",
      { params: { kind: "notice", name: "fresh" }, payload: { expectedRevision: 4 } },
      { status: 412, code: "REVISION_CONFLICT" }
    );
    // Fails without the change: a discard that named no revision answered the schema's 422,
    // where every other write answers that the revision is required.
    const unnamed = await t.expectRefused(
      t.admin.id,
      "assets.discard_draft",
      { params: { kind: "notice", name: "fresh" }, payload: {} },
      { status: 428, code: "PRECONDITION_REQUIRED" }
    );
    expect(unnamed.details).toMatchObject({ reason: "precondition_required" });
    // Who may not write the notice is told that, and not that a revision is missing.
    await t.expectRefused(
      t.kai.id,
      "assets.discard_draft",
      { params: { kind: "notice", name: "fresh" }, payload: {} },
      { status: 403, code: "FORBIDDEN" }
    );
  });

  it("answers a revert with the publish that does it, and a publish of an active kind with why not", async () => {
    await t.expectOk(t.admin.id, "assets.put", notice("fixed", "one"));

    const revert = await t.expectRefused(
      t.admin.id,
      "assets.revert",
      {
        params: { kind: "notice", name: "fixed" },
        payload: { revision: 1, expectedRevision: 1 }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(revert.details).toMatchObject({ reason: "use_publish" });

    const active = await t.expectRefused(
      t.admin.id,
      "assets.publish",
      { params: { kind: "agent", name: "assistant" }, payload: { revision: 1 } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(active.details).toMatchObject({ reason: "no_draft" });
  });

  const syncAs = (userId: string, items: unknown[]) =>
    t.call(userId, "assets.sync", { payload: { namespace: "kai-", items } });
  const batchNotice = (text: string, expectedRevision: number | null) => ({
    type: "put",
    kind: "notice",
    config: { name: "kai-banner", text },
    expectedRevision
  });
  const storedBanner = async () =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "notice", name: "kai-banner" });

  // The draft moved in a batch before the change too. What fails without it is the last line:
  // a stale item was a 409 then.
  it("moves the draft in a batch and leaves the published revision and the version of the set", async () => {
    await t.createNamespace("kai-");
    const created = await syncAs(t.admin.id, [batchNotice("one", null)]);
    expect(created.statusCode, created.body).toBe(200);
    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "notice", name: "kai-banner" },
      payload: { revision: 1 }
    });
    const published = (await storedBanner())?.publishedRevisionId;
    const { version } = await t.stores.configAssets.getConfigAssetState({ clientInstanceId });

    const moved = await syncAs(t.admin.id, [batchNotice("two", 1)]);

    expect(moved.statusCode, moved.body).toBe(200);
    expect(await storedBanner()).toMatchObject({
      revision: 2,
      config: { text: "two" },
      publishedRevisionId: published
    });
    expect(published).toBeDefined();
    expect(await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).toMatchObject({
      version
    });
    // The draft is what a batch is made against, like every other write of the kind.
    expect((await syncAs(t.admin.id, [batchNotice("stale", 1)])).statusCode).toBe(412);
  });

  it("refuses an App as an item: its files are written one App at a time", async () => {
    const created = await t.putApp(t.admin.id, "batched", appFiles("one"));
    expect(created.statusCode, created.body).toBe(200);

    const refused = await syncAs(t.admin.id, [
      {
        type: "put",
        kind: "app",
        config: { name: "batched", title: "Batched", manifest: {} },
        expectedRevision: 1
      }
    ]);

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain("assets.put");
    expect(
      await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "batched" })
    ).toMatchObject({ revision: 1 });
  });

  it("shows a member's right to open the workspace's Apps with its source", async () => {
    const effective = async (holderId: string) =>
      effectiveSchema
        .parse(
          (
            await t.expectOk(t.admin.id, "permissions.effective", {
              query: { holderKind: "user", holderId }
            })
          ).json()
        )
        .items.filter((item) => item.action.startsWith("app."));

    // Every membership gives the right in its own workspace, the personal one included.
    expect(await effective(t.kai.id)).toContainEqual(
      expect.objectContaining({
        action: "app.use",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        source: "membership"
      })
    );
    expect((await effective(t.lena.id)).map((item) => item.scopeId)).not.toContain(t.workspaceId);
  });
});
