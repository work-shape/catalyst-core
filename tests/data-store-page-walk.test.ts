import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DATA_STORE_ACTIONS } from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import { required } from "./support/assertions";
import { setupFindingsApp, type FindingsWorld } from "./support/findings-app";

// One walk of a member over the reads of a store's page, on an instance with a published App
// on the store: the member holds the read of the store and the use of the App's workspace,
// and no right on the Workflow that also uses the store. The reads are the store's own
// operations, called through the instance's call path as the routes of their name call them.

const pageSchema = z.object({
  rows: z.array(z.object({ at: z.string(), values: z.record(z.string(), z.unknown()) })),
  next: z.string().optional()
});

describe("a member on the page of a Data Store", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp();
  });
  afterAll(() => t.closeAll());

  it("pages through the rows and reads what uses the store, shown the App it may use and a count of the Workflow it may not", async () => {
    const mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      email: "mia@example.test",
      roles: ["user"],
      permissions: []
    });
    expectStatus(
      await t.call(t.admin.id, "workspaces.members.add", {
        params: { collaborationWorkspaceId: t.workspaceId },
        payload: { email: "mia@example.test" }
      }),
      200
    );
    // A Workflow of the instance that stores into `findings`, published as its kind stores it.
    const written = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "workflow:monthly-check": null },
      mutations: [
        {
          type: "upsert",
          kind: "workflow",
          name: "monthly-check",
          draft: true,
          config: {
            manifest: {
              id: "monthly-check",
              name: "Monthly check",
              steps: [
                {
                  id: "store",
                  name: "Store",
                  type: "operation",
                  operation: "data_store.findings.insert",
                  input: {}
                }
              ]
            }
          }
        }
      ]
    });
    const revision = required(written.revisions["workflow:monthly-check"]);
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "workflow",
      name: "monthly-check",
      assetId: required(written.assetIds["workflow:monthly-check"]),
      revision,
      revisionId: required(
        await t.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind: "workflow",
          name: "monthly-check",
          revision
        })
      ).id
    });

    // Without the read of the store the member reads neither.
    const denied = { status: "denied", reason: { kind: "forbidden", action: "data_store.read" } };
    for (const [part, input] of [
      ["rows", { table: "findings" }],
      ["used_by", {}]
    ] as const) {
      expect((await t.invoke(mia, `data_store.findings.${part}`, input)).result).toMatchObject(
        denied
      );
    }
    // AP-10: the grant of a store's right to a person is written to the store.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: mia.id,
      action: DATA_STORE_ACTIONS.read,
      effect: "allow",
      scopeKind: "asset",
      scopeId: t.store.id,
      grantedBy: t.admin.id
    });

    // The four rows of the store, three and then one.
    const first = await t.invoke(mia, "data_store.findings.rows", { table: "findings", limit: 3 });
    expect(first.result.status).toBe("done");
    const one = pageSchema.parse(first.result.status === "done" ? first.result.output : {});
    expect(one.rows.map(({ values }) => values.amount)).toEqual(["10.00", "20.00", "30.00"]);
    const second = await t.invoke(mia, "data_store.findings.rows", {
      table: "findings",
      limit: 3,
      after: required(one.next)
    });
    const two = pageSchema.parse(second.result.status === "done" ? second.result.output : {});
    expect(two.rows.map(({ values }) => values.client_id)).toEqual(["client-b"]);
    expect(two.next).toBeUndefined();
    const whole = await t.invoke(mia, "data_store.findings.value", {
      table: "findings",
      column: "severity",
      at: required(one.rows[0]).at
    });
    expect(whole.result).toMatchObject({ status: "done", output: { value: "error" } });

    // The App of the member's workspace is named. The Workflow is counted and not named.
    const used = await t.invoke(mia, "data_store.findings.used_by", {});
    expect(used.result).toMatchObject({
      status: "done",
      output: {
        apps: [{ name: "findings", title: "Findings" }],
        workflows: [],
        hidden: { apps: 0, workflows: 1 },
        truncated: false
      }
    });
    expect(JSON.stringify(used.result)).not.toContain("monthly-check");
    // Whoever reads everything is shown both.
    const all = await t.invoke(t.admin, "data_store.findings.used_by", {});
    expect(all.result).toMatchObject({
      output: {
        apps: [{ name: "findings" }],
        workflows: [{ name: "monthly-check", title: "Monthly check" }],
        hidden: { apps: 0, workflows: 0 }
      }
    });
  });
});
