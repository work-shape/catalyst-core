import { describe, expect, it } from "vitest";
import type {
  ConfigAssetKind,
  ConfigAssetRecord,
  JsonObject,
  WorkflowManifest
} from "@work-shape/catalyst-core";
import { workflowOutsideBlockers } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";

// What keeps a Workflow from being started from outside, read from its definition: the scan
// is closed by default. A Connection operation is open where it is exposed to `outside`, a
// Knowledge Base where nothing fills it from a source, a Data Store's operations and mail
// where they are named; every other operation, an App's action or an API operation that reads
// runs as the Workflow's account, is closed (connections-and-secrets.md, Workflows started from
// outside). Fails without the allowlist: `workflows.list_step_runs` and a Knowledge Base filled
// by a Workflow passed.

const op = (id: string, operation: string) => ({
  id,
  name: id,
  type: "operation" as const,
  operation,
  input: {}
});

function manifest(operations: string[]): Pick<WorkflowManifest, "id" | "steps"> {
  return {
    id: "outside",
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "outside" }] },
      ...operations.map((operation, index) => op(`s${index}`, operation)),
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}

const assets: Record<string, JsonObject> = {
  "connection/crm": {
    operations: [
      { name: "echo", exposure: ["workflow", "outside"] },
      { name: "write", exposure: ["workflow"] }
    ]
  },
  "knowledge_base/uploads": { sources: [] },
  "knowledge_base/filled": { sources: [{ kind: "workflow", workflow: "fill" }] },
  "knowledge_base/box": { sources: [{ kind: "connection", connection: "box" }] }
};

function assetOf(kind: ConfigAssetKind, name: string): ConfigAssetRecord | undefined {
  const config = assets[`${kind}/${name}`];
  if (!config) return undefined;
  const at = new Date(0).toISOString();
  return {
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
  };
}

const deps: Parameters<typeof workflowOutsideBlockers>[1] = {
  clientInstanceId,
  configAssets: {
    getConfigAsset: ({ kind, name }) => Promise.resolve(assetOf(kind, name))
  },
  definitions: { read: () => Promise.resolve(undefined) }
};

describe("what keeps a Workflow from outside clients", () => {
  it("opens a Connection operation exposed to outside, a Data Store, mail and an uploaded Knowledge Base", async () => {
    await expect(
      workflowOutsideBlockers(
        manifest([
          "connection.crm.echo",
          "data_store.leads.query",
          "mail.send",
          "knowledge.uploads.search",
          "knowledge.uploads.extract_fields"
        ]),
        deps
      )
    ).resolves.toEqual([]);
  });

  it("closes what is not exposed, what a source fills and every other operation", async () => {
    const blockers = await workflowOutsideBlockers(
      manifest([
        "connection.crm.write",
        "connection.gone.read",
        "knowledge.box.extract_fields",
        "knowledge.filled.list_documents",
        "knowledge.missing.search",
        "workflows.list_step_runs",
        "app.report.refresh",
        "custom.tool",
        "workflow.unpublished.start"
      ]),
      deps
    );
    expect(blockers).toEqual(
      expect.arrayContaining([
        { kind: "connection", name: "crm" },
        { kind: "connection", name: "gone" },
        { kind: "connection", name: "box" },
        { kind: "knowledge_base", name: "filled" },
        { kind: "knowledge_base", name: "missing" },
        { kind: "operation", name: "workflows.list_step_runs" },
        { kind: "operation", name: "app.report.refresh" },
        { kind: "operation", name: "custom.tool" },
        { kind: "workflow", name: "unpublished" }
      ])
    );
    expect(blockers).toHaveLength(9);
  });
});
