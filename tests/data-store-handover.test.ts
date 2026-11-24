import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  dataHandoverGaps,
  dataHandoverLines,
  dataHandoverRights,
  dataHandoverSubject,
  requireDataHandover,
  type AppAvailability,
  type AssetScope,
  type AuthenticatedUser,
  type JsonObject,
  type PermissionGrant,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";
import { z } from "zod";
import { agent } from "./support/access-instance";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";

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

const asPerson = { person: true };

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
        store: { kind: "data_store", name: "findings", title: "findings" },
        connection: { name: "exampledata", assetId: exampledata },
        readers: 1,
        lacking: 0,
        newlyLacking: 0,
        mayConfirm: false
      }
    ]);
    expect(alone.confirmation).toBeUndefined();
    expect(() => requireDataHandover(alone, undefined, asPerson)).not.toThrow();
    expect(dataHandoverLines(alone, "de")).toEqual({
      holds: true,
      lines: ["Alle, die „findings“ lesen, dürfen eine für dich verborgene Quelle nutzen."]
    });

    // The team: three readers may not use the source. The publisher is told how many and that
    // the publish waits for a person who may change the source; they cannot confirm it.
    const team = await handover.check(asPublisher, publishing({ audience: "workspace" }));
    expect(team.pairs).toEqual([
      {
        store: { kind: "data_store", name: "findings", title: "findings" },
        connection: { name: "exampledata", assetId: exampledata },
        readers: 4,
        lacking: 3,
        newlyLacking: 3,
        mayConfirm: false
      }
    ]);
    expect(dataHandoverLines(team, "de").lines).toEqual([
      "3 Personen, die „findings“ danach lesen, dürfen eine für dich verborgene Quelle nicht nutzen. Die Veröffentlichung wartet im Eingang, bis eine Person, die die Quelle verwalten darf, die Weitergabe freigibt."
    ]);
    expect(() => requireDataHandover(team, team.confirmation, asPerson)).toThrow(
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
        store: { kind: "data_store", name: "findings", title: "Findings" },
        connection: { name: "exampledata", assetId: exampledata, title: "Exampledata" },
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
    expect(() => requireDataHandover(kept, undefined, asPerson)).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        details: expect.objectContaining({ reason: "data_handover_unconfirmed", confirmation })
      })
    );
    expect(() => requireDataHandover(kept, "0".repeat(64), asPerson)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "data_handover_unconfirmed" })
      })
    );
    expect(() => requireDataHandover(kept, confirmation, asPerson)).not.toThrow();
    // A key or a service principal never confirms, whatever rights it holds.
    expect(() => requireDataHandover(kept, confirmation, { person: false })).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({ reason: "data_handover_person_only" })
      })
    );

    // Once live, publishing the App again hands nothing on anew: the question holds.
    await publishOf(world, "app", "overview", app, "workspace");
    const again = await handover.check(asKeeper, publishing({ audience: "workspace" }));
    expect(again.pairs[0]).toMatchObject({ readers: 4, lacking: 3, newlyLacking: 0 });
    expect(again.confirmation).toBeUndefined();
    expect(() => requireDataHandover(again, undefined, asPerson)).not.toThrow();
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
          connection: { name: "crm", assetId: crm, title: "CRM" },
          readers: 4,
          newlyLacking: 4,
          mayConfirm: true
        }),
        expect.objectContaining({
          connection: { name: "exampledata", assetId: exampledata },
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

  it("asks at every change that widens who reads a store's rows or adds a source to it", async () => {
    const world = await published("widening");
    const { clientInstanceId } = world;
    const stores = db.store;
    const [owner, ...members] = await Promise.all(
      ["Owner", "Member One", "Member Two", "Member Three"].map((displayLabel) =>
        stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] })
      )
    );
    const first = required(owner);
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: first.id
    });
    for (const member of members) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: member.id,
        role: "member"
      });
    }
    const written = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: {
        "connection:exampledata": null,
        "connection:crm": null,
        "connection:box": null
      },
      mutations: ["exampledata", "crm", "box"].map((name) => ({
        type: "upsert" as const,
        kind: "connection",
        name,
        config: { displayName: name.toUpperCase() }
      }))
    });
    const connectionId = (name: string) => required(written.assetIds[`connection:${name}`]);
    const grant = (
      holderId: string,
      action: string,
      scopeId: string,
      scopeKind: "asset" | "workspace" = "asset"
    ) =>
      stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId,
        action,
        effect: "allow",
        scopeKind,
        scopeId,
        grantedBy: asUserId("usr_handover_admin")
      });
    // The owner may use every source; the three other members may use none.
    for (const name of ["exampledata", "crm", "box"]) {
      await grant(first.id, "connection.use", connectionId(name));
    }
    await publishOf(
      world,
      "workflow",
      "import",
      await draftOf(world, "workflow", "import", importing("exampledata"))
    );
    const handover = required(world.dataStores.publishNarrativeData.handover);
    const exampledata = { name: "exampledata", assetId: connectionId("exampledata") };

    // A Knowledge Base on the store offered in every workspace: its four members read the rows.
    const guide = await draftOf(world, "knowledge_base", "guide", {
      title: "Guide",
      backend: { dataStore: "findings" }
    });
    await publishOf(world, "knowledge_base", "guide", guide);
    const offered = await handover.check(undefined, [
      {
        kind: "knowledge_base",
        name: "guide",
        availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
      }
    ]);
    expect(offered.pairs).toEqual([
      {
        store: { kind: "data_store", name: "findings", title: "findings" },
        connection: exampledata,
        readers: 4,
        lacking: 3,
        newlyLacking: 3,
        mayConfirm: false
      }
    ]);
    expect(offered.confirmation).toMatch(/^[a-f0-9]{64}$/u);
    // Offered in no workspace, it hands nothing on.
    const hidden = await handover.check(undefined, [
      {
        kind: "knowledge_base",
        name: "guide",
        availability: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
      }
    ]);
    expect(hidden.confirmation).toBeUndefined();

    // A move of the store into the workspace: a grant on what the workspace owns reaches it.
    await grant(required(members[0]).id, "data_store.read", workspace.id, "workspace");
    const moved = await handover.check(undefined, [
      {
        kind: "data_store",
        name: "findings",
        scope: { kind: "workspace", workspaceId: workspace.id }
      }
    ]);
    expect(moved.pairs).toEqual([
      expect.objectContaining({ connection: exampledata, lacking: 1, newlyLacking: 1 })
    ]);
    expect(moved.confirmation).toMatch(/^[a-f0-9]{64}$/u);

    // A Knowledge Base whose synced source is a Box-like Connection: who may use the base reads
    // the documents, and three of them may not use the source.
    await publishOf(
      world,
      "knowledge_base",
      "handbook",
      await draftOf(world, "knowledge_base", "handbook", { title: "Handbook" })
    );
    const handbook = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "handbook"
      })
    );
    for (const reader of [first, ...members]) {
      await grant(reader.id, "knowledge_base.use", handbook.id);
    }
    const keeper = person("usr_handover_keeper");
    const asKeeper = accessOf(keeper, {
      grants: [
        on(keeper, "knowledge_base.publish", handbook.id),
        on(keeper, "knowledge_base.read", handbook.id),
        on(keeper, "connection.write", connectionId("box"))
      ]
    });
    const synced = {
      title: "Handbook",
      sources: [{ id: "box", connection: "box", folders: ["1"] }]
    };
    const syncing = await handover.check(asKeeper, [
      { kind: "knowledge_base", name: "handbook", config: synced }
    ]);
    expect(syncing.pairs).toEqual([
      {
        store: { kind: "knowledge_base", name: "handbook", title: "Handbook" },
        connection: { name: "box", assetId: connectionId("box"), title: "BOX" },
        readers: 4,
        lacking: 3,
        newlyLacking: 3,
        mayConfirm: true
      }
    ]);
    expect(dataHandoverLines(syncing, "de").lines).toEqual([
      "3 Personen, die „Handbook“ danach lesen, dürfen „BOX“ nicht nutzen. Mit Veröffentlichen bestätigst du die Weitergabe."
    ]);
    expect(() => requireDataHandover(syncing, undefined, asPerson)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "data_handover_unconfirmed",
          knowledgeBase: "handbook"
        })
      })
    );
    // Once the source is live, a revision that keeps it hands nothing on anew.
    await publishOf(
      world,
      "knowledge_base",
      "handbook",
      await draftOf(world, "knowledge_base", "handbook", synced)
    );
    const resynced = await handover.check(asKeeper, [
      { kind: "knowledge_base", name: "handbook", config: { ...synced, title: "Manual" } }
    ]);
    expect(resynced.pairs).toEqual([expect.objectContaining({ lacking: 3, newlyLacking: 0 })]);
    expect(resynced.confirmation).toBeUndefined();

    // An agent given the store's row tools and a Connection's calls adds that Connection as a
    // source: everyone who reads the rows now and may not use it receives its data.
    for (const reader of [first, ...members]) {
      await grant(reader.id, "data_store.read", world.id);
    }
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:assistant": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: { displayName: "Assistant", toolNames: [] }
        }
      ]
    });
    const tooled = await handover.check(undefined, [
      {
        kind: "agent",
        name: "assistant",
        config: {
          displayName: "Assistant",
          toolNames: ["data_store.findings.insert", "connection.crm.list"]
        }
      }
    ]);
    expect(tooled.pairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection: { name: "crm", assetId: connectionId("crm") },
          readers: 4,
          lacking: 3,
          newlyLacking: 3
        }),
        expect.objectContaining({ connection: exampledata, newlyLacking: 0 })
      ])
    );
    expect(tooled.confirmation).toMatch(/^[a-f0-9]{64}$/u);
    await db.sql`delete from config_assets where scope_id = ${workspace.id}`;
  });

  it("lets nothing pass where the read was cut short", () => {
    const pair = {
      store: { kind: "data_store", name: "findings", title: "Findings" },
      connection: { name: "crm", assetId: "asset_crm", title: "CRM" },
      readers: 4,
      lacking: 3,
      newlyLacking: 0,
      mayConfirm: true
    };
    const cut = { pairs: [pair], confirmation: "a".repeat(64), truncated: true };
    expect(dataHandoverGaps(cut)).toEqual([pair]);
    expect(() => requireDataHandover(cut, undefined, asPerson)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "data_handover_unconfirmed" })
      })
    );
    expect(() => requireDataHandover(cut, "a".repeat(64), asPerson)).not.toThrow();
    expect(dataHandoverLines(cut, "de")).toEqual({
      holds: false,
      lines: [
        "Nicht alle veröffentlichten Assets konnten gelesen werden, deshalb braucht diese Veröffentlichung eine bestätigte Weitergabe.",
        "Wer „Findings“ danach liest, darf „CRM“ vielleicht nicht nutzen. Mit Veröffentlichen bestätigst du die Weitergabe."
      ]
    });
    // No source found at all: only an approver of operations lets it through.
    const blind = { pairs: [], confirmation: "b".repeat(64), truncated: true };
    expect(() => requireDataHandover(blind, "b".repeat(64), asPerson)).toThrow(
      expect.objectContaining({
        details: { reason: "data_handover_needs_owner", truncated: true }
      })
    );
    expect(dataHandoverSubject(blind)).toEqual({
      handover: { confirmation: "b".repeat(64), connections: [], pairs: [], truncated: true }
    });
    expect(dataHandoverRights(dataHandoverSubject(cut))).toEqual([
      {
        permission: "connection.write",
        resource: { kind: "connection", name: "crm", assetId: "asset_crm" }
      }
    ]);
  });
});

