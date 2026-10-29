import { describe, expect, it } from "vitest";
import type { ConfigAssetKind, ConfigAssetRecord, JsonObject } from "@work-shape/catalyst-core";
import { knowledgeBaseReadsClosedConnection } from "@work-shape/catalyst-data-stores";
import { KNOWLEDGE_BASE_ASSET_KIND } from "@work-shape/catalyst-core";
import { errorSchema } from "./support/access-instance";
import { dataFlowManifest } from "./support/workflow-data-flows";
import { required } from "./support/assertions";
import {
  clientInstanceId,
  finding,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";

// A Knowledge Base answers an outside client (a personal API key) only while the Connections
// its rows come from are open to outside clients: WF-OUT closes what a Connection's admin kept
// from outside clients, and a key's query of a Knowledge Base must not launder it
// (connections-and-secrets.md, Workflows started from outside; the spec wins over cli-parity.md).
// Fails without the check: the key reads the rows of a store a Workflow fills from a Connection
// whose operations are closed to outside clients.

const KB = "findings-kb";

const knowledgeBase: JsonObject = {
  name: KB,
  title: "Findings",
  description: "What the monthly check of bookings found, one row per finding.",
  methods: ["structured"],
  backend: { dataStore: "findings" },
  tables: [{ name: "findings", description: "One row per finding of a run." }]
};

describe("a Knowledge Base query from an outside client", () => {
  const { start, publishStore } = useDataStoreInstance();

  async function setup() {
    const world = await start(true, undefined, undefined, undefined, { apiAccess: true });
    await publishStore(world);
    const inserted = await world.api.call("data_stores.insert", {
      params: { store: "findings" },
      payload: { table: "findings", rows: [finding] }
    });
    expect(inserted.statusCode, inserted.body).toBe(200);
    const written = await world.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config: knowledgeBase, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision: 1 }
    });
    expect(made.statusCode, made.body).toBe(200);
    return world;
  }

  async function connection(
    world: DataStoreInstance,
    name: string,
    operations: { name: string; exposure: string[] }[]
  ) {
    await world.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`connection:${name}`]: null },
      mutations: [{ type: "upsert", kind: "connection", name, config: { operations } }]
    });
  }

  /** A published Workflow whose steps call the operations. */
  async function publishFlow(world: DataStoreInstance, name: string, operations: string[]) {
    const key = `workflow:${name}`;
    const written = await world.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [
        {
          type: "upsert",
          kind: "workflow",
          name,
          draft: true,
          config: { name, manifest: dataFlowManifest(name, operations) }
        }
      ]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await world.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: "workflow",
        name,
        revision
      })
    );
    await world.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "workflow",
      name,
      revision,
      assetId: required(written.assetIds[key]),
      revisionId: stored.id
    });
  }

  /** A live agent with these tools. */
  async function liveAgent(world: DataStoreInstance, name: string, toolNames: string[]) {
    await world.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`agent:${name}`]: null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name,
          config: {
            name,
            displayName: { de: name },
            instructions: "Help",
            toolNames,
            knowledgeBases: []
          }
        }
      ]
    });
  }

  async function keyHeaders(world: DataStoreInstance, scopes: string[]) {
    const issued = await world.api.call("me.api_keys.create", {
      payload: {
        name: "CLI",
        scopes,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    return { authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}` };
  }

  const ask = (world: DataStoreInstance, headers: Record<string, string> = {}) =>
    world.api.call("knowledge_bases.query", {
      params: { knowledgeBase: KB },
      payload: { sql: "select rule_id from findings" },
      headers
    });

  it("answers a key where nothing fills the store from a Connection", async () => {
    const world = await setup();
    const response = await ask(world, await keyHeaders(world, ["knowledge_base.use"]));
    expect(response.statusCode, response.body).toBe(200);
  });

  it("refuses a key while a Workflow fills the store from a Connection closed to outside clients, naming the reason", async () => {
    const world = await setup();
    await connection(world, "crm", [{ name: "read", exposure: ["workflow"] }]);
    await publishFlow(world, "fill-findings", [
      "connection.crm.read",
      "data_store.findings.insert"
    ]);
    const refused = await ask(world, await keyHeaders(world, ["knowledge_base.use"]));
    expect(refused.statusCode, refused.body).toBe(403);
    const { error } = errorSchema.parse(refused.json());
    expect(error.details).toMatchObject({
      reason: "no_grant",
      action: "connection_exposure:outside"
    });
    expect(error.message).toContain("not exposed to outside clients");
    // It names no Connection, and no row is read.
    expect(refused.body).not.toContain("crm");
    expect(refused.body).not.toContain("vat-rate");
    // The person's own call, not made for a key, is not an outside client's.
    const person = await ask(world);
    expect(person.statusCode, person.body).toBe(200);
  });

  it("counts an agent that adds rows to the store and calls a closed Connection, and none that only reads", async () => {
    const world = await setup();
    await connection(world, "crm", [
      { name: "read", exposure: ["workflow", "agent"] },
      { name: "open", exposure: ["agent", "outside"] }
    ]);
    const headers = await keyHeaders(world, ["knowledge_base.use"]);
    await liveAgent(world, "reader", ["connection.crm.read", "data_store.findings.query"]);
    await liveAgent(world, "open-writer", ["connection.crm.open", "data_store.findings.insert"]);
    expect((await ask(world, headers)).statusCode).toBe(200);
    await liveAgent(world, "writer", ["connection.crm.read", "data_store.findings.insert"]);
    const refused = await ask(world, headers);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "no_grant",
      action: "connection_exposure:outside"
    });
    expect(refused.body).not.toContain("crm");
  });

  it("refuses a key where the Connection is gone, as it never guesses open", async () => {
    const world = await setup();
    await publishFlow(world, "fill-findings", [
      "connection.gone.read",
      "data_store.findings.insert"
    ]);
    const refused = await ask(world, await keyHeaders(world, ["knowledge_base.use"]));
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it("answers a key where the Connection operation is exposed to outside clients, or the Workflow adds no row", async () => {
    const world = await setup();
    await connection(world, "crm", [
      { name: "read", exposure: ["workflow", "outside"] },
      { name: "write", exposure: ["workflow"] }
    ]);
    await publishFlow(world, "fill-findings", [
      "connection.crm.read",
      "data_store.findings.insert"
    ]);
    // A Workflow that only reads the store and calls a closed operation fills nothing.
    await publishFlow(world, "report", ["connection.crm.write", "data_store.findings.query"]);
    const headers = await keyHeaders(world, ["knowledge_base.use"]);
    const response = await ask(world, headers);
    expect(response.statusCode, response.body).toBe(200);
  });
});

describe("what makes a Knowledge Base read a closed Connection", () => {
  const at = new Date(0).toISOString();
  const asset = (kind: ConfigAssetKind, name: string, config: JsonObject): ConfigAssetRecord => ({
    id: `${kind}-${name}`,
    clientInstanceId,
    kind,
    name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: "rev-1",
    revision: 1,
    config,
    publishedConfig: config,
    createdAt: at,
    updatedAt: at
  });
  const deps = (assets: ConfigAssetRecord[]) => ({
    clientInstanceId,
    configAssets: {
      getConfigAsset: ({ kind, name }: { kind: ConfigAssetKind; name: string }) =>
        Promise.resolve(assets.find((entry) => entry.kind === kind && entry.name === name)),
      listPublishedConfigAssets: ({ kind }: { kind?: string }) =>
        Promise.resolve(assets.filter((entry) => entry.kind === kind)),
      listActiveConfigAssets: ({ kind }: { kind?: string }) =>
        Promise.resolve(assets.filter((entry) => entry.kind === kind))
    }
  });
  const synced: Parameters<typeof knowledgeBaseReadsClosedConnection>[1] = {
    name: "contracts",
    title: "Contracts",
    description: "Signed contracts.",
    methods: ["semantic"],
    sources: [{ id: "sp", connection: "sharepoint", folders: ["f1"] }]
  };

  it("counts every synced source as closed: no operation exposes it to outside clients", async () => {
    await expect(
      knowledgeBaseReadsClosedConnection(
        deps([
          asset("connection", "sharepoint", {
            operations: [{ name: "list", exposure: ["workflow", "outside"] }]
          })
        ]),
        synced
      )
    ).resolves.toBe(true);
    await expect(
      knowledgeBaseReadsClosedConnection(deps([]), { ...synced, sources: undefined })
    ).resolves.toBe(false);
  });

  const onStore: Parameters<typeof knowledgeBaseReadsClosedConnection>[1] = {
    name: "accounts",
    title: "Accounts",
    description: "Accounts.",
    methods: ["structured"],
    backend: { dataStore: "ledger" },
    tables: [{ name: "entries", description: "Entries." }]
  };
  const workflow = (name: string, publishedConfig: JsonObject) => ({
    ...asset("workflow", name, publishedConfig),
    publishedConfig
  });

  it("counts a writer set that cannot be read as closed: an unreadable Workflow, App or agent", async () => {
    for (const unreadable of [
      workflow("odd", { manifest: "no steps" }),
      asset("app", "odd", { manifest: "no actions" }),
      asset("agent", "odd", { name: "odd" })
    ]) {
      await expect(
        knowledgeBaseReadsClosedConnection(deps([unreadable]), onStore),
        unreadable.kind
      ).resolves.toBe(true);
    }
    await expect(knowledgeBaseReadsClosedConnection(deps([]), onStore)).resolves.toBe(false);
  });

  it("counts a writer set too large to read as closed", async () => {
    const crowd = Array.from({ length: 5_000 }, (_, index) =>
      asset("agent", `agent-${String(index).padStart(5, "0")}`, { toolNames: [] })
    );
    const many = { ...deps(crowd), configAssets: { ...deps(crowd).configAssets } };
    // Every page is full, so the pages never end within what a read looks through.
    many.configAssets.listActiveConfigAssets = () => Promise.resolve(crowd.slice(0, 500));
    await expect(knowledgeBaseReadsClosedConnection(many, onStore)).resolves.toBe(true);
  });
});
