import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AssetRepoCommitRunner } from "@work-shape/catalyst-server";
import { isOperationRunId, isPageId, readObjectBytes } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  setupAppInstance,
  sha256,
  type AppInstance,
  type AppInstanceOptions
} from "./support/app-instance";
import { testGit } from "./support/asset-repo";
import { FAR_FUTURE } from "./support/asset-repo-ledger";
import { MemoryObjectStorage } from "./support/memory-object-storage";

// Naming a Page as an App through the operation, with the worker of the executor and the git
// of this machine: the App has a repository whose one commit holds the files of the Page,
// revision 1 names that commit, and a call that does not get that far leaves nothing a reader
// can see.

const createdSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  revision: z.number(),
  fileSetId: z.string()
});
const readSchema = z.looseObject({
  revision: z.number(),
  files: z.array(z.looseObject({ path: z.string(), sha256: z.string(), text: z.string() }))
});

/** The id git gives a file with these bytes. */
const blobId = (content: string) => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

/** A store that says which assets it was handed files of, and fails the puts of bundles on demand. */
class WatchedStorage extends MemoryObjectStorage {
  failing = false;
  readonly assetIds = new Set<string>();
  override async put(...args: Parameters<MemoryObjectStorage["put"]>): Promise<void> {
    const [, assetId] = /^assets\/([^/]+)\//u.exec(args[0]) ?? [];
    if (assetId !== undefined) {
      this.assetIds.add(assetId);
    }
    if (this.failing && args[0].endsWith(".bundle")) {
      throw new Error("The store is not reachable");
    }
    await super.put(...args);
  }
}

