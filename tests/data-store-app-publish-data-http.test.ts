import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DATA_STORE_MANIFEST_FILE } from "@work-shape/catalyst-core";
import { expectStatus, type AppFile } from "./support/app-instance";
import { INIT_SQL } from "./support/data-store-world";
import { setupFindingsApp, type FindingsWorld } from "./support/findings-app";

// DS-13b over HTTP: what the publish question of one stored revision tells, asked by a second
// person who may write the App. A new draft names only selectable stores within its owner
// boundary; a refused reference reveals none of the hidden store's details.

const LIST = "-- @param limit integer\nselect client_id from findings order by id limit $limit\n";

/** An App whose reading statements read the one store named. */
function appReading(store: string, actions: string[], marker: string): AppFile[] {
  return [
    {
      path: "app.yaml",
      text: JSON.stringify({
        id: "findings",
        name: "Findings",
        kit: "1.1.0",
        entry: "index.html",
        dataStores: [{ name: store, minSchema: 1 }],
        actions: actions.map((name) => ({
          name,
          file: `actions/${name}.sql`,
          effect: "reading"
        }))
      })
    },
    { path: "index.html", text: `<!doctype html><title>Findings</title><p>${marker}</p>` },
    ...actions.map((name) => ({ path: `actions/${name}.sql`, text: LIST }))
  ];
}

const revisionSchema = z.object({ revision: z.number() });
const sourcesSchema = z.object({
  revision: z.number(),
  stores: z.array(z.looseObject({ name: z.string() }))
});

describe("the stored data of a revision, over HTTP", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp();
    // A store of another workspace, which nobody of Sales may read, with its own title.
    const other = await t.sharedWorkspace("Payroll Team");
    await t.publishStore(
      "payroll",
      [
        {
          path: DATA_STORE_MANIFEST_FILE,
          text: "id: payroll\nname: Salaries of the payroll team\ndescription: Payroll.\n"
        },
        { path: "migrations/0001_init.sql", text: INIT_SQL }
      ],
      other
    );
    // Kai is a member of Sales and may write its Apps; he holds nothing in the other workspace.
    await t.grant(t.kai.id, "app.write", { workspaceId: t.workspaceId });
  }, 120_000);
  afterAll(() => t?.closeAll());

  const sources = (userId: string, revision: number) =>
    t.call(userId, "data_stores.app_sources", {
      query: { app: "findings", revision: String(revision) }
    });

  it("refuses a draft naming a hidden store of another workspace, and tells nothing of it", async () => {
    // The store of the App's own workspace is described, to Kai as to anyone who may write.
    const own = sourcesSchema.parse((await sources(t.kai.id, 2)).json());
    expect(own.stores).toEqual([
      expect.objectContaining({ name: "findings", title: "Findings", actions: ["list_findings"] })
    ]);
    expect(own.stores[0]).not.toHaveProperty("unavailable");

    const written = await t.putApp(t.kai.id, "findings", appReading("payroll", ["peek"], "cross"));
    expectStatus(written, 422);
    expect(written.body).toContain("references unknown Data Store 'payroll'");
    expect(written.body).not.toContain("Salaries of the payroll team");
    // The original draft is still the one the builder reads; no cross-owner draft was saved.
    const unchanged = await sources(t.kai.id, 2);
    expectStatus(unchanged, 200);
    expect(sourcesSchema.parse(unchanged.json()).stores).toEqual(own.stores);
  });

  it("asks a revision of the App of the name now, not of an App deleted before it", async () => {
    // The App `findings` has revisions 1 and up; a new App of the name starts again.
    const removed = await t.call(t.admin.id, "assets.delete", {
      params: { kind: "app", name: "findings" },
      payload: { workspaceId: t.workspaceId }
    });
    expectStatus(removed, 200);
    const written = await t.putApp(
      t.admin.id,
      "findings",
      appReading("findings", ["list_findings"], "again")
    );
    expectStatus(written, 200);
    const { revision } = revisionSchema.parse(written.json());
    expectStatus(await sources(t.admin.id, revision), 200);
    // Revision 2 was the deleted App's draft and is no revision of this one.
    expect(revision).not.toBe(2);
    expectStatus(await sources(t.admin.id, 2), 404);
  });
});
