import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELD_OPERATION_INPUT_MAX_BYTES } from "@vivd-catalyst/chat-server";
import { StoreBackedAuditRecorder } from "@vivd-catalyst/core";
import { OPERATION_CALL_APPROVAL_KIND } from "@vivd-catalyst/tool-execution";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  previewSchema,
  setupAppInstance,
  type AppInstance
} from "./support/app-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// What stays of an App when something around a write fails: the files of a committed revision,
// the publication while a revision has no files, and nothing at all of a write that a policy
// holds and that is too large to be held.

const stored = (t: AppInstance, name: string) =>
  t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
const refusalOf = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;
/** A write without the revision the harness would add: the call that creates. */
const create = (t: AppInstance, name: string, marker: string) =>
  t.instance.call("assets.put", {
    params: { kind: "app", name },
    payload: { files: appFiles(marker), workspaceId: t.workspaceId },
    headers: { "x-test-user": t.admin.id }
  });
const preview = async (t: AppInstance, app: string, mode: "draft" | "published") =>
  previewSchema.parse(
    (await t.expectOk(t.admin.id, "apps.preview", { params: { app }, payload: { mode } })).json()
  );
/** A change of the rows no operation makes: the state a failure of the past left behind. */
async function damage(run: (sql: postgres.Sql) => Promise<unknown>): Promise<void> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  try {
    await run(sql);
  } finally {
    await sql.end();
  }
}

describe("a write of an App that fails after its revision was committed", () => {
  let t: AppInstance;
  let failing = false;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (stores) => {
        const recorder = new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit });
        return {
          auditRecorder: {
            record: (event) =>
              failing && event.type === "config_asset.updated"
                ? Promise.reject(new Error("The audit store is away"))
                : recorder.record(event)
          }
        };
      }
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps the files of the revision, for a new App and for a further revision", async () => {
    failing = true;
    const first = await create(t, "kept", "first");
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    const second = await t.putApp(t.admin.id, "kept", appFiles("second"));
    expect(second.statusCode).toBeGreaterThanOrEqual(500);
    failing = false;

    // Both revisions were committed before the failure, and each still has its files.
    const asset = await stored(t, "kept");
    expect(asset).toMatchObject({ revision: 2 });
    const draft = await preview(t, "kept", "draft");
    expect(draft.revision).toBe(2);
    const document = await t.open(draft.url);
    expect(document.status).toBe(200);
    expect(document.body).toContain("second");
    expectStatus(await t.publish(t.admin.id, "kept", 1), 200);
    expect((await t.open((await preview(t, "kept", "published")).url)).body).toContain("first");
  });

  it("removes the files of a write that was refused before its revision", async () => {
    expectStatus(await create(t, "refused", "one"), 200);
    const asset = await stored(t, "refused");
    const before = t.objectKeys(asset?.id ?? "");

    // The write names a revision the App is not at, which is refused after its build.
    const response = await t.instance.call("assets.put", {
      params: { kind: "app", name: "refused" },
      payload: { files: appFiles("two"), workspaceId: t.workspaceId, expectedRevision: 7 },
      headers: { "x-test-user": t.admin.id }
    });

    expectStatus(response, 409);
    expect(t.objectKeys(asset?.id ?? "")).toEqual(before);
  });
});

describe("a revision of an App whose files are not there", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance();
  });
  afterAll(async () => {
    await t.close();
  });

  it("is not published, and the publication before it stays served", async () => {
    expectStatus(await create(t, "offers", "working"), 200);
    expectStatus(await t.publish(t.admin.id, "offers", 1), 200);
    const broken = fileWriteSchema.parse(
      (await t.putApp(t.admin.id, "offers", appFiles("broken"))).json()
    );
    await damage((sql) => sql`delete from file_sets where id = ${broken.fileSetId}`);

    const response = await t.publish(t.admin.id, "offers", 2);

    expectStatus(response, 422);
    expect(refusalOf(response).details).toEqual({ reason: "revision_files_removed", revision: 2 });
    expect(await t.listed("offers")).toMatchObject({ draftRevision: 2, publishedRevision: 1 });
    const published = await preview(t, "offers", "published");
    expect(published.revision).toBe(1);
    expect((await t.open(published.url)).body).toContain("working");
  });

  it("refuses a revision whose file set is another asset's", async () => {
    expectStatus(await create(t, "mine", "mine"), 200);
    const other = fileWriteSchema.parse((await create(t, "theirs", "theirs")).json());
    const mine = await stored(t, "mine");
    await damage(
      (sql) =>
        sql`update config_asset_revisions set file_set_id = ${other.fileSetId} where asset_id = ${mine?.id ?? ""}`
    );

    const response = await t.publish(t.admin.id, "mine", 1);

    expectStatus(response, 422);
    expect(refusalOf(response).details).toMatchObject({ reason: "revision_files_removed" });
    expect(await t.listed("mine")).not.toHaveProperty("publishedRevision");
  });

  it("serves nobody a file set that no revision of the App names, its writer included", async () => {
    expectStatus(await create(t, "orphan", "left behind"), 200);
    // The address is the writer's own and valid, and it was not opened yet.
    const draft = await preview(t, "orphan", "draft");
    await damage(
      (sql) =>
        sql`update config_asset_revisions set file_set_id = null where file_set_id = ${draft.fileSetId}`
    );

    const document = await t.open(draft.url);

    expect(document.status).toBe(404);
    expect(document.body).not.toContain("left behind");
  });
});

describe("a write of an App that a policy holds for an approval", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: () => ({
        operations: {
          centralPolicySettings: () => [{ operation: "assets.put", value: "approval" }]
        }
      })
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it("is held with its files while its input is within the limit of a held call", async () => {
    const response = await create(t, "small", "held");

    expectStatus(response, 202);
    expect(await stored(t, "small")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.startsWith("assets/"))).toEqual([]);
  });

  it("is refused above that limit, before a file is stored or built", async () => {
    const response = await t.instance.call("assets.put", {
      params: { kind: "app", name: "large" },
      payload: {
        files: [
          ...appFiles("large"),
          { path: "data.txt", text: "x".repeat(HELD_OPERATION_INPUT_MAX_BYTES) }
        ],
        workspaceId: t.workspaceId
      },
      headers: { "x-test-user": t.admin.id }
    });

    expectStatus(response, 422);
    const refusal = refusalOf(response);
    expect(refusal.details).toEqual({
      reason: "input_too_large_to_hold",
      limit: "HELD_OPERATION_INPUT_MAX_BYTES"
    });
    expect(refusal.message).toContain("256 KiB");
    expect(await stored(t, "large")).toBeUndefined();
    expect(t.objects.keys().filter((key) => key.startsWith("assets/"))).toEqual([]);
    // The request of the write before is the only one: nothing of this write is held.
    expect(
      await t.stores.approvals.countPendingApprovalRequests({
        clientInstanceId,
        kinds: [OPERATION_CALL_APPROVAL_KIND]
      })
    ).toBe(1);
  });
});
