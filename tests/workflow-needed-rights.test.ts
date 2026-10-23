import { describe, expect, it } from "vitest";
import {
  workflowRightsLacking,
  workflowNeededRightResource,
  asCollaborationWorkspaceId,
  asClientInstanceId,
  asUserId,
  createActorAccess,
  type PermissionGrant,
  type OperationResource,
  type WorkflowInputMapping,
  type WorkflowManifest,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import {
  workflowNeededRights,
  workflowOperationNames,
  type NeededRightOperation
} from "@work-shape/catalyst-workflows";

// The one derivation the publish check and the publish screen share: what the account of a
// Workflow needs, read from its definition and the operations it names.

const resource = (kind: string, name: string): OperationResource => ({
  kind,
  id: `${kind}-${name}`,
  assetId: `${kind}-${name}`,
  name
});
const own = (kind: string, name: string): NeededRightOperation => ({
  action: null,
  resource: () => resource(kind, name)
});
const named = (action: string, kind: string, name: string): NeededRightOperation => ({
  action,
  resource: () => resource(kind, name)
});
const operations = new Map<string, NeededRightOperation>([
  ["connection.exampledata.list_clients", own("connection", "exampledata")],
  ["connection.exampledata.read_client", own("connection", "exampledata")],
  ["data_store.mandanten.query", named("data_store.read", "data_store", "mandanten")],
  ["data_store.mandanten.load", own("data_store", "mandanten")],
  ["knowledge_bases.handbook.search", named("knowledge_base.use", "knowledge_base", "handbook")],
  ["workflow.notify.start", own("workflow", "notify")],
  ["subagent.ask", own("subagent", "ask")]
]);
const step = (id: string, operation: string, input: WorkflowInputMapping = {}): WorkflowStep => ({
  id,
  name: id,
  type: "operation",
  operation,
  input
});

function manifest(steps: WorkflowStep[], tools?: string[]): WorkflowManifest {
  return {
    id: "sync",
    name: "Sync",
    runAs: "runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...steps
    ],
    ...(tools ? { tools } : {})
  };
}

const rightsOf = (definition: WorkflowManifest) =>
  workflowNeededRights(definition, {
    operations,
    workflowAssets: new Map([["export", { id: "workflow-export", scope: { kind: "instance" } }]])
  }).map(({ action, asset, steps, neededFor }) => [action, asset.name, steps, neededFor]);

