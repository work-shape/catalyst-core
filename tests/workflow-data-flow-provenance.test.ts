import { describe, expect, it } from "vitest";
import {
  NoopAuditRecorder,
  createPlatformId,
  asUserId,
  type AuthenticatedUser,
  type JsonObject
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";
import { dataFlowManifest } from "./support/workflow-data-flows";
import { useDataStoreWorld } from "./support/data-store-world";

// Exercise the same registered read the Data Store page calls, with live revisions and rights.
describe("data flow provenance", () => {
  const { db, published } = useDataStoreWorld("workflow_data_flows");
  type World = Awaited<ReturnType<typeof published>>;
  const actor = (world: World, admin: boolean): AuthenticatedUser => ({
    clientInstanceId: world.clientInstanceId,
    id: "reader",
    externalUserId: "reader",
    displayLabel: "Reader",
    roles: admin ? ["admin"] : ["user"],
    permissionRefs: [],
    authSource: "test"
  });
  const config = (
    name: string,
    operations: string[],
    kind: "data" | "process" = "data"
  ): JsonObject => ({
    name,
    manifest: dataFlowManifest(name, operations, { kind, nested: true })
  });
  async function put(
    world: World,
    name: string,
    config: JsonObject,
    base: number | null = null,
    publish = true
  ) {
    const key = `workflow:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { [key]: base },
      mutations: [{ type: "upsert", kind: "workflow", name, config, draft: true }]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind: "workflow",
        name,
        revision
      })
    );
    const assetId = required(written.assetIds[key]);
    if (publish)
      await db.store.configAssets.publishConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind: "workflow",
        name,
        revision,
        assetId,
        revisionId: stored.id
      });
    return { id: assetId, revision };
  }
  async function read(world: World, admin = true, allowedUse?: string) {
    const user = actor(world, admin);
    const operation = required(
      await world.dataStores.operationSource.resolve("data_store.findings.used_by")
    );
    return operation.execute(
      {},
      {
        runId: createPlatformId<"OperationRunId">("opr"),
        actor: user,
        origin: { kind: "user" },
        correlationId: "flows",
        access: accessOf(user, {
          grants: allowedUse
            ? [
                {
                  id: "flow-use",
                  clientInstanceId: world.clientInstanceId,
                  holderKind: "user",
                  holderId: user.id,
                  action: "workflow.use",
                  effect: "allow",
                  scopeKind: "asset",
                  scopeId: allowedUse,
                  grantedBy: asUserId(user.id),
                  createdAt: new Date().toISOString()
                }
              ]
            : []
        }),
        audit: new NoopAuditRecorder(),
        runtime: {}
      }
    );
  }
  it("derives published data writers at every depth, without following a later draft", async () => {
    const world = await published("live");
    const flow = await put(
      world,
      "import",
      config("import", [
        "data_store.findings.records.propose",
        "data_store.findings.records.propose"
      ])
    );
    await put(world, "draft", config("draft", ["data_store.findings.insert"]), null, false);
    await put(world, "process", config("process", ["data_store.findings.insert"], "process"));
    await put(world, "other", config("other", ["data_store.other.records.propose"]));
    await put(world, "reader", config("reader", ["data_store.findings.query"]));
    await put(
      world,
      "import",
      config("import", ["data_store.other.records.propose"]),
      flow.revision,
      false
    );
    expect(await read(world)).toMatchObject({
      dataFlows: {
        fills: [{ id: flow.id, name: "import", title: "Title import" }],
        processes: [],
        hidden: { fills: 0, processes: 0 },
        truncated: false
      }
    });
    await put(
      world,
      "import",
      config("import", ["data_store.other.records.propose"]),
      flow.revision + 1
    );
    expect(await read(world)).not.toHaveProperty("dataFlows");
  });
  it("serves the published view through use and withholds names without read or use", async () => {
    const world = await published("hidden");
    const flow = await put(
      world,
      "confidential",
      config("confidential", ["data_store.findings.records.propose"])
    );
    await put(
      world,
      "private-process",
      config("private-process", ["data_store.findings.insert"], "process")
    );
    const response = await read(world, false);
    expect(response).toMatchObject({
      dataFlows: {
        fills: [],
        processes: [],
        hidden: { fills: 1, processes: 0 },
        truncated: false
      }
    });
    // The process writer and the data writer are distinct: the combined count is exact.
    expect(response).toMatchObject({ hidden: { fills: 2 } });
    expect(JSON.stringify(response)).not.toContain(flow.id);
    expect(JSON.stringify(response)).not.toContain("confidential");
    const usable = await read(world, false, flow.id);
    expect(usable).toMatchObject({
      dataFlows: {
        fills: [{ id: flow.id, name: "confidential", title: "Title confidential" }],
        processes: [],
        hidden: { fills: 0, processes: 0 },
        truncated: false
      },
      hidden: { fills: 1 }
    });
    expect(JSON.stringify(usable)).not.toContain("private-process");
  });
});
