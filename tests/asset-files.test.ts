import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_BUILD_WAIT_MS, ASSET_PUT_BODY_LIMIT_BYTES } from "@vivd-catalyst/chat-server";
import { ASSET_PUT_FILES_MAX_BYTES, isFileSetId } from "@vivd-catalyst/core";
import { SERVICE_HEADER, clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  previewSchema,
  setupAppInstance,
  sha256,
  type AppFile,
  type AppInstance
} from "./support/app-instance";
import { fileRoute, reactManifest, rootRoute } from "./support/page-build";

// A write that carries files: the whole source set in one call, built by the build of Pages,
// stored as one immutable file set of the asset. What a call may hold, and what stays when the
// build refuses it or does not end.

const issueSchema = z.looseObject({ file: z.string().optional(), line: z.number().optional() });
const refusalOf = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;
const stored = (t: AppInstance, name: string) =>
  t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
const fileSetOf = async (t: AppInstance, assetId: string, fileSetId: string) => {
  if (!isFileSetId(fileSetId)) throw new Error(`'${fileSetId}' is no file set id`);
  return t.stores.pages.getAssetFileSet({ clientInstanceId, assetId, fileSetId });
};
/** A write without the revision the harness would add: the call that creates. */
const create = (t: AppInstance, name: string, payload: Record<string, unknown>) =>
  t.instance.call("assets.put", {
    params: { kind: "app", name },
    payload,
    headers: { "x-test-user": t.admin.id }
  });

describe("an App written from files and built as a Page is built", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({ build: "sandbox" });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  const reactApp = (routes: Record<string, string>): AppFile[] => [
    { path: "app.yaml", text: reactManifest },
    { path: "src/routes/__root.tsx", text: rootRoute },
    ...Object.entries(routes).map(([name, text]) => ({ path: `src/routes/${name}`, text }))
  ];

  it("creates an App without a Page, and answers the paths and hashes that were put", async () => {
    const files = reactApp({ "index.tsx": fileRoute("/", "<p>Offers</p>") });

    const response = await create(t, "built", { files, workspaceId: t.workspaceId });

    expectStatus(response, 200);
    const answer = fileWriteSchema.parse(response.json());
    const put = files
      .map((file) => ({
        path: file.path,
        sha256: sha256("text" in file ? file.text : ""),
        bytes: Buffer.byteLength("text" in file ? file.text : "")
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(answer.revision).toBe(1);
    expect([...answer.files].sort((left, right) => left.path.localeCompare(right.path))).toEqual(
      put
    );

    // The same paths and hashes are what the App's revision holds, row and object.
    const asset = await stored(t, "built");
    expect(asset).toMatchObject({
      revision: 1,
      fileSetId: answer.fileSetId,
      scope: { kind: "workspace", workspaceId: t.workspaceId },
      config: { name: "built", title: "Demo Page", manifest: { id: "demo-page" } }
    });
    expect(asset?.publishedRevisionId).toBeUndefined();
    const fileSet = await fileSetOf(t, asset?.id ?? "", answer.fileSetId);
    expect(fileSet?.owner).toEqual({ kind: "asset", id: asset?.id });
    expect(
      fileSet?.sourceFiles
        .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
        .sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual(put);
    const prefix = `assets/${asset?.id}/${answer.fileSetId}/`;
    for (const file of put) {
      expect(sha256(t.objects.bytes(`${prefix}src/${file.path}`)), file.path).toBe(file.sha256);
    }
    expect(fileSet?.builtFiles.map((file) => file.path)).toContain("index.html");
    expect(t.objectKeys(asset?.id ?? "").every((key) => key.startsWith(prefix))).toBe(true);

    // What was built is what a writer is shown.
    const preview = await t.expectOk(t.admin.id, "apps.preview", {
      params: { app: "built" },
      payload: { mode: "draft" }
    });
    const document = await t.open(previewSchema.parse(preview.json()).url);
    expect(document.status).toBe(200);
    expect(document.body).toContain("<script");
  }, 120_000);

  it("answers a syntax error with its file and line and leaves the draft as it was", async () => {
    const before = await stored(t, "built");
    const keys = t.objectKeys(before?.id ?? "");
    const broken = reactApp({
      "index.tsx": fileRoute("/"),
      "history.tsx": `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/history")({
  component: () => <p>History</p
});
`
    });

    const response = await t.putApp(t.admin.id, "built", broken);

    expectStatus(response, 422);
    const refusal = refusalOf(response);
    expect(refusal).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "validation_failed" }
    });
    expect(z.array(issueSchema).parse(refusal.details?.issues)).toEqual([
      expect.objectContaining({ file: "src/routes/history.tsx", line: 4 })
    ]);
    const after = await stored(t, "built");
    expect(after).toMatchObject({ revision: 1, fileSetId: before?.fileSetId });
    expect(after?.activeRevisionId).toBe(before?.activeRevisionId);
    // The refused set left no file set behind: no row beside the draft's, no object.
    expect(t.objectKeys(before?.id ?? "")).toEqual(keys);
    expect(
      await t.stores.configAssets.listConfigAssetRevisions({
        clientInstanceId,
        kind: "app",
        name: "built"
      })
    ).toHaveLength(1);
  }, 120_000);
});

