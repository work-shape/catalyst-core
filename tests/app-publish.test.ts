import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { isFileSetId } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  previewSchema,
  setupAppInstance,
  withScopes,
  type AppInstance
} from "./support/app-instance";
import type { TestCallInput, TestOperationName } from "./support/operations";

afterEach(() => vi.useRealTimers());

// An App from its first draft to the revision its workspace is served: who may write, who may
// publish, who is served which revision, and what a call leaves behind.

const createdSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  revision: z.number(),
  fileSetId: z.string()
});
const pointersSchema = z.object({
  draftRevision: z.number(),
  publishedRevision: z.number().optional(),
  replacedRevision: z.number().optional()
});

describe("an App with a draft and a published revision", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({ explicitCredentials: true });
  });
  afterAll(async () => {
    await t.close();
  });

  const preview = (userId: string, app: string, mode: "draft" | "published") =>
    t.call(userId, "apps.preview", { params: { app }, payload: { mode } });
  /** What a person is shown who opens the App in a mode. */
  const shown = async (userId: string, app: string, mode: "draft" | "published") => {
    const response = await preview(userId, app, mode);
    expectStatus(response, 200);
    const answer = previewSchema.parse(response.json());
    return { ...answer, document: await t.open(answer.url) };
  };
  const created = async (name: string, marker: string) => {
    const response = await t.putApp(t.admin.id, name, appFiles(marker));
    expectStatus(response, 200);
    return fileWriteSchema.parse(response.json());
  };
  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  /** One call with the runs and the audit rows it left. */
  const traced = async (userId: string, operation: TestOperationName, input: TestCallInput) => {
    const correlationId = randomUUID();
    const before = await t.stores.operationRuns.list({ clientInstanceId });
    const response = await t.call(userId, operation, {
      ...input,
      headers: { ...input.headers, "x-correlation-id": correlationId }
    });
    const runs = (await t.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => !before.some((earlier) => earlier.id === run.id)
    );
    const audit = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter((event) => event.correlationId === correlationId)
      .sort((left, right) => left.type.localeCompare(right.type));
    return { response, runs, audit };
  };

  it("refuses a member who may not write Apps, names the right and leaves an audit row", async () => {
    const page = await t.storePage("from a page");
    const payload = {
      ...page,
      name: "from-page",
      title: "From a Page",
      workspaceId: t.workspaceId
    };

    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    const refused = await traced(t.kai.id, "apps.create_from_page", { payload });

    expectStatus(refused.response, 403);
    expect(errorSchema.parse(refused.response.json()).error).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "app.write", reason: "no_grant" }
    });
    expect(refused.audit.map((event) => `${event.type}:${event.status}`)).toEqual([
      "operation.authorization_checked:denied",
      "operation.denied:denied"
    ]);
    expect(refused.runs.map((run) => run.denial)).toEqual([
      { kind: "forbidden", action: "app.write", reason: "no_grant" }
    ]);
    expect(await stored("from-page")).toBeUndefined();
  });

  it("saves a Page as an App with a draft and no published revision, from a copy of its files", async () => {
    const page = await t.storePage("from a page");
    const payload = { ...page, name: "offers", title: "Offers 2026", workspaceId: t.workspaceId };

    const response = await t.expectOk(t.admin.id, "apps.create_from_page", { payload });

    const app = createdSchema.parse(response.json());
    expect(app).toMatchObject({ name: "offers", workspaceId: t.workspaceId, revision: 1 });
    expect(await t.listed("offers")).toMatchObject({ revision: 1, draftRevision: 1 });
    expect((await t.listed("offers")).publishedRevision).toBeUndefined();
    const asset = await stored("offers");
    expect(asset).toMatchObject({
      id: app.id,
      scope: { kind: "workspace", workspaceId: t.workspaceId },
      fileSetId: app.fileSetId,
      config: { name: "offers", title: "Offers 2026" }
    });
    expect(asset?.publishedRevisionId).toBeUndefined();
    // The files are the App's own: below its prefix, beside the Page's.
    expect(t.objectKeys(app.id).length).toBeGreaterThan(0);
    const draft = await shown(t.admin.id, "offers", "draft");
    expect(draft).toMatchObject({
      fileSetId: app.fileSetId,
      revision: 1,
      interfacePath: `/w/${t.workspaceId}/app-drafts/offers`,
      document: { status: 200 }
    });
    expect(draft.document.body).toContain("from a page");
    // Nothing is published, so its users are served nothing yet.
    const unpublished = await preview(t.kai.id, "offers", "published");
    expectStatus(unpublished, 404);
    expect(errorSchema.parse(unpublished.json()).error.details).toEqual({
      reason: "not_published"
    });

    // The name is taken now, for a Page as for files.
    const again = await t.call(t.admin.id, "apps.create_from_page", { payload });
    expectStatus(again, 409);
    expect(errorSchema.parse(again.json()).error.details).toMatchObject({
      reason: "app_id_taken"
    });
  });

  it("keeps the App served after the conversation of its Page is deleted, and removes every file with the App", async () => {
    const page = await t.storePage("outlives its conversation");
    const app = createdSchema.parse(
      (
        await t.expectOk(t.admin.id, "apps.create_from_page", {
          payload: { ...page, name: "keeper", title: "Keeper", workspaceId: t.workspaceId }
        })
      ).json()
    );
    expectStatus(await t.publish(t.admin.id, "keeper", 1), 200);

    const deleted = await t.call(t.admin.id, "conversations.delete", {
      params: { conversationId: page.conversationId }
    });
    expect(deleted.statusCode).toBeLessThan(300);

    const served = await shown(t.kai.id, "keeper", "published");
    expect(served.document.status).toBe(200);
    expect(served.document.body).toContain("outlives its conversation");

    // A second revision, so the App holds more than one file set when it goes.
    const second = await t.putApp(t.admin.id, "keeper", appFiles("second"));
    expectStatus(second, 200);
    const fileSetIds = [app.fileSetId, fileWriteSchema.parse(second.json()).fileSetId];
    expect(t.objectKeys(app.id).length).toBeGreaterThan(0);

    const removed = await traced(t.admin.id, "assets.delete", {
      params: { kind: "app", name: "keeper" },
      payload: { expectedRevision: 2, workspaceId: t.workspaceId }
    });

    expectStatus(removed.response, 200);
    expect(await stored("keeper")).toBeUndefined();
    for (const fileSetId of fileSetIds) {
      expect(isFileSetId(fileSetId)).toBe(true);
      if (!isFileSetId(fileSetId)) continue;
      expect(
        await t.stores.pages.getAssetFileSet({ clientInstanceId, assetId: app.id, fileSetId })
      ).toBeUndefined();
      expect(
        await t.stores.pages.getServedFileSet({ clientInstanceId, fileSetId })
      ).toBeUndefined();
    }
    expect(t.objectKeys(app.id)).toEqual([]);
    expect((await t.open(served.url)).status).toBe(404);
    // What says that the App existed stays: the run of the delete and its audit row.
    expect(removed.runs).toHaveLength(1);
    expect(removed.audit.map((event) => event.type)).toContain("config_asset.deleted");
  });

  it("serves a member the published revision, moves with a publish and goes back with a publish of the earlier number", async () => {
    await created("catalog", "one");
    const first = await t.publish(t.admin.id, "catalog", 1);
    expectStatus(first, 200);
    expect(pointersSchema.parse(first.json())).toEqual({ draftRevision: 1, publishedRevision: 1 });

    const one = await shown(t.kai.id, "catalog", "published");
    expect(one).toMatchObject({
      revision: 1,
      interfacePath: `/w/${t.workspaceId}/apps/catalog`,
      document: { status: 200 }
    });
    expect(one.document.body).toContain("one");

    // A write moves the draft and nothing a member is served.
    const second = fileWriteSchema.parse(
      (await t.putApp(t.admin.id, "catalog", appFiles("two"))).json()
    );
    expect(second.revision).toBe(2);
    const still = await shown(t.kai.id, "catalog", "published");
    expect(still.fileSetId).toBe(one.fileSetId);
    expect((await shown(t.admin.id, "catalog", "draft")).document.body).toContain("two");

    const published = await traced(t.admin.id, "assets.publish", {
      params: { kind: "app", name: "catalog" },
      payload: { revision: 2, workspaceId: t.workspaceId }
    });
    expect(pointersSchema.parse(published.response.json())).toEqual({
      draftRevision: 2,
      publishedRevision: 2,
      replacedRevision: 1
    });
    expect(
      published.audit
        .filter((event) => event.type === "app.published")
        .map((event) => event.metadata)
    ).toEqual([
      expect.objectContaining({ kind: "app", name: "catalog", revision: 2, replacedRevision: 1 })
    ]);
    const two = await shown(t.kai.id, "catalog", "published");
    expect(two).toMatchObject({ revision: 2, fileSetId: second.fileSetId });
    expect(two.document.body).toContain("two");

    // An address for revision 2 that nobody has opened yet.
    const unopened = previewSchema.parse((await preview(t.kai.id, "catalog", "published")).json());
    const back = await t.publish(t.admin.id, "catalog", 1);
    expect(pointersSchema.parse(back.json())).toEqual({
      draftRevision: 2,
      publishedRevision: 1,
      replacedRevision: 2
    });
    const restored = await shown(t.kai.id, "catalog", "published");
    expect(restored).toMatchObject({ revision: 1, fileSetId: one.fileSetId });
    expect(restored.document.body).toContain("one");
    // An address for revision 2 stops with the publication it was for. One that was open is
    // checked again when its cached answer runs out.
    expect((await t.open(unopened.url)).status).toBe(404);
  });

  it("connects a draft only to the outside hosts its published revision lists, and a new App's draft to none", async () => {
    const connects = (policy: string) => /connect-src ([^;]*)/u.exec(policy)?.[1];
    const write = async (hosts: string[]) => {
      const response = await t.putApp(
        t.admin.id,
        "rates",
        appFiles("rates", { externalHosts: hosts })
      );
      expectStatus(response, 200);
      return fileWriteSchema.parse(response.json()).revision;
    };

    // Nothing is published, so nobody has looked at any host the draft lists.
    const first = await write(["api.example.com"]);
    const fresh = await shown(t.admin.id, "rates", "draft");
    expect(fresh.heldBackHosts).toEqual(["api.example.com"]);
    expect(connects(fresh.document.policy)).toBe("'none'");

    // The publish dialog names the host: from here on the published revision connects to it,
    // and so does a draft that is that revision.
    expectStatus(await t.publish(t.admin.id, "rates", first), 200);
    const live = await shown(t.kai.id, "rates", "published");
    expect(live.heldBackHosts).toEqual([]);
    expect(connects(live.document.policy)).toBe("https://api.example.com");
    expect(connects((await shown(t.admin.id, "rates", "draft")).document.policy)).toBe(
      "https://api.example.com"
    );

    // An agent adds a host to the draft. A stored manifest is the build's answer and is read
    // again: an entry that is no host name, or a name on the viewer's own network, never reaches
    // the policy, and a host listed twice is one host.
    const second = await write([
      "api.example.com",
      "collect.example.net",
      "x.test; script-src *",
      "printer.local",
      "collect.example.net"
    ]);
    const draft = await shown(t.admin.id, "rates", "draft");
    expect(draft.heldBackHosts).toEqual(["collect.example.net"]);
    expect(connects(draft.document.policy)).toBe("https://api.example.com");
    expect(draft.document.policy).not.toContain("script-src *");
    expect(connects((await shown(t.kai.id, "rates", "published")).document.policy)).toBe(
      "https://api.example.com"
    );

    // The host takes effect with the publish.
    expectStatus(await t.publish(t.admin.id, "rates", second), 200);
    const published = await shown(t.kai.id, "rates", "published");
    expect(connects(published.document.policy)).toBe(
      "https://api.example.com https://collect.example.net"
    );
    expect((await shown(t.admin.id, "rates", "draft")).heldBackHosts).toEqual([]);
  });

  it("refuses a publish to a writer without the publish right, with a session and with a key that holds write alone", async () => {
    await created("pricing", "one");
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
    const publish = {
      params: { kind: "app", name: "pricing" },
      payload: { revision: 1, workspaceId: t.workspaceId }
    };

    // Kai writes the App. Publishing it is another right.
    const written = await t.putApp(t.kai.id, "pricing", appFiles("by kai"));
    expectStatus(written, 200);
    const bySession = await traced(t.kai.id, "assets.publish", publish);
    expectStatus(bySession.response, 403);
    expect(errorSchema.parse(bySession.response.json()).error.details).toEqual({
      action: "app.publish",
      reason: "no_grant"
    });
    expect(bySession.audit.map((event) => event.type)).toContain("operation.denied");

    // A key of somebody who may publish, that was given the scope to write and not to publish.
    const writeOnly = withScopes("config_assets:read", "config_assets:write");
    const byKeyWrite = await t.putApp(t.admin.id, "pricing", appFiles("by key"), writeOnly);
    expectStatus(byKeyWrite, 200);
    const byKey = await t.call(t.admin.id, "assets.publish", { ...publish, ...writeOnly });
    expectStatus(byKey, 403);
    expect(errorSchema.parse(byKey.json()).error.message).toContain("config_assets:publish");
    expect((await stored("pricing"))?.publishedRevisionId).toBeUndefined();

    const withPublish = await t.call(t.admin.id, "assets.publish", {
      ...publish,
      ...withScopes("config_assets:publish")
    });
    expectStatus(withPublish, 200);
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
  });

  it("lists the draft ahead of the published revision after a write and beside it after a discard", async () => {
    await created("notes", "one");
    await t.publish(t.admin.id, "notes", 1);
    expect(await t.listed("notes")).toMatchObject({
      revision: 1,
      draftRevision: 1,
      publishedRevision: 1
    });

    const second = fileWriteSchema.parse(
      (await t.putApp(t.admin.id, "notes", appFiles("two"))).json()
    );
    expect(await t.listed("notes")).toMatchObject({
      revision: 2,
      draftRevision: 2,
      publishedRevision: 1
    });

    const discarded = await t.expectOk(t.admin.id, "assets.discard_draft", {
      params: { kind: "app", name: "notes" },
      payload: { expectedRevision: 2, workspaceId: t.workspaceId }
    });
    expect(pointersSchema.parse(discarded.json())).toEqual({
      draftRevision: 1,
      publishedRevision: 1
    });
    expect(await t.listed("notes")).toMatchObject({
      revision: 1,
      draftRevision: 1,
      publishedRevision: 1
    });
    expect((await shown(t.admin.id, "notes", "draft")).document.body).toContain("one");

    // Revision 2 stays a revision of the App, so the next write is the third.
    const third = fileWriteSchema.parse(
      (await t.putApp(t.admin.id, "notes", appFiles("three"))).json()
    );
    expect(third.revision).toBe(3);
    expect(third.fileSetId).not.toBe(second.fileSetId);
    expect(await t.listed("notes")).toMatchObject({ draftRevision: 3, publishedRevision: 1 });
    // And the discarded revision can still be published by its number.
    const old = await t.publish(t.admin.id, "notes", 2);
    expect(pointersSchema.parse(old.json())).toMatchObject({ publishedRevision: 2 });
    expect((await shown(t.kai.id, "notes", "published")).document.body).toContain("two");
  });

  it("refuses somebody outside the workspace, a member's token on another file set, and a member the draft", async () => {
    await created("inside", "inside");
    await created("other", "other");
    await t.publish(t.admin.id, "inside", 1);
    await t.publish(t.admin.id, "other", 1);

    const outside = await preview(t.lena.id, "inside", "published");
    expectStatus(outside, 403);
    expect(errorSchema.parse(outside.json()).error.details).toEqual({
      action: "app.use",
      reason: "no_grant"
    });
    // An App that does not exist answers the same to somebody without the right.
    expectStatus(await preview(t.lena.id, "no-such-app", "published"), 403);

    const draft = await preview(t.kai.id, "inside", "draft");
    expectStatus(draft, 403);
    expect(errorSchema.parse(draft.json()).error.details).toEqual({
      action: "app.write",
      reason: "no_grant"
    });

    const mine = await shown(t.kai.id, "inside", "published");
    const theirs = await shown(t.kai.id, "other", "published");
    expect(mine.document.status).toBe(200);
    const token = mine.url.split("/")[3];
    const crossed = await t.open(`/app-content/${theirs.fileSetId}/${token}/`);
    expect(crossed.status).toBe(404);
    expect(crossed.body).not.toContain("other");

    // A draft that is ahead of the publication is not what a member's token opens either.
    const ahead = fileWriteSchema.parse(
      (await t.putApp(t.admin.id, "inside", appFiles("unpublished"))).json()
    );
    const draftAddress = await t.open(`/app-content/${ahead.fileSetId}/${token}/`);
    expect(draftAddress.status).toBe(404);
    expect(draftAddress.body).not.toContain("unpublished");
    const writer = await shown(t.admin.id, "inside", "draft");
    expect(writer.document.body).toContain("unpublished");
  });

  it("leaves one Operation Run per write, publish and discard, and no file content in a run", async () => {
    const marker = `content-${randomUUID()}`;
    const key = `put-${randomUUID()}`;
    const put = {
      params: { kind: "app", name: "ledger" },
      payload: { files: appFiles(marker), workspaceId: t.workspaceId, expectedRevision: null },
      headers: { "idempotency-key": key }
    };

    const written = await traced(t.admin.id, "assets.put", put);
    expectStatus(written.response, 200);
    const answer = fileWriteSchema.parse(written.response.json());
    expect(written.runs).toHaveLength(1);
    expect(written.runs[0]).toMatchObject({ operation: "assets.put", status: "done" });
    expect(JSON.stringify(written.runs)).not.toContain(marker);
    // What the run keeps of the files: the file set and the hashes.
    expect(written.runs[0]?.output?.value).toMatchObject({
      fileSetId: answer.fileSetId,
      files: answer.files
    });
    const idempotent = await t.stores.operationRuns.findByIdempotencyKey({
      clientInstanceId,
      actor: { kind: "user", id: t.admin.id },
      idempotencyKey: key
    });
    expect(idempotent?.id).toBe(written.runs[0]?.id);
    expect(JSON.stringify(idempotent)).not.toContain(marker);
    expect(JSON.stringify(written.audit)).not.toContain(marker);

    // The same call again is answered from the run and writes nothing.
    const runsBefore = (await t.stores.operationRuns.list({ clientInstanceId })).length;
    const replayed = await t.instance.call("assets.put", {
      ...put,
      headers: { ...put.headers, "x-test-user": t.admin.id }
    });
    expect(fileWriteSchema.parse(replayed.json())).toEqual(answer);
    expect(await t.stores.operationRuns.list({ clientInstanceId })).toHaveLength(runsBefore);
    expect((await t.listed("ledger")).revision).toBe(1);

    const published = await traced(t.admin.id, "assets.publish", {
      params: { kind: "app", name: "ledger" },
      payload: { revision: 1, workspaceId: t.workspaceId }
    });
    await t.putApp(t.admin.id, "ledger", appFiles("two"));
    const discarded = await traced(t.admin.id, "assets.discard_draft", {
      params: { kind: "app", name: "ledger" },
      payload: { expectedRevision: 2, workspaceId: t.workspaceId }
    });
    expect(
      [published, discarded].map(({ runs }) => runs.map((run) => [run.operation, run.status]))
    ).toEqual([[["assets.publish", "done"]], [["assets.discard_draft", "done"]]]);
  });

  it("creates the same revision through a person's session and through a person's token", async () => {
    const shapeOf = async (name: string, headers: Record<string, string>) => {
      const { response, runs } = await traced(t.admin.id, "assets.put", {
        params: { kind: "app", name },
        payload: { files: appFiles("same"), workspaceId: t.workspaceId },
        headers
      });
      expectStatus(response, 200);
      const answer = fileWriteSchema.parse(response.json());
      const asset = await stored(name);
      return {
        origin: runs.map((run) => run.origin.kind),
        shape: {
          revision: answer.revision,
          files: answer.files,
          scope: asset?.scope,
          status: asset?.status,
          published: asset?.publishedRevisionId,
          config: { ...asset?.config, name: "" }
        }
      };
    };

    const bySession = await shapeOf("by-session", {});
    const byToken = await shapeOf("by-token", { authorization: "Bearer person-token" });

    // A token that is no API credential is the person, as a session is: only a personal API
    // key or a service principal's credential is the CLI.
    expect([bySession.origin, byToken.origin]).toEqual([["user"], ["user"]]);
    expect(byToken.shape).toEqual(bySession.shape);
  });
});
