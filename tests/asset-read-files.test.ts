import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ASSET_GET_FILES_MAX_BYTES, ASSET_PUT_FILES_MAX_BYTES } from "@vivd-catalyst/core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  setupAppInstance,
  sha256,
  type AppInstance
} from "./support/app-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// Reading one revision of an App with its source files: the files that were put come back as
// they were put, for the draft, the published revision and a number; who may read which; and
// what a read answers of a set above its limit.

const fileSchema = z.strictObject({
  path: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  text: z.string().optional(),
  base64: z.string().optional()
});
const readSchema = z.looseObject({
  revision: z.number(),
  contentRevision: z.number().optional(),
  draftRevision: z.number().optional(),
  publishedRevision: z.number().optional(),
  files: z.array(fileSchema).optional(),
  filesOmitted: z.literal(true).optional()
});

// Bytes that are no UTF-8 text.
const logo = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
const filesOf = (marker: string) => [
  ...appFiles(marker),
  { path: "assets/logo.png", base64: Buffer.from(logo).toString("base64") },
  { path: "notes/greeting.txt", text: "Grüße – 你好\n" }
];

describe("reading the source files of one revision of an App", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (userId: string, name: string, query: Record<string, string> = {}, kind = "app") =>
    t.call(userId, "assets.get", {
      params: { kind, name },
      query: { ...(kind === "app" ? { workspaceId: t.workspaceId } : {}), ...query }
    });
  const read = async (userId: string, name: string, query: Record<string, string> = {}) => {
    const response = await get(userId, name, query);
    expectStatus(response, 200);
    return readSchema.parse(response.json());
  };
  const create = async (name: string, marker: string) => {
    const response = await t.instance.call("assets.put", {
      params: { kind: "app", name },
      payload: { files: filesOf(marker), workspaceId: t.workspaceId },
      headers: { "x-test-user": t.admin.id }
    });
    expectStatus(response, 200);
    return fileWriteSchema.parse(response.json());
  };
  const refusal = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;
  const grant = (userId: string, action: string) =>
    t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: userId,
      action,
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });

  it("answers the paths, hashes and contents that were put, text as text and bytes as base64", async () => {
    const written = await create("offers", "one");

    const answer = await read(t.admin.id, "offers", { files: "true" });

    expect(answer).toMatchObject({ revision: 1, contentRevision: 1 });
    expect(answer.filesOmitted).toBeUndefined();
    const files = answer.files ?? [];
    // The same paths and hashes the write answered, in the order of their paths.
    expect(files.map(({ path, sha256: hash, bytes }) => ({ path, sha256: hash, bytes }))).toEqual(
      [...written.files].sort((left, right) => (left.path < right.path ? -1 : 1))
    );
    const put = new Map(filesOf("one").map((file) => [file.path, file]));
    for (const file of files) {
      expect(file, file.path).toMatchObject(put.get(file.path) ?? {});
      const bytes =
        file.text === undefined ? Buffer.from(file.base64 ?? "", "base64") : Buffer.from(file.text);
      expect(sha256(bytes), file.path).toBe(file.sha256);
      expect(bytes.byteLength, file.path).toBe(file.bytes);
    }
    expect(files.find((file) => file.path === "assets/logo.png")).toMatchObject({
      base64: Buffer.from(logo).toString("base64"),
      contentType: "image/png"
    });
    expect(files.find((file) => file.path === "assets/logo.png")).not.toHaveProperty("text");

    // What was read is what a write takes: the same files make the same file hashes again.
    const again = await t.putApp(
      t.admin.id,
      "offers",
      files.map((file) =>
        file.text === undefined
          ? { path: file.path, base64: file.base64 ?? "" }
          : { path: file.path, text: file.text }
      )
    );
    expectStatus(again, 200);
    expect(fileWriteSchema.parse(again.json()).files).toEqual(written.files);

    // Without `files` a read carries none.
    expect(await read(t.admin.id, "offers")).not.toHaveProperty("files");
  });

  it("answers the draft, the published revision and a revision by its number", async () => {
    await create("pricing", "first");
    expectStatus(await t.publish(t.admin.id, "pricing", 1), 200);
    expectStatus(await t.putApp(t.admin.id, "pricing", filesOf("second")), 200);
    const page = (answer: z.infer<typeof readSchema>) =>
      answer.files?.find((file) => file.path === "index.html")?.text;

    const draft = await read(t.admin.id, "pricing", { files: "true" });
    const named = await read(t.admin.id, "pricing", { files: "true", revision: "draft" });
    const published = await read(t.admin.id, "pricing", { files: "true", revision: "published" });
    const first = await read(t.admin.id, "pricing", { files: "true", revision: "1" });

    expect(draft).toMatchObject({ revision: 2, contentRevision: 2, publishedRevision: 1 });
    expect(page(draft)).toContain("second");
    expect(named.files).toEqual(draft.files);
    // `revision` stays the draft's number, which a write names; `contentRevision` is what is shown.
    expect(published).toMatchObject({ revision: 2, contentRevision: 1, publishedRevision: 1 });
    expect(page(published)).toContain("first");
    expect(first.files).toEqual(published.files);
    expect(first.contentRevision).toBe(1);
  });

  it("refuses the draft to whoever may not write or publish, and answers the published revision to a reader", async () => {
    await create("guarded", "public");
    expectStatus(await t.publish(t.admin.id, "guarded", 1), 200);
    expectStatus(await t.putApp(t.admin.id, "guarded", filesOf("unpublished")), 200);

    // A member of the workspace uses the App and reads nothing of it.
    const member = await get(t.kai.id, "guarded", { files: "true", revision: "published" });
    expectStatus(member, 403);
    expect(refusal(member).details).toMatchObject({ action: "app.read" });

    const reading = await grant(t.kai.id, "app.read");
    const published = await read(t.kai.id, "guarded", { files: "true", revision: "published" });
    expect(published.contentRevision).toBe(1);
    expect(JSON.stringify(published.files)).toContain("public");
    const draftReads: Record<string, string>[] = [
      { files: "true" },
      { revision: "draft" },
      { revision: "2" },
      { revision: "1" },
      {}
    ];
    for (const query of draftReads) {
      const refused = await get(t.kai.id, "guarded", query);
      expectStatus(refused, 403);
      expect(refusal(refused).details, JSON.stringify(query)).toMatchObject({
        action: "app.write"
      });
      expect(refused.body).not.toContain("unpublished");
    }
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: reading.id });

    // Whoever publishes reads what is to be published; whoever writes reads both.
    const publishing = await grant(t.kai.id, "app.publish");
    expect((await read(t.kai.id, "guarded", { files: "true" })).contentRevision).toBe(2);
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: publishing.id });
    const writing = await grant(t.kai.id, "app.write");
    expect((await read(t.kai.id, "guarded", { files: "true" })).contentRevision).toBe(2);
    expect(
      (await read(t.kai.id, "guarded", { files: "true", revision: "published" })).contentRevision
    ).toBe(1);
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: writing.id });

    // Somebody outside the workspace is told nothing.
    expectStatus(await get(t.lena.id, "guarded", { files: "true", revision: "published" }), 403);
  });

  it("names what is not there: no publication, no such revision, no files, no draft", async () => {
    await create("fresh", "fresh");

    const unpublished = await get(t.admin.id, "fresh", { revision: "published", files: "true" });
    expectStatus(unpublished, 404);
    expect(refusal(unpublished).details).toMatchObject({ reason: "not_published" });

    const unknown = await get(t.admin.id, "fresh", { revision: "9", files: "true" });
    expectStatus(unknown, 404);
    expect(refusal(unknown).details).toMatchObject({ reason: "revision_unknown" });

    for (const revision of ["0", "latest", "-1", "1.5"]) {
      expectStatus(await get(t.admin.id, "fresh", { revision }), 422);
    }
    expectStatus(await get(t.admin.id, "fresh", { files: "yes" }), 422);

    // An agent holds a config and one revision that counts.
    const agent = (
      await t.expectOk(t.admin.id, "assets.list", { params: { kind: "agent" } })
    ).json();
    const name = z.object({ items: z.array(z.object({ name: z.string() })).min(1) }).parse(agent)
      .items[0]?.name;
    expectStatus(await get(t.admin.id, name ?? "", {}, "agent"), 200);
    const noFiles = await get(t.admin.id, name ?? "", { files: "true" }, "agent");
    expectStatus(noFiles, 422);
    expect(refusal(noFiles).details).toMatchObject({ reason: "no_files" });
    const noDraft = await get(t.admin.id, name ?? "", { revision: "published" }, "agent");
    expectStatus(noDraft, 422);
    expect(refusal(noDraft).details).toMatchObject({ reason: "no_draft" });
  });

  it("answers the index alone, and reads no object, for a set above ASSET_GET_FILES_MAX_BYTES", async () => {
    expect(ASSET_GET_FILES_MAX_BYTES).toBe(ASSET_PUT_FILES_MAX_BYTES);
    const written = await create("heavy", "heavy");
    // An App saved from a Page may hold up to FILE_SET_MAX_TOTAL_BYTES, more than one read
    // carries. The index is made to say so here: the read decides by the index alone.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`
        update file_sets
        set source_files = (
          select jsonb_agg(
            case when file->>'path' = 'index.html'
              then jsonb_set(file, '{bytes}', to_jsonb(${ASSET_GET_FILES_MAX_BYTES + 1}::int))
              else file end
          ) from jsonb_array_elements(source_files) as file
        )
        where id = ${written.fileSetId}`;
    } finally {
      await sql.end();
    }

    const answer = await read(t.admin.id, "heavy", { files: "true" });

    expect(answer.filesOmitted).toBe(true);
    expect(answer.files?.map((file) => file.path)).toEqual(
      filesOf("heavy")
        .map((file) => file.path)
        .sort()
    );
    for (const file of answer.files ?? []) {
      expect(file).not.toHaveProperty("text");
      expect(file).not.toHaveProperty("base64");
    }
    expect(answer.files?.find((file) => file.path === "index.html")?.bytes).toBe(
      ASSET_GET_FILES_MAX_BYTES + 1
    );
  });

  it("answers revision_files_removed for a revision whose files are not stored any more", async () => {
    const written = await create("pruned", "pruned");
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`delete from file_sets where id = ${written.fileSetId}`;
    } finally {
      await sql.end();
    }

    const response = await get(t.admin.id, "pruned", { files: "true" });

    expectStatus(response, 404);
    expect(refusal(response).details).toMatchObject({
      reason: "revision_files_removed",
      revision: 1
    });
    // The revision itself is still read.
    expect((await read(t.admin.id, "pruned")).contentRevision).toBe(1);
  });
});