describe("what a write with files may hold", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  it("takes a file as text or as base64 and stores the bytes either way", async () => {
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]);
    const files: AppFile[] = [
      ...appFiles("with a picture"),
      { path: "logo.png", base64: Buffer.from(bytes).toString("base64") }
    ];

    const response = await create(t, "binary", { files, workspaceId: t.workspaceId });

    expectStatus(response, 200);
    const answer = fileWriteSchema.parse(response.json());
    expect(answer.files.find((file) => file.path === "logo.png")).toEqual({
      path: "logo.png",
      sha256: sha256(bytes),
      bytes: bytes.byteLength
    });
    const asset = await stored(t, "binary");
    expect([...t.objects.bytes(`assets/${asset?.id}/${answer.fileSetId}/src/logo.png`)]).toEqual([
      ...bytes
    ]);
    // The name people see comes from the manifest.
    expect(asset?.config).toMatchObject({ name: "binary", title: "Offers" });
  });

  it("refuses a call whose files exceed ASSET_PUT_FILES_MAX_BYTES, naming the constant", async () => {
    expect(ASSET_PUT_FILES_MAX_BYTES).toBe(8 * 1024 * 1024);
    // The body of a call at the limit in base64 fits the route.
    expect(ASSET_PUT_BODY_LIMIT_BYTES).toBeGreaterThan((ASSET_PUT_FILES_MAX_BYTES / 3) * 4);
    const half = "a".repeat(ASSET_PUT_FILES_MAX_BYTES / 2);
    const files: AppFile[] = [
      ...appFiles("too much"),
      { path: "one.txt", text: half },
      { path: "two.txt", base64: Buffer.from(half).toString("base64") }
    ];

    const response = await create(t, "heavy", { files, workspaceId: t.workspaceId });

    expectStatus(response, 422);
    const refusal = refusalOf(response);
    expect(refusal.message).toContain("ASSET_PUT_FILES_MAX_BYTES");
    expect(refusal.details).toMatchObject({
      reason: "files_too_large",
      cap: "ASSET_PUT_FILES_MAX_BYTES",
      limit: ASSET_PUT_FILES_MAX_BYTES
    });
    expect(await stored(t, "heavy")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.includes("heavy"))).toEqual([]);
  });

  it("refuses a create under a name that exists, an App without a workspace, and files without the manifest", async () => {
    expectStatus(
      await create(t, "taken", { files: appFiles("one"), workspaceId: t.workspaceId }),
      200
    );
    const objects = t.objects.keys().length;

    const taken = await create(t, "taken", { files: appFiles("two"), workspaceId: t.workspaceId });
    expectStatus(taken, 409);
    expect(refusalOf(taken).details).toMatchObject({ reason: "app_id_taken" });

    const instanceWide = await create(t, "everywhere", { files: appFiles("one") });
    expectStatus(instanceWide, 422);
    expect(refusalOf(instanceWide).details).toMatchObject({ reason: "scope_unavailable" });

    const [, page] = appFiles("no manifest");
    const bare = await create(t, "bare", { files: [page], workspaceId: t.workspaceId });
    expectStatus(bare, 422);
    expect(refusalOf(bare).details).toMatchObject({ reason: "manifest_missing", file: "app.yaml" });

    // None of the three stored anything.
    expect(t.objects.keys()).toHaveLength(objects);
    expect((await stored(t, "taken"))?.revision).toBe(1);
  });

  it("writes an App as files and every other kind as its config", async () => {
    const asConfig = await create(t, "by-config", {
      config: { name: "by-config", title: "By config", manifest: {} },
      workspaceId: t.workspaceId
    });
    expectStatus(asConfig, 422);
    expect(refusalOf(asConfig).details).toMatchObject({ reason: "files_required" });

    const agentFiles = await t.call(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: { files: appFiles("an agent") }
    });
    expectStatus(agentFiles, 422);
    expect(refusalOf(agentFiles).details).toMatchObject({ reason: "config_required" });

    const both = await create(t, "both", {
      files: appFiles("both"),
      config: { name: "both" },
      workspaceId: t.workspaceId
    });
    expectStatus(both, 422);
  });

  it("refuses an App whose manifest names a Connection the instance does not have", async () => {
    const response = await create(t, "wired", {
      files: appFiles("wired", { connections: ["crm"] }),
      workspaceId: t.workspaceId
    });

    expectStatus(response, 422);
    expect(JSON.stringify(refusalOf(response))).toContain("crm");
    expect(await stored(t, "wired")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.includes("wired"))).toEqual([]);
  });

  it("keeps a batch of assets free of a kind that holds files", async () => {
    // A release, which may name any asset of the instance.
    const response = await t.instance.call("assets.sync", {
      payload: {
        items: [
          {
            type: "put",
            kind: "app",
            name: "batched",
            config: { name: "batched", title: "Batched", manifest: {} }
          }
        ]
      },
      headers: { [SERVICE_HEADER]: "svc_release" }
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.json())).toContain("assets.put");
    expect(await stored(t, "batched")).toBeUndefined();
  });
});