// DS-13c on an assembled instance (check 68): the widening check runs on the server, inside
// every change that widens who reads a store's rows or adds a source. A change that hands a
// source's data to people who may not use it waits in the Inbox until a person who holds
// `connection.write` on the source approves it; that approval is the confirmation. Such a
// person who makes the change themselves confirms it with the token the question gives. A key
// never confirms. The question counts the people and never names them.

const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string() }).loose()
  })
});
const heldSchema = z.looseObject({
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const questionSchema = z.object({
  publishHandover: z.object({
    holds: z.boolean(),
    lines: z.array(z.string()),
    confirmation: z.string().optional()
  })
});

/** A person the development sign-in knows, resolved to the same row as `person` resolves. */
const devUser = (id: string, roles: string[]) => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles,
  permissionRefs: [],
  authSource: "test"
});
const developmentAuth = {
  enabled: true,
  users: [
    devUser("user-1", ["user", "admin", "superadmin"]),
    devUser("reviewer", ["user"]),
    devUser("keeper", ["user"])
  ]
};
const as = (id: string) => ({ "x-dev-user-id": id });

const importing = (name: string, connection: string, store = "findings"): JsonObject => ({
  name,
  manifest: {
    id: name,
    name: `Import ${connection}`,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: `connection.${connection}.list`,
        input: {}
      },
      {
        id: "store",
        name: "Store",
        type: "operation",
        operation: `data_store.${store}.insert`,
        input: {}
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
});
/** A Connection whose one call an agent may be given. */
const connectionOf = (name: string, displayName: string): JsonObject => ({
  name,
  displayName,
  connectorType: "http_api",
  origin: "release",
  enabled: true,
  ownerPrincipalId: "system",
  authScheme: "none",
  credentialMode: "shared",
  settings: { baseUrl: "https://example.com" },
  operations: [
    {
      name: "list",
      enabled: true,
      effect: "reading",
      exposure: ["agent"],
      method: "GET",
      path: "/list"
    }
  ]
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

describe("the widening check inside a change", () => {
  // The file also holds a suite-wide world, so each test here clears its own state.
  const { start, publishStore, person } = useDataStoreInstance({ resetStateOnCleanup: true });

  /** A team of three who read the store through an App, and the instance's Connections. */
  async function team(world: DataStoreInstance) {
    await publishStore(world);
    const { stores } = world;
    const members = await Promise.all(
      ["member-a", "member-b", "member-c"].map((name) => person(world, name, ["user"]))
    );
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: asUserId(required(members[0]).id)
    });
    for (const member of members.slice(1)) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(member.id),
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
          config: connectionOf("exampledata", "Exampledata")
        },
        { type: "upsert", kind: "connection", name: "crm", config: connectionOf("crm", "CRM") }
      ]
    });

    /** Writes an asset's revision, and makes it live where `live`. */
    async function write(
      kind: string,
      name: string,
      config: JsonObject,
      live?: { workspaceId?: CollaborationWorkspaceId }
    ) {
      const key = `${kind}:${name}`;
      const current = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
      const saved = await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: current?.revision ?? null },
        mutations: [
          {
            type: "upsert",
            kind,
            name,
            config,
            draft: true,
            ...(live?.workspaceId
              ? { scope: { kind: "workspace", workspaceId: live.workspaceId } }
              : {})
          }
        ]
      });
      const revision = required(saved.revisions[key]);
      if (live) {
        const stored = required(
          await stores.configAssets.getConfigAssetRevision({
            clientInstanceId,
            kind,
            name,
            revision
          })
        );
        await stores.configAssets.publishConfigAssetRevision({
          clientInstanceId,
          kind,
          name,
          assetId: required(saved.assetIds[key]),
          revision,
          revisionId: stored.id,
          ...(live.workspaceId && kind === "app" ? { audience: "workspace" as const } : {})
        });
      }
      return revision;
    }

    const grant = async (name: string, action: string, scopeId?: string) =>
      stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: (await person(world, name, ["user"])).id,
        action,
        effect: "allow",
        scopeKind: scopeId ? "asset" : "instance",
        ...(scopeId ? { scopeId } : {}),
        grantedBy: asUserId("usr_handover_admin")
      });
    const handedOver = async () =>
      (await stores.audit.listAuditEvents({ clientInstanceId })).filter(
        (event) => event.type === "data_store.handover_confirmed"
      );
    return {
      members,
      workspace,
      write,
      grant,
      handedOver,
      exampledata: required(connections.assetIds["connection:exampledata"]),
      crm: required(connections.assetIds["connection:crm"])
    };
  }

  it("holds an unconfirmed hand-over for a person who may change the source, and lets only a person confirm", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, grant, handedOver, crm } = await team(world);
    // The team reads the store's rows through its App.
    await write("app", "overview", overview, { workspaceId: workspace.id });
    // A Workflow would add rows to the store from a Connection the team may not use.
    const revision = await write("workflow", "import", importing("import", "exampledata"));

    // The question names how many of the team may not use the source, and the confirmation.
    const read = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(read.statusCode, read.body).toBe(200);
    const question = questionSchema.parse(read.json()).publishHandover;
    // In the instance's language, here its English.
    expect(question).toMatchObject({
      holds: false,
      lines: [
        "3 people who read “Findings” after this publish may not use “Exampledata”. Publishing confirms the hand-over."
      ]
    });
    const confirmation = required(question.confirmation);
    for (const member of members) {
      expect(read.body).not.toContain(member.id);
      expect(read.body).not.toContain(member.displayLabel);
    }

    const publish = (
      name: string,
      at: number,
      confirmHandover?: string,
      headers: Record<string, string> = as("user-1")
    ) =>
      world.api.call("assets.publish", {
        params: { kind: "workflow", name },
        payload: { revision: at, ...(confirmHandover ? { confirmHandover } : {}) },
        headers
      });
    const live = async (name: string) =>
      (await stores.configAssets.getConfigAsset({ clientInstanceId, kind: "workflow", name }))
        ?.publishedRevisionId;

    // A confirmation of another hand-over is refused with the current one.
    const other = await publish("import", revision, "0".repeat(64));
    expect(other.statusCode, other.body).toBe(409);
    expect(refusalSchema.parse(other.json()).error).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "data_handover_unconfirmed",
        dataStore: "findings",
        readers: 3,
        connection: "exampledata",
        confirmation
      }
    });

    // A key confirms nothing, though its holder holds connection.write.
    const issued = await world.api.call("me.api_keys.create", {
      payload: {
        name: "Publisher key",
        scopes: [
          "workflow.read",
          "workflow.publish",
          "data_store.read",
          "data_store.insert",
          "connection.use"
        ],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      },
      headers: as("user-1")
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const byKey = await publish("import", revision, confirmation, {
      authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`
    });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(refusalSchema.parse(byKey.json()).error.details.reason).toBe(
      "data_handover_person_only"
    );
    expect(await live("import")).toBeFalsy();

    // The person who may change the source confirms it with the token: it goes live at once and
    // the hand-over is audited by how many, never whom.
    const confirmed = await publish("import", revision, confirmation);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await live("import")).toBeTruthy();
    const direct = await handedOver();
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(direct)).toContain('"people":3');
    expect(JSON.stringify(direct)).toContain('"confirmedBy":"caller"');
    for (const member of members) expect(JSON.stringify(direct)).not.toContain(member.id);

    // Published again, the Workflow hands nothing on anew: the question holds in one line.
    const again = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(again.json()).toMatchObject({
      publishHandover: {
        holds: true,
        lines: ["This publish hands data from “Exampledata” to nobody new who may not use it."]
      }
    });

    // A second source, published without a confirmation, waits in the Inbox: no policy lets it
    // through, and the instance admin who filed it is no exception.
    const second = await write("workflow", "import-crm", importing("import-crm", "crm"));
    const held = await publish("import-crm", second);
    expect(held.statusCode, held.body).toBe(202);
    const { approvalRequestId } = heldSchema.parse(held.json());
    expect(await live("import-crm")).toBeFalsy();

    const decide = async (userId: string) => {
      const response = await world.api.call("approval_requests.decide", {
        params: { requestId: approvalRequestId },
        payload: { decision: "approve" },
        headers: as(userId)
      });
      await getTestJobs(world.api).runDue();
      return response;
    };
    // The Workflow's publish review asks its approver; one who may not change the source
    // cannot decide it.
    await grant("reviewer", "workflow.approve");
    const refused = await decide("reviewer");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await live("import-crm")).toBeFalsy();
    // One who holds connection.write on it can: the approval is the confirmation.
    await grant("keeper", "workflow.approve");
    await grant("keeper", "connection.write", crm);
    const approved = await decide("keeper");
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await live("import-crm")).toBeTruthy();
    const both = await handedOver();
    expect(both).toHaveLength(2);
    const byApprover = JSON.stringify(both.find((event) => event.id !== direct[0]?.id));
    expect(byApprover).toContain('"confirmedBy":"approver"');
    expect(byApprover).toContain('"connection":"crm"');
    expect(byApprover).toContain('"people":3');
  });

  it("holds a Knowledge Base offered to more readers and a Data Store moved to the team", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, handedOver } = await team(world);
    await write("workflow", "import", importing("import", "exampledata"), {});

    // A Data Store of the admin's own workspace that a Workflow fills from the source, moved to
    // the team, where a member reads what the team owns.
    const admin = asUserId((await person(world, "user-1", ["user", "admin", "superadmin"])).id);
    const own = await stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: admin
    });
    await write(
      "data_store",
      "orders",
      { name: "orders", title: "Orders", migrations: [] },
      {
        workspaceId: own.id
      }
    );
    await write(
      "workflow",
      "import-orders",
      importing("import-orders", "exampledata", "orders"),
      {}
    );
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: required(members[1]).id,
      action: "data_store.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspace.id,
      grantedBy: admin
    });
    const moved = await world.api.call("assets.move", {
      params: { kind: "data_store", name: "orders" },
      payload: { workspaceId: own.id, to: { kind: "workspace", workspaceId: workspace.id } },
      headers: as("user-1")
    });
    expect(moved.statusCode, moved.body).toBe(202);
    heldSchema.parse(moved.json());
    expect(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "data_store",
        name: "orders"
      })
    ).toMatchObject({ scope: { kind: "workspace", workspaceId: own.id } });

    // A Knowledge Base on the store, offered in no workspace yet.
    await write(
      "knowledge_base",
      "guide",
      { title: "Guide", backend: { dataStore: "findings" } },
      {}
    );
    const offer = (confirmHandover?: string) =>
      world.api.call("assets.set_availability", {
        params: { kind: "knowledge_base", name: "guide" },
        payload: { mode: "all", ...(confirmHandover ? { confirmHandover } : {}) },
        headers: as("user-1")
      });
    const offered = await offer();
    expect(offered.statusCode, offered.body).toBe(202);
    heldSchema.parse(offered.json());
    expect(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "guide"
      })
    ).not.toMatchObject({ availability: { mode: "all" } });
    const stale = await offer("0".repeat(64));
    expect(stale.statusCode, stale.body).toBe(409);
    const token = z
      .object({ error: z.object({ details: z.object({ confirmation: z.string() }) }) })
      .parse(stale.json()).error.details.confirmation;
    const confirmed = await offer(token);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await handedOver()).toHaveLength(1);
  });

  it("holds an agent made or given tools that add a source, and shows its approver what it hands on", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true, connections: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, grant, handedOver, crm, exampledata } = await team(world);
    await write("app", "overview", overview, { workspaceId: workspace.id });
    await grant("keeper", "operations.approve");
    await grant("keeper", "connection.write", crm);
    const agentOf = async (name: string) =>
      stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name });
    const approve = async (requestId: string) => {
      const response = await world.api.call("approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" },
        headers: as("keeper")
      });
      await getTestJobs(world.api).runDue();
      return response;
    };
    const tools = ["data_store.findings.insert", "connection.crm.list"];
    // The instance's own agent, which has no tools yet.
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:helper": null },
      baseDefaultAgentName: null,
      mutations: [
        { type: "upsert", kind: "agent", name: "helper", config: agent("helper") },
        { type: "setDefaultAgent", agentName: "helper" }
      ]
    });

    // An agent made with the store's row tools and a Connection's call at once is live at once:
    // nothing of it was there before, so its source is new, and it waits for a person.
    const made = await world.api.call("assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        expectedRevision: null,
        config: agent("assistant", { toolNames: tools })
      },
      headers: as("user-1")
    });
    expect(made.statusCode, made.body).toBe(202);
    const madeRequest = heldSchema.parse(made.json()).approvalRequestId;
    expect(await agentOf("assistant")).toBeUndefined();

    // Who decides it reads what the caller was told: how many people, the store only where
    // they may see it, and the source they may change.
    const opened = await world.api.call("approval_requests.get", {
      params: { requestId: madeRequest },
      headers: as("keeper")
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({
      preview: {
        handover: [
          "3 people who read a store hidden from you afterwards may not use “CRM”.",
          "Approving confirms the hand-over."
        ]
      }
    });
    for (const member of members) expect(opened.body).not.toContain(member.id);

    const approved = await approve(madeRequest);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await agentOf("assistant")).toMatchObject({ config: { toolNames: tools } });
    const created = await handedOver();
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created)).toContain('"change":"create"');
    expect(JSON.stringify(created)).toContain('"confirmedBy":"approver"');

    // Tools given to a live agent are a publish of them: one that adds a source waits as well.
    await grant("keeper", "connection.write", exampledata);
    const giving = ["data_store.findings.insert", "connection.exampledata.list"];
    const helper = required(await agentOf("helper"));
    const given = await world.api.call("agents.give_tools", {
      params: { name: "helper" },
      payload: { agentId: helper.id, toolNames: giving, expectedLiveRevision: helper.revision },
      headers: as("user-1")
    });
    expect(given.statusCode, given.body).toBe(202);
    expect(await agentOf("helper")).toMatchObject({ config: { toolNames: [] } });
    const givenApproved = await approve(heldSchema.parse(given.json()).approvalRequestId);
    expect(givenApproved.statusCode, givenApproved.body).toBe(200);
    expect(await agentOf("helper")).toMatchObject({ config: { toolNames: giving } });
    const both = await handedOver();
    expect(both).toHaveLength(2);
    expect(JSON.stringify(both)).toContain('"change":"give_tools"');
    expect(JSON.stringify(both)).toContain('"connection":"exampledata"');

    // An agent offered everywhere with the consent to offer what it uses offers its Knowledge
    // Base on the store as well: a reader of another team reads the rows through it now, so it
    // waits as the Knowledge Base's own availability does.
    const other = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Other",
      creatorUserId: asUserId((await person(world, "reviewer", ["user"])).id)
    });
    expect(other.id).toBeTruthy();
    await write(
      "knowledge_base",
      "guide",
      { title: "Guide", backend: { dataStore: "findings" } },
      {}
    );
    const saved = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:berater": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "berater",
          config: agent("berater", { knowledgeBases: ["guide"] })
        }
      ]
    });
    const offered = await world.api.call("assets.set_availability", {
      params: { kind: "agent", name: "berater" },
      payload: {
        mode: "all",
        makeDependenciesAvailable: true,
        expectedRevision: required(saved.revisions["agent:berater"])
      },
      headers: as("user-1")
    });
    expect(offered.statusCode, offered.body).toBe(202);
    heldSchema.parse(offered.json());
    const guideOffered = await stores.configAssets.listAgentAvailability({
      clientInstanceId,
      kind: "knowledge_base",
      agentName: "guide"
    });
    expect(guideOffered.get("guide")?.mode).not.toBe("all");
  });
});