describe("the rights a Workflow's account needs", () => {
  it("names each right once with the steps that need it, inside loops and for a child", () => {
    const definition = manifest([
      step("clients", "connection.exampledata.list_clients"),
      {
        id: "each",
        name: "Each",
        type: "loop",
        items: { step: "clients", path: "items" },
        steps: [
          step("read", "connection.exampledata.read_client"),
          step("store", "data_store.mandanten.load", { rows: { ref: { step: "read", path: "" } } }),
          { id: "export", name: "Export", type: "workflow", workflow: "export", input: {} }
        ]
      },
      step("check", "data_store.mandanten.query", { sql: { value: "select 1" } }),
      step("notify", "workflow.notify.start"),
      step("missing", "connection.gone.read")
    ]);
    expect(rightsOf(definition)).toEqual([
      ["connection.use", "exampledata", ["clients", "read"], "run"],
      ["data_store.insert", "mandanten", ["store"], "run"],
      ["workflow.use", "export", ["export"], "publish"],
      ["data_store.read", "mandanten", ["check"], "run"],
      ["workflow.use", "notify", ["notify"], "run"]
    ]);
    const [, , child] = workflowNeededRights(definition, {
      operations,
      workflowAssets: new Map([["export", { id: "workflow-export", scope: { kind: "instance" } }]])
    });
    expect(child?.asset).toEqual({ kind: "workflow", name: "export", assetId: "workflow-export" });
  });

  it("asks data_store.execute of a load that replaces or updates rows, or leaves that to a reference", () => {
    const load = (input: WorkflowInputMapping) =>
      rightsOf(manifest([step("store", "data_store.mandanten.load", input)])).map(([a]) => a);
    expect(load({ onConflict: { value: "skip" } })).toEqual(["data_store.insert"]);
    expect(load({ onConflict: { value: "update" } })).toEqual([
      "data_store.insert",
      "data_store.execute"
    ]);
    expect(load({ onConflict: { ref: { step: "start", path: "input.mode" } } })).toEqual([
      "data_store.insert",
      "data_store.execute"
    ]);
    // A text joined from parts is decided by the run, as a reference is (EW-TEXT).
    expect(load({ onConflict: { text: ["upd", "ate"] } })).toEqual([
      "data_store.insert",
      "data_store.execute"
    ]);
    expect(load({ replace: { value: { by: ["year"] } } })).toEqual([
      "data_store.insert",
      "data_store.execute"
    ]);
  });

  it("reads the tools of an agent step, and none without one", () => {
    const tools = ["knowledge_bases.handbook.search", "subagent.ask"];
    const agent: WorkflowStep = {
      id: "answer",
      name: "Answer",
      type: "agent",
      instructions: "answer.md",
      input: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    };
    expect(workflowOperationNames(manifest([agent], tools))).toEqual(tools);
    expect(workflowOperationNames(manifest([], tools))).toEqual([]);
    expect(rightsOf(manifest([agent], tools))).toEqual([
      ["knowledge_base.use", "handbook", ["answer"], "run"]
    ]);
  });

  it("carries operation and child owners through the derivation and the needed-right evaluator", () => {
    const workspaceId = asCollaborationWorkspaceId("workspace-owner");
    const rights = workflowNeededRights(
      manifest([
        step("read", "data_store.owned.query"),
        { id: "child", name: "Child", type: "workflow", workflow: "owned-child", input: {} }
      ]),
      {
        operations: new Map([
          [
            "data_store.owned.query",
            {
              action: "data_store.read",
              resource: () => ({ ...resource("data_store", "owned"), workspaceId })
            }
          ]
        ]),
        workflowAssets: new Map([
          ["owned-child", { id: "workflow-child", scope: { kind: "workspace", workspaceId } }]
        ])
      }
    );
    expect(rights.map(workflowNeededRightResource)).toEqual([
      { kind: "data_store", name: "owned", assetId: "data_store-owned", workspaceId },
      { kind: "workflow", name: "owned-child", assetId: "workflow-child", workspaceId }
    ]);
    const clientInstanceId = asClientInstanceId("instance");
    const holder = {
      kind: "user",
      id: "reader",
      clientInstanceId,
      roles: [],
      permissionRefs: []
    } as const;
    const grant = (
      action: string,
      scopeKind: "workspace" | "instance",
      effect: "allow" | "deny"
    ): PermissionGrant => ({
      id: `${action}-${scopeKind}-${effect}`,
      clientInstanceId,
      holderKind: "user",
      holderId: holder.id,
      action,
      scopeKind,
      effect,
      ...(scopeKind === "workspace" ? { scopeId: workspaceId } : {}),
      grantedBy: asUserId("admin"),
      createdAt: "2026-10-18T00:00:00.000Z"
    });
    const access = (grants: PermissionGrant[]) =>
      createActorAccess(holder, { holderActive: true, grants });
    expect(
      workflowRightsLacking(
        rights,
        access(rights.map(({ action }) => grant(action, "workspace", "allow")))
      )
    ).toEqual([]);
    expect(
      workflowRightsLacking(
        rights,
        access(
          rights.flatMap(({ action }) => [
            grant(action, "instance", "allow"),
            grant(action, "workspace", "deny")
          ])
        )
      )
    ).toEqual(rights);
  });

  it("answers the rights the account's access does not allow", () => {
    const rights = workflowNeededRights(
      manifest([
        step("clients", "connection.exampledata.list_clients"),
        step("q", "data_store.mandanten.query")
      ]),
      { operations, workflowAssets: new Map() }
    );
    const lacking = workflowRightsLacking(rights, {
      authorize: (action, target) =>
        action === "connection.use" && target?.assetId === "connection-exampledata"
          ? { allowed: true, source: "grant" }
          : { allowed: false, reason: "no_grant" }
    });
    expect(lacking.map((right) => right.action)).toEqual(["data_store.read"]);
  });
});