describe("a build that does not end in time", () => {
  let t: AppInstance;
  beforeAll(async () => {
    // No worker serves the build, and the write waits a moment instead of the full limit.
    t = await setupAppInstance({ worker: false, assetWaitMs: 300 });
  });
  afterAll(async () => {
    await t.close();
  });

  it("answers build_timeout as a call to send again, and leaves no revision and no file set", async () => {
    expect(APP_BUILD_WAIT_MS).toBe(60_000);

    const response = await create(t, "slow", {
      files: appFiles("never built"),
      workspaceId: t.workspaceId
    });

    expectStatus(response, 504);
    // A timeout answers 504, and an answer of that class carries no details: the reason is
    // the first word of what it says.
    const refusal = refusalOf(response);
    expect(refusal.code).toBe("TIMEOUT");
    expect(refusal.message).toMatch(/^build_timeout: /u);
    expect(await stored(t, "slow")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.startsWith("assets/"))).toEqual([]);
  });

  it("leaves the draft of an existing App where it was", async () => {
    // An App from a Page needs no build, so this instance can hold one.
    const page = await t.storePage("stays");
    await t.expectOk(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "steady", title: "Steady", workspaceId: t.workspaceId }
    });
    const before = await stored(t, "steady");
    const keys = t.objectKeys(before?.id ?? "");

    const response = await t.putApp(t.admin.id, "steady", appFiles("never built"));

    expectStatus(response, 504);
    expect(refusalOf(response).message).toMatch(/^build_timeout: /u);
    expect(await stored(t, "steady")).toMatchObject({
      revision: 1,
      activeRevisionId: before?.activeRevisionId,
      fileSetId: before?.fileSetId
    });
    expect(t.objectKeys(before?.id ?? "")).toEqual(keys);
  });
});
