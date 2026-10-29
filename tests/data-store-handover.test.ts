import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  dataHandoverLines,
  requireDataHandover,
  type AppAvailability,
  type AssetScope,
  type AuthenticatedUser,
  type JsonObject,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";

// DS-13c against real Postgres (data-stores-and-knowledge-bases.md, check 68): at a publish,
// everyone who reads a store's rows may use each of its sources. Where the publish hands a
// source's data to readers who may not use it, the publisher is told how many, never who, and
// only a holder of `connection.write` on the source may confirm the hand-over.

const person = (id: string): AuthenticatedUser => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("data-store-test"),
  authSource: "test"
});

const on = (holder: AuthenticatedUser, action: string, scopeId: string): PermissionGrant => ({
  id: `grant_${holder.id}_${action}_${scopeId}`,
  clientInstanceId: holder.clientInstanceId,
  holderKind: "user",
  holderId: holder.id,
  action,
  effect: "allow",
  scopeKind: "asset",
  scopeId,
  grantedBy: asUserId("usr_handover_admin"),
  createdAt: new Date().toISOString()
});

describe("the widening check of a publish", () => {
  const { db, published } = useDataStoreWorld("data_store_handover");

  type World = Awaited<ReturnType<typeof published>>;

  /** Writes a draft of an asset and answers its revision. */
  async function draftOf(
    world: World,
    kind: string,
    name: string,
    config: JsonObject,
    scope?: AssetScope
  ) {
    const key = `${kind}:${name}`;
    const current = await db.store.configAssets.getConfigAsset({
      clientInstanceId: world.clientInstanceId,
      kind,
      name
    });
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { [key]: current?.revision ?? null },
      mutations: [{ type: "upsert", kind, name, config, draft: true, ...(scope ? { scope } : {}) }]
    });
    return {
      assetId: required(written.assetIds[key]),
      revision: required(written.revisions[key])
    };
  }

  /** Makes a revision live, as its kind's publish would. */
  async function publishOf(
    world: World,
    kind: string,
    name: string,
    draft: { assetId: string; revision: number },
    audience?: "workspace"
  ) {
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind,
        name,
        revision: draft.revision
      })
    );
    await db.store.configAssets.publishConfigAssetRevision({
      clientInstanceId: world.clientInstanceId,
      kind,
      name,
      assetId: draft.assetId,
      revision: draft.revision,
      revisionId: stored.id,
      ...(audience ? { audience } : {})
    });
  }

  const importing = (connection: string): JsonObject => ({
    manifest: {
      id: `import-${connection}`,
      name: `Import ${connection}`,
      steps: [
        { id: "read", name: "Read", type: "operation", operation: `connection.${connection}.list` },
        { id: "store", name: "Store", type: "operation", operation: "data_store.findings.insert" }
      ]
    }
  });
  const overview: JsonObject = {
    title: "Overview",
    manifest: {
      actions: [
        {
          name: "list",
          kind: "sql",
          dataStore: "findings",
          effect: "reading",
          statement: "select * from findings"
        }
      ]
    }
  };

  it("counts the readers a publish hands a source's data to, and only its holder confirms: check 68", async () => {
    const world = await published("handover");
    const { clientInstanceId } = world;
    const stores = db.store;
    const [owner, ...members] = await Promise.all(
      ["Owner", "Member One", "Member Two", "Member Three"].map((displayLabel) =>
        stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] })
      )
    );
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: required(owner).id
    });
    for (const member of members) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: member.id,
        role: "member"
      });
    }
    const connections = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:exampledata": null, "connection:crm": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "exampledata",
          config: { displayName: "Exampledata" }
        },
        { type: "upsert", kind: "connection", name: "crm", config: { displayName: "CRM" } }
      ]
    });
    const exampledata = required(connections.assetIds["connection:exampledata"]);
    const crm = required(connections.assetIds["connection:crm"]);
    // The workspace's owner may use the source; its three other members may not.
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: required(owner).id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: exampledata,
      grantedBy: asUserId("usr_handover_admin")
    });
    await publishOf(
      world,
      "workflow",
      "import",
      await draftOf(world, "workflow", "import", importing("exampledata"))
    );
    const scope = { kind: "workspace", workspaceId: workspace.id } as const;
    const app = await draftOf(world, "app", "overview", overview, scope);

    const handover = required(world.dataStores.publishNarrativeData.handover);
    const storeAsset = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "data_store",
        name: "findings"
      })
    );
    const publisher = person("usr_handover_publisher");
    const asPublisher = accessOf(publisher, {
      grants: [on(publisher, "app.publish", app.assetId)]
    });
    const keeper = person("usr_handover_keeper");
    const asKeeper = accessOf(keeper, {
      grants: [
        on(keeper, "app.publish", app.assetId),
        on(keeper, "connection.write", exampledata),
        on(keeper, "data_store.read", storeAsset.id)
      ]
    });
    const publishing = (availability: AppAvailability) => [
      { kind: "app", name: "overview", config: overview, appAvailability: availability }
    ];

    // Only me: the owner alone reads the rows, and may use the source. One line says so.
    const alone = await handover.check(
      asPublisher,
      publishing({ audience: "self", userId: required(owner).id })
    );
    expect(alone.pairs).toEqual([
      {
        store: { name: "findings", title: "findings" },
        connection: { name: "exampledata" },
        readers: 1,
        lacking: 0,
        newlyLacking: 0,
        mayConfirm: false
      }
    ]);
    expect(alone.confirmation).toBeUndefined();
    expect(() => requireDataHandover(alone, undefined)).not.toThrow();
    expect(dataHandoverLines(alone, "de")).toEqual({
      holds: true,
      lines: ["Alle, die „findings“ lesen, dürfen eine für dich verborgene Quelle nutzen."]
    });

    // The team: three readers may not use the source. The publisher is told how many and that
    // its holder confirms; the publish is refused without it.
    const team = await handover.check(asPublisher, publishing({ audience: "workspace" }));
    expect(team.pairs).toEqual([
      {
        store: { name: "findings", title: "findings" },
        connection: { name: "exampledata" },
        readers: 4,
        lacking: 3,
        newlyLacking: 3,
        mayConfirm: false
      }
    ]);
    expect(dataHandoverLines(team, "de").lines).toEqual([
      "3 Personen, die „findings“ danach lesen, dürfen eine für dich verborgene Quelle nicht nutzen. Die Weitergabe bestätigt eine Person, die die Quelle verwalten darf, indem sie veröffentlicht."
    ]);
    expect(() => requireDataHandover(team, team.confirmation)).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        details: {
          reason: "data_handover_needs_owner",
          dataStore: "findings",
          title: "findings",
          readers: 3
        }
      })
    );
    // Nobody is named: no id or label of a person leaves the check.
    const said = JSON.stringify([team, dataHandoverLines(team, "en")]);
    for (const someone of [required(owner), ...members]) {
      expect(said).not.toContain(someone.id);
      expect(said).not.toContain(someone.displayLabel);
    }

    // The holder of connection.write sees the source and the store by their titles, and
    // confirms with the token the question gives; another token is no confirmation.
    const kept = await handover.check(asKeeper, publishing({ audience: "workspace" }));
    expect(kept.pairs).toEqual([
      {
        store: { name: "findings", title: "Findings" },
        connection: { name: "exampledata", title: "Exampledata" },
        readers: 4,
        lacking: 3,
        newlyLacking: 3,
        mayConfirm: true
      }
    ]);
    const confirmation = required(kept.confirmation);
    expect(confirmation).toMatch(/^[a-f0-9]{64}$/u);
    expect(dataHandoverLines(kept, "de")).toEqual({
      holds: false,
      lines: [
        "3 Personen, die „Findings“ danach lesen, dürfen „Exampledata“ nicht nutzen. Mit Veröffentlichen bestätigst du die Weitergabe."
      ]
    });
    expect(() => requireDataHandover(kept, undefined)).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        details: expect.objectContaining({ reason: "data_handover_unconfirmed", confirmation })
      })
    );
    expect(() => requireDataHandover(kept, "0".repeat(64))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "data_handover_unconfirmed" })
      })
    );
    expect(() => requireDataHandover(kept, confirmation)).not.toThrow();

    // Once live, publishing the App again hands nothing on anew: the question holds.
    await publishOf(world, "app", "overview", app, "workspace");
    const again = await handover.check(asKeeper, publishing({ audience: "workspace" }));
    expect(again.pairs[0]).toMatchObject({ readers: 4, lacking: 3, newlyLacking: 0 });
    expect(again.confirmation).toBeUndefined();
    expect(() => requireDataHandover(again, undefined)).not.toThrow();
    expect(dataHandoverLines(again, "de")).toEqual({
      holds: true,
      lines: [
        "Diese Veröffentlichung gibt Daten aus „Exampledata“ an niemanden neu weiter, der sie nicht nutzen darf."
      ]
    });

    // A Workflow that adds a second source to the live store hands its data to every reader
    // who may not use it, the owner among them.
    const crmImport = await draftOf(world, "workflow", "import-crm", importing("crm"));
    const crmKeeper = accessOf(keeper, {
      grants: [
        on(keeper, "workflow.publish", crmImport.assetId),
        on(keeper, "connection.write", crm)
      ]
    });
    const second = await handover.check(crmKeeper, [
      { kind: "workflow", name: "import-crm", config: importing("crm") }
    ]);
    expect(second.pairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: { name: "crm", title: "CRM" },
          readers: 4,
          newlyLacking: 4,
          mayConfirm: true
        }),
        expect.objectContaining({
          connection: { name: "exampledata" },
          newlyLacking: 0
        })
      ])
    );
    expect(second.confirmation).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.confirmation).not.toBe(confirmation);

    // A publish that reaches no store asks nothing.
    expect(
      await handover.check(asKeeper, [
        { kind: "app", name: "overview", config: { title: "Overview", manifest: { actions: [] } } }
      ])
    ).toEqual({ pairs: [], truncated: false });
    await db.sql`delete from config_assets where scope_id = ${workspace.id}`;
  });
});
