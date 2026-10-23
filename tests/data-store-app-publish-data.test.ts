import { describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  type AssetScope,
  type AuthenticatedUser,
  type JsonObject,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";

// DS-13b against real Postgres: who would see which stored data when one revision of an App is
// published, asked by whoever may publish or approve that revision, for a first publish, a later
// one and an older one alike.

const person = (id: string, roles: AuthenticatedUser["roles"]): AuthenticatedUser => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles,
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("data-store-test"),
  authSource: "test"
});
const admin = person("usr_publish_data_admin", ["admin"]);

describe("the stored data an App's publish would show", () => {
  const { db, published } = useDataStoreWorld("data_store_app_publish_data");

  type World = Awaited<ReturnType<typeof published>>;

  /** Writes an asset and publishes it, as its kind's own workflow would. */
  async function publishAssetOf(
    world: World,
    kind: string,
    name: string,
    config: JsonObject,
    scope?: AssetScope
  ) {
    const { clientInstanceId } = world;
    const key = `${kind}:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [{ type: "upsert", kind, name, config, draft: true, ...(scope ? { scope } : {}) }]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind,
        name,
        revision
      })
    );
    const assetId = required(written.assetIds[key]);
    await db.store.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId,
      revision,
      revisionId: stored.id
    });
    return assetId;
  }

  it("names who would see which stored data for the revision a publish names, not the live one: check 67", async () => {
    const world = await published("publish_data");
    const { clientInstanceId } = world;
    const stores = db.store;
    const people = await Promise.all(
      ["Kai", "Lena"].map((displayLabel) =>
        stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] })
      )
    );
    const [kai, lena] = people.map(({ id }) => id);
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Kai Spezis",
      creatorUserId: required(kai)
    });
    await stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      userId: required(lena),
      role: "member"
    });
    await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:exampledata": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "exampledata",
          config: { displayName: "Exampledata" }
        }
      ]
    });
    await publishAssetOf(world, "workflow", "nachtimport", {
      manifest: {
        id: "nachtimport",
        name: "Nachtimport",
        steps: [
          {
            id: "read",
            name: "Read",
            type: "operation",
            operation: "connection.exampledata.clients"
          },
          { id: "store", name: "Store", type: "operation", operation: "data_store.findings.insert" }
        ]
      }
    });
    const reading = (name: string) => ({
      name,
      kind: "sql",
      dataStore: "findings",
      effect: "reading",
      statement: "select private_note from findings where month = $1"
    });
    const scope = { kind: "workspace", workspaceId: workspace.id } as const;
    // Revision 1 is live and reads with one action; revision 2, the draft, with two, and adds
    // rows with a third that shows nothing to anyone.
    const app = await publishAssetOf(
      world,
      "app",
      "kunden",
      { title: "Kunden", manifest: { actions: [reading("list")] } },
      scope
    );
    const draft = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "app:kunden": 1 },
      mutations: [
        {
          type: "upsert",
          kind: "app",
          name: "kunden",
          draft: true,
          scope,
          config: {
            title: "Kunden",
            manifest: {
              actions: [
                reading("list"),
                reading("by_month"),
                { name: "note", kind: "sql", dataStore: "findings", effect: "changing" }
              ]
            }
          }
        }
      ]
    });
    expect(draft.revisions["app:kunden"]).toBe(2);
    // An account uses the App by a grant: a holder, not a person.
    const viewer = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "kunden-ansicht",
      displayLabel: "Viewer account"
    });
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: viewer.id,
      action: "app.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: app,
      grantedBy: asUserId(admin.id)
    });

    const on = (holder: AuthenticatedUser, action: string, scopeId: string): PermissionGrant => ({
      id: `grant_${holder.id}_${action}`,
      clientInstanceId: holder.clientInstanceId,
      holderKind: "user",
      holderId: holder.id,
      action,
      effect: "allow",
      scopeKind: "asset",
      scopeId,
      grantedBy: asUserId(admin.id),
      createdAt: new Date().toISOString()
    });
    const publisher = person("usr_publish_data_publisher", ["user"]);
    const asPublisher = accessOf(publisher, { grants: [on(publisher, "app.publish", app)] });
    const store = {
      name: "findings",
      title: "Findings",
      fillers: [
        {
          kind: "workflow",
          name: "nachtimport",
          title: "Nachtimport",
          connections: ["Exampledata"]
        }
      ],
      rows: {
        estimate: expect.any(Number),
        tables: expect.any(Number),
        measuredAt: expect.any(String)
      }
    };
    // Who administers nobody reads the workspace by its people and the account as a number.
    const audience = {
      workspace: { title: "Kai Spezis", members: 2 },
      holders: [],
      hiddenHolders: 1
    };
    const ofDraft = await world.dataStores.appSources(asPublisher, "kunden", 2);
    expect(ofDraft).toEqual({
      stores: [{ ...store, actions: ["list", "by_month"] }],
      revision: 2,
      audience,
      truncated: false
    });
    // PUBQ-1 consumes the same revision, audience and provenance through its metadata port.
    // No row estimate, statement, parameter or value enters the generated sentence's facts.
    expect(
      await world.dataStores.publishNarrativeData.appRevision(asPublisher, "kunden", 2)
    ).toEqual({
      audience: { workspace: audience.workspace, holders: 1 },
      stores: [
        {
          title: "Findings",
          unavailable: false,
          fillers: [{ title: "Nachtimport", connections: ["Exampledata"] }]
        }
      ],
      truncated: false
    });
    expect(
      await world.dataStores.publishNarrativeData.storeReaders(accessOf(admin), ["findings"])
    ).toEqual([
      {
        store: "findings",
        title: "Findings",
        readers: [
          {
            kind: "app",
            title: "Kunden",
            audience: { workspace: audience.workspace, holders: 1 }
          }
        ],
        hidden: 0,
        truncated: false
      }
    ]);
    // An older revision names its own actions, not the draft's and not the live one's by chance.
    expect(await world.dataStores.appSources(asPublisher, "kunden", 1)).toMatchObject({
      stores: [{ actions: ["list"] }],
      revision: 1
    });
    // No statement, parameter or column leaves.
    expect(JSON.stringify(ofDraft)).not.toMatch(/private_note|select|\$1/u);
    // Who decides a held publish reads the same; an admin is shown who holds the use.
    const approver = person("usr_publish_data_approver", ["user"]);
    expect(
      await world.dataStores.appSources(
        accessOf(approver, { grants: [on(approver, "app.approve", app)] }),
        "kunden",
        2
      )
    ).toEqual(ofDraft);
    expect((await world.dataStores.appSources(accessOf(admin), "kunden", 2)).audience).toEqual({
      workspace: { title: "Kai Spezis", members: 2 },
      holders: [{ kind: "service_principal", name: viewer.id, title: "Viewer account" }],
      hiddenHolders: 0
    });

    // A first publish: an App nothing of which is live yet.
    const termine = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "app:termine": null },
      mutations: [
        {
          type: "upsert",
          kind: "app",
          name: "termine",
          draft: true,
          scope,
          config: { title: "Termine", manifest: { actions: [reading("upcoming")] } }
        }
      ]
    });
    const termineId = required(termine.assetIds["app:termine"]);
    expect(
      await world.dataStores.appSources(
        accessOf(publisher, { grants: [on(publisher, "app.publish", termineId)] }),
        "termine",
        1
      )
    ).toMatchObject({
      stores: [{ name: "findings", actions: ["upcoming"] }],
      revision: 1,
      audience: { workspace: { title: "Kai Spezis", members: 2 }, hiddenHolders: 0 }
    });

    // Who only uses the App asks no revision, and a revision the App does not have is not there.
    const user = person("usr_publish_data_user", ["user"]);
    await expect(
      world.dataStores.appSources(
        accessOf(user, { grants: [on(user, "app.use", app)] }),
        "kunden",
        2
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(world.dataStores.appSources(asPublisher, "kunden", 9)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    // Without a revision the answer is the published App's, as before.
    expect(
      await world.dataStores.appSources(
        accessOf(user, { grants: [on(user, "app.use", app)] }),
        "kunden"
      )
    ).toEqual({
      stores: [{ name: "findings", title: "Findings", fillers: store.fillers }],
      truncated: false
    });
    await db.sql`delete from config_assets where scope_id = ${workspace.id}`;
  });

  it("asks the revision of the App it read, not of a new App of the name written between", async () => {
    const world = await published("publish_data_recreated");
    const { clientInstanceId } = world;
    const stores = db.store;
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Recreated",
      creatorUserId: required(
        (await stores.users.createUser({ clientInstanceId, displayLabel: "Mia", roles: ["user"] }))
          .id
      )
    });
    const scope = { kind: "workspace", workspaceId: workspace.id } as const;
    const write = (action: string, baseRevision: number | null) =>
      stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "app:berichte": baseRevision },
        mutations: [
          {
            type: "upsert",
            kind: "app",
            name: "berichte",
            draft: true,
            scope,
            config: {
              title: "Berichte",
              manifest: {
                actions: [{ name: action, kind: "sql", dataStore: "findings", effect: "reading" }]
              }
            }
          }
        ]
      });
    await write("old_list", null);
    const old = required((await write("old_by_month", 1)).assetIds["app:berichte"]);
    // Between reading the App and reading its revision, the App is deleted and a new one of
    // the name is written: its revision 1 is no revision of the App that was read.
    const read = stores.configAssets.getConfigAsset.bind(stores.configAssets);
    const between = vi
      .spyOn(stores.configAssets, "getConfigAsset")
      .mockImplementationOnce(async (input) => {
        const record = await read(input);
        await stores.configAssets.removeConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "berichte",
          assetId: old,
          expectedRevision: 2
        });
        await write("new_list", null);
        return record;
      });
    try {
      await expect(
        world.dataStores.appSources(accessOf(admin), "berichte", 1)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      between.mockRestore();
    }
    // Asked again, the new App answers its own revision.
    expect(await world.dataStores.appSources(accessOf(admin), "berichte", 1)).toMatchObject({
      stores: [{ name: "findings", actions: ["new_list"] }],
      revision: 1
    });
    await db.sql`delete from config_assets where scope_id = ${workspace.id}`;
  });
});