describe("an App made from a Page", () => {
  let scratch: string;
  const open: AppInstance[] = [];
  const setup = async (options: AppInstanceOptions = {}) => {
    const t = await setupAppInstance(options);
    open.push(t);
    return t;
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "app-from-page-test-"));
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const create = (t: AppInstance, page: { conversationId: string; pageId: string }, name: string) =>
    t.call(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name, title: "Offers 2026", workspaceId: t.workspaceId },
      headers: { "x-correlation-id": randomUUID() }
    });
  const stored = (t: AppInstance, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const ledger = (t: AppInstance, assetId: string) =>
    t.stores.configAssets.listAssetRepoBundles({ clientInstanceId, assetId });
  const bundleKeys = (t: AppInstance) => t.objects.keys().filter((key) => key.endsWith(".bundle"));
  /** The save a call began, found by the run of the call and the asset it stored files for. */
  const saveOf = async (
    t: AppInstance,
    objects: WatchedStorage,
    response: Awaited<ReturnType<AppInstance["call"]>>
  ) => {
    const operationRunId = response.headers["operation-run-id"];
    const [assetId, ...others] = [...objects.assetIds];
    if (
      typeof operationRunId !== "string" ||
      !isOperationRunId(operationRunId) ||
      assetId === undefined ||
      others.length > 0
    ) {
      throw new Error("The call names no run, or stored files for no asset or for several");
    }
    return t.stores.configAssets.getAssetRepoSave({ clientInstanceId, assetId, operationRunId });
  };
  const events = async (t: AppInstance, type: string) =>
    (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).filter(
      (event) => event.type === type
    );

  /** The files of one commit, read with git from the bundles of the ledger. */
  async function filesOf(t: AppInstance, assetId: string, commit: string) {
    const repository = await mkdtemp(join(scratch, "repo-"));
    await testGit(repository, ["init", "--bare", "--quiet"]);
    for (const [index, bundle] of (await ledger(t, assetId)).entries()) {
      const file = join(scratch, `${randomUUID()}-${index}.bundle`);
      const bytes = await readObjectBytes(t.objects, bundle.objectKey);
      expect(sha256(bytes)).toBe(bundle.sha256);
      await writeFile(file, bytes);
      await testGit(repository, ["bundle", "unbundle", file]);
    }
    // Each line is `<mode> blob <id>\t<path>`: the id is git's own hash of the file's bytes.
    const listed = (await testGit(repository, ["ls-tree", "-r", commit])).split("\n");
    return {
      files: Object.fromEntries(
        listed.map((line) => {
          const [entry = "", path = ""] = line.split("\t");
          return [path, entry.split(" ")[2]];
        })
      ),
      commits: (await testGit(repository, ["rev-list", "--count", commit])).trim(),
      tree: await testGit(repository, ["rev-parse", `${commit}^{tree}`])
    };
  }

  it("has a repository whose one commit holds exactly the files of the Page, and revision 1 names it", async () => {
    const t = await setup();
    const page = await t.storePage("from a page");

    const response = await create(t, page, "offers");

    expectStatus(response, 200);
    const app = createdSchema.parse(response.json());
    expect(app).toMatchObject({ name: "offers", revision: 1 });

    // The App and its revision 1, read back.
    const asset = await stored(t, "offers");
    const revision = await t.stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      kind: "app",
      name: "offers",
      revision: 1
    });
    // The person chose the name in Save as app: it is theirs, as a rename makes it.
    expect(asset).toMatchObject({
      id: app.id,
      revision: 1,
      fileSetId: app.fileSetId,
      personTitle: "Offers 2026"
    });
    expect(revision).toMatchObject({ revision: 1, operation: "create", fileSetId: app.fileSetId });
    expect(revision?.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(asset).toMatchObject({ commit: revision?.commit, tree: revision?.tree });
    const read = readSchema.parse(
      (
        await t.expectOk(t.admin.id, "assets.get", {
          params: { kind: "app", name: "offers" },
          query: { workspaceId: t.workspaceId, files: "true" }
        })
      ).json()
    );

    // The repository: one bundle, part of the ledger, and one commit without a parent.
    const bundles = await ledger(t, app.id);
    expect(bundles).toMatchObject([{ kind: "full", tipCommit: revision?.commit }]);
    expect(bundleKeys(t)).toEqual(bundles.map((bundle) => bundle.objectKey));
    const commit = await filesOf(t, app.id, revision?.commit ?? "");
    expect(commit.commits).toBe("1");
    expect(commit.tree).toBe(revision?.tree);
    // Exactly the source files of the Page, byte for byte: no built file and nothing else.
    const source = isPageId(page.pageId)
      ? await t.stores.pages.getPageFileSet({ clientInstanceId, pageId: page.pageId })
      : undefined;
    const ofPage = Object.fromEntries(
      (source?.sourceFiles ?? []).map((file) => [file.path, file.sha256])
    );
    expect(Object.keys(ofPage).sort()).toEqual(["app.yaml", "index.html"]);
    expect(Object.fromEntries(read.files.map((file) => [file.path, file.sha256]))).toEqual(ofPage);
    expect(commit.files).toEqual(
      Object.fromEntries(read.files.map((file) => [file.path, blobId(file.text)]))
    );

    // The App's own event: asset, revision and commit, and no content.
    const created = await events(t, "app.created");
    expect(created.map((event) => event.metadata)).toEqual([
      {
        kind: "app",
        name: "offers",
        assetId: app.id,
        workspaceId: t.workspaceId,
        revision: 1,
        commit: revision?.commit,
        operationRunId: response.headers["operation-run-id"]
      }
    ]);

    // A write of the App's files after it adds a commit on the first one.
    const second = await t.putApp(t.admin.id, "offers", appFiles("second"));
    expectStatus(second, 200);
    expect(fileWriteSchema.parse(second.json()).revision).toBe(2);
    const next = await stored(t, "offers");
    expect(next?.commit).not.toBe(revision?.commit);
    expect(await ledger(t, app.id)).toMatchObject([
      { kind: "full" },
      { kind: "incremental", tipCommit: next?.commit, prerequisiteCommit: revision?.commit }
    ]);
    expect((await filesOf(t, app.id, next?.commit ?? "")).commits).toBe("2");
  });

  it("leaves nothing a reader can see when the put of the bundle fails, and the sweeper clears the save", async () => {
    const objects = new WatchedStorage();
    const t = await setup({ objects });
    const page = await t.storePage("never an app");
    objects.failing = true;

    const response = await create(t, page, "lost");

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(await stored(t, "lost")).toBeUndefined();
    expect(await events(t, "app.created")).toEqual([]);
    const listed = await t.expectOk(t.admin.id, "assets.list", {
      params: { kind: "app" },
      query: { workspaceId: t.workspaceId }
    });
    expect(z.object({ items: z.array(z.unknown()) }).parse(listed.json()).items).toEqual([]);
    // Nothing of the App is in the store: the copy of the files went with the refusal, and no
    // bundle was put.
    expect(t.objects.keys().filter((key) => key.startsWith("assets/"))).toEqual([]);
    // The save is a pending row that names the bundle it would have put.
    const pending = await saveOf(t, objects, response);
    expect(pending).toMatchObject({ state: "pending" });
    expect(pending?.bundle?.objectKey).toMatch(/\.bundle$/u);

    const removed: string[] = [];
    const swept = await t.stores.configAssets.sweepAssetRepoSaves({
      olderThan: FAR_FUTURE,
      limit: 10,
      async removeObject(object) {
        removed.push(object.objectKey);
        await t.objects.delete(object.objectKey);
      }
    });
    expect(swept).toEqual({ swept: 1, removed: 1 });
    expect(removed).toEqual([pending?.bundle?.objectKey]);
    expect(await saveOf(t, objects, response)).toBeUndefined();

    // The name is free: the same Page becomes the App once the store takes the bundle.
    objects.failing = false;
    expectStatus(await create(t, page, "lost"), 200);
    expect((await stored(t, "lost"))?.commit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("writes nothing live when the instance refuses what the manifest names", async () => {
    const objects = new WatchedStorage();
    const t = await setup({ objects, modules: { connections: { enabled: true } } });
    const page = await t.storePage("names a connection", { connections: ["crm"] });

    const response = await create(t, page, "wired");

    expectStatus(response, 422);
    expect(JSON.stringify(errorSchema.parse(response.json()).error)).toContain(
      "names the Connection 'crm', which does not exist on this instance"
    );
    expect(await stored(t, "wired")).toBeUndefined();
    expect(await events(t, "app.created")).toEqual([]);
    // The commit was made in the container and is a pending bundle no revision names.
    expect(await saveOf(t, objects, response)).toMatchObject({ state: "pending" });
    expect(await ledger(t, [...objects.assetIds][0] ?? "")).toEqual([]);
    expect(
      t.objects.keys().filter((key) => key.startsWith("assets/") && !key.endsWith(".bundle"))
    ).toEqual([]);
  });

  it("writes nothing when the command refuses the tree in the container", async () => {
    const refusing: AssetRepoCommitRunner = async () => ({
      status: "refused",
      code: "path_refused",
      path: "index.html",
      message: "'index.html' is not a path a repository takes."
    });
    const t = await setup({ commits: refusing });
    const page = await t.storePage("refused");

    const response = await create(t, page, "refused");

    expectStatus(response, 422);
    expect(errorSchema.parse(response.json()).error).toMatchObject({
      message: "'index.html' is not a path a repository takes.",
      details: { reason: "path_refused", path: "index.html" }
    });
    expect(await stored(t, "refused")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.startsWith("assets/"))).toEqual([]);
  });

  it("refuses with the runner image named where it is older than the release", async () => {
    const outdated: AssetRepoCommitRunner = async () => ({
      status: "failed",
      reason: "command_missing",
      message:
        "The runner image of this instance has no 'catalyst-asset-repo'. It is older than the release that keeps repositories: a problem of the platform, not of the request, solved by rolling out the runner image of this release."
    });
    const old = await setup({ commits: outdated });
    const refused = await create(old, await old.storePage("old image"), "old");

    expectStatus(refused, 409);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      message: expect.stringMatching(
        /^The runner image of this instance has no 'catalyst-asset-repo'/u
      ),
      details: { reason: "runner_image_outdated" }
    });
    expect(await stored(old, "old")).toBeUndefined();
  });

  it("refuses with a reason an operator can act on when the worker's disk is full", async () => {
    const full: AssetRepoCommitRunner = async () => ({
      status: "refused",
      code: "no_space",
      message: "The server has too little free disk space for this save."
    });
    const t = await setup({ commits: full });

    const refused = await create(t, await t.storePage("no room"), "full");

    expectStatus(refused, 409);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      message: "The server has too little free disk space for this save.",
      details: { reason: "no_space" }
    });
    expect(await stored(t, "full")).toBeUndefined();
  });

  it("says what to do when the history of the App is at its limit", async () => {
    const t = await setup({
      commits: async () => ({
        status: "refused",
        code: "history_too_large",
        message: "The stored history of this asset has reached the limit."
      })
    });

    const refused = await create(t, await t.storePage("long history"), "long");

    expectStatus(refused, 422);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      message:
        "The stored history of this app has reached the limit of 100 MiB. Nothing was saved. Until history can be shortened, the way out is a new app from the current files.",
      details: { reason: "history_too_large" }
    });
  });

  it("refuses on an instance where no worker takes commits", async () => {
    const idle = await setup({ commits: false, worker: false });
    const unserved = await create(idle, await idle.storePage("no worker"), "idle");

    expectStatus(unserved, 409);
    expect(errorSchema.parse(unserved.json()).error).toMatchObject({
      message: expect.stringMatching(/^No workspace command worker takes commits to repositories/u),
      details: { reason: "commit_unavailable" }
    });
    expect(await stored(idle, "idle")).toBeUndefined();
  });
});
