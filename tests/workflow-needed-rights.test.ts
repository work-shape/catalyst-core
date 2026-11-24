import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflowAssetKind } from "@work-shape/catalyst-client-assembly";
import {
  INSTANCE_ASSET_SCOPE,
  workflowRightsLacking,
  workflowNeededRightResource,
  asCollaborationWorkspaceId,
  asClientInstanceId,
  asUserId,
  createActorAccess,
  type ConfigAssetRecord,
  type LocaleCode,
  type OperationDefinition,
  type PermissionGrant,
  type OperationResource,
  type WorkflowInputMapping,
  type WorkflowManifest,
  type WorkflowNeededRight,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_UNBOUNDED_CEILINGS,
  parseWorkflowManifest,
  resolveWorkflowNeededRights,
  workflowKindIssues,
  workflowNeededRights,
  workflowOperationNames,
  type NeededRightOperation,
  type WorkflowLimitContext
} from "@work-shape/catalyst-workflows";
import { dataFlowManifest } from "./support/workflow-data-flows";

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

  it("names a right once that a trigger names by its asset's name and a step by its id", async () => {
    const base = manifest([
      step("pending", "knowledge.handbook.pending", { limit: { value: 10 } })
    ]);
    const start: WorkflowStep = {
      id: "start",
      name: "Start",
      type: "trigger",
      triggers: [
        { kind: "manual" },
        {
          kind: "platform_event",
          event: "knowledge_base.sync_finished",
          filter: { knowledgeBase: "handbook" }
        }
      ]
    };
    const definition: WorkflowManifest = { ...base, steps: [start, ...base.steps.slice(1)] };
    const pending: OperationDefinition = {
      name: "knowledge.handbook.pending",
      effect: "reading",
      auth: "principal",
      scope: null,
      action: "knowledge_base.read",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      timeoutMs: 1000,
      resource: () => resource("knowledge_base", "handbook"),
      execute: () => Promise.reject(new Error("not called"))
    };
    const handbook: ConfigAssetRecord = {
      id: "knowledge_base-handbook",
      clientInstanceId: asClientInstanceId("instance"),
      kind: "knowledge_base",
      name: "handbook",
      scope: { kind: "instance" },
      status: "active",
      activeRevisionId: "rev-1",
      revision: 1,
      config: {},
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z"
    };
    const rights = await resolveWorkflowNeededRights(
      {
        clientInstanceId: asClientInstanceId("instance"),
        configAssets: {
          getConfigAsset: ({ kind, name }) =>
            Promise.resolve(kind === handbook.kind && name === handbook.name ? handbook : undefined)
        },
        registry: () => ({
          resolveMany: (names) =>
            Promise.resolve(new Map(names.includes(pending.name) ? [[pending.name, pending]] : []))
        })
      },
      definition
    );
    expect(
      rights.map(({ action, asset, steps, neededFor }) => [action, asset.assetId, steps, neededFor])
    ).toEqual([
      ["knowledge_base.read", "knowledge_base-handbook", ["start", "pending"], "publish"]
    ]);
  });
});

// What publish refuses by a Workflow's kind, and the question it asks.

function kindDefinition(operation: string, kind?: "process" | "data"): WorkflowManifest {
  return {
    id: "flow",
    name: "Flow",
    runAs: "flow-runner",
    ...(kind ? { kind } : {}),
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "write", name: "Write", type: "operation", operation, input: {} },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
}

describe("Workflow kind at publish", () => {
  it.each(["knowledge.docs.ingest", "data_store.rows.records.propose"])(
    "refuses %s in an implicit or explicit process",
    (operation) => {
      for (const kind of [undefined, "process"] as const) {
        const manifest = kindDefinition(operation, kind);
        const parsed = parseWorkflowManifest(manifest);
        expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
        expect(workflowKindIssues(manifest)).toMatchObject([
          {
            code: "process_workflow_write_operation",
            message: expect.stringContaining("kind: data")
          }
        ]);
      }
      expect(workflowKindIssues(kindDefinition(operation, "data"))).toEqual([]);
    }
  );

  it("walks nested blocks and declared agent tools", () => {
    const parsed = parseWorkflowManifest(
      dataFlowManifest("nested-flow", ["knowledge.docs.ingest"], { kind: "process", nested: true })
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(workflowKindIssues(parsed.manifest)).toHaveLength(1);
    expect(
      workflowKindIssues({
        ...kindDefinition("connection.crm.read"),
        steps: [
          {
            id: "agent",
            name: "Agent",
            type: "agent",
            instructions: "steps/agent.md",
            input: {},
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ],
        tools: ["data_store.rows.records.propose"]
      })
    ).toHaveLength(1);
  });

  it.each(["knowledge.docs.ingest_more", "data_store.rows.insert"])(
    "keeps %s callable by process Workflows",
    (operation) => {
      expect(workflowKindIssues(kindDefinition(operation))).toEqual([]);
    }
  );

  it("refuses malformed definitions through the existing parser", () => {
    expect(
      parseWorkflowManifest({ ...kindDefinition("knowledge.docs.ingest"), kind: "unknown" }).ok
    ).toBe(false);
    expect(parseWorkflowManifest({ kind: "data", steps: "not steps" }).ok).toBe(false);
  });
});

// REH-900: the publish question named notify recipients by raw user id, in English, to German
// staff. It is now written in the reader's language and names people and workspaces by name.

const untouched = () => Promise.reject(new Error("The publish question reads no asset or grant"));
const kindOptions = {
  clientInstanceId: asClientInstanceId("ci_test"),
  limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
  runnerPackages: [],
  configAssets: { getConfigAsset: untouched, listPublishedConfigAssets: untouched },
  apiAccess: { findServicePrincipalByName: untouched, findServicePrincipalByOwner: untouched },
  access: { loadPersistedAccess: untouched, listGrantScopeAssets: untouched }
};
const kind = createWorkflowAssetKind(kindOptions);

const PEOPLE = new Map([
  ["usr_mara", "Mara Lindqvist"],
  ["usr_jonas", "Jonas\nWeber"]
]);
const WORKSPACES = new Map([["cw_kanzlei", "Kanzlei"]]);
const names = {
  user: (id: string) => Promise.resolve(PEOPLE.get(id)),
  workspace: (id: string) => Promise.resolve(WORKSPACES.get(id))
};

function notifyManifest(to: { users?: string[]; workspaces?: string[] }): WorkflowManifest {
  return {
    id: "monthly-check",
    name: "Monthly check",
    runAs: "check-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    limits: { duration: "24h" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "tell",
        name: "Tell the team",
        type: "notify",
        to,
        channels: ["inbox", "mail"],
        title: { value: "Findings" },
        text: { value: "Counts" }
      },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
}

async function question(
  locale: LocaleCode,
  to: { users?: string[]; workspaces?: string[] } = {
    users: ["usr_mara", "usr_jonas"],
    workspaces: ["cw_kanzlei"]
  }
): Promise<string[]> {
  const ask = kind.publishQuestion;
  if (ask === undefined) throw new Error("The Workflow kind asks no publish question");
  return ask({
    assetId: "asset_1",
    scope: INSTANCE_ASSET_SCOPE,
    config: { name: "monthly-check", manifest: notifyManifest(to) },
    locale,
    names
  });
}

describe("the publish question of a Workflow", () => {
  it("names whom a notify step reaches by name, never by id, in English", async () => {
    expect(await question("en")).toEqual([
      "Raises the run time of each run from 12h to 24h.",
      "“Tell the team” notifies Mara Lindqvist, Jonas Weber, and the workspace “Kanzlei”, in the Inbox and by mail. A mail carries counts and a link only."
    ]);
  });

  it("says that an id names nobody any more, and still shows no id", async () => {
    const lines = (await question("en", { users: ["usr_gone"], workspaces: ["cw_gone"] })).join(
      "\n"
    );
    expect(lines).toContain("a person who no longer exists");
    expect(lines).toContain("a workspace that no longer exists");
    expect(lines).not.toMatch(/usr_|cw_/u);
  });

  it("keeps each line one line when a name holds a line break", async () => {
    for (const line of await question("de")) expect(line).not.toContain("\n");
  });
});

/** Exercise the kind's public question with operations exposing the rights of these steps. */
async function workflowPublishQuestion(input: {
  manifest: WorkflowManifest;
  limits: WorkflowLimitContext;
  locale: LocaleCode;
  names: Parameters<NonNullable<typeof kind.publishQuestion>>[0]["names"];
  rights?: readonly WorkflowNeededRight[];
}): Promise<string[]> {
  const rightOperations: OperationDefinition[] = (input.rights ?? []).map((right, index) => ({
    name: `test.right_${index}`,
    effect: "reading",
    auth: "principal",
    scope: null,
    action: right.action,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    timeoutMs: 1000,
    resource: () => ({
      kind: right.asset.kind,
      id: right.asset.assetId ?? right.asset.name,
      name: right.asset.name,
      assetId: right.asset.assetId
    }),
    execute: untouched
  }));
  const definition: WorkflowManifest = {
    ...input.manifest,
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...rightOperations.map((operation, index) => ({
        id: `right_${index}`,
        name: "Step",
        type: "operation" as const,
        input: {},
        operation: operation.name
      })),
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
  const testKind = createWorkflowAssetKind({
    ...kindOptions,
    limits: input.limits,
    registry: () => ({
      resolve: (name) =>
        Promise.resolve(rightOperations.find((operation) => operation.name === name)),
      resolveMany: (names) =>
        Promise.resolve(
          new Map(
            rightOperations
              .filter((operation) => names.includes(operation.name))
              .map((operation) => [operation.name, operation])
          )
        )
    })
  });
  const ask = testKind.publishQuestion;
  if (!ask) throw new Error("missing publish question");
  return ask({
    assetId: "asset_1",
    scope: INSTANCE_ASSET_SCOPE,
    config: { name: definition.id, manifest: definition },
    locale: input.locale,
    names: input.names
  });
}

// LIVE-1: a definition without `runAs` runs as its own account, which gets the rights its steps
// need. The question names that account once, with what it may do, by asset names only.
describe("the publish question of a Workflow that runs as its own account", () => {
  const right = (action: string, kind: string, name: string): WorkflowNeededRight => ({
    action,
    asset: { kind, name, assetId: `asset_${name}`, workspaceId: "cw_secret" },
    steps: ["read"],
    neededFor: "run"
  });
  const RIGHTS = [
    right("connection.use", "connection", "Exampledata"),
    right("data_store.insert", "data_store", "Findings"),
    right("knowledge_base.use", "knowledge_base", "Handbook"),
    right("data_store.execute", "data_store", "Open items"),
    right("workflow.use", "workflow", "Check\nmonth")
  ];
  const ownManifest = (runAs?: string): WorkflowManifest => ({
    id: "monthly-check",
    name: "Monthly\ncheck",
    ...(runAs === undefined ? {} : { runAs }),
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  });
  const ask = (
    locale: LocaleCode,
    rights: readonly WorkflowNeededRight[] | undefined,
    runAs?: string
  ) =>
    workflowPublishQuestion({
      manifest: ownManifest(runAs),
      limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
      locale,
      names,
      ...(rights === undefined ? {} : { rights })
    });

  it("names each asset by the title the reader may be told, never by its machine name", async () => {
    const titled = {
      ...names,
      asset: (kind: string, name: string) =>
        Promise.resolve(
          kind === "connection" && name === "exampledata-machine"
            ? "Exampledata"
            : kind === "data_store" && name === "findings-machine"
              ? "Findings\nof the month"
              : undefined
        )
    };
    const lines = await workflowPublishQuestion({
      manifest: ownManifest(),
      limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
      locale: "en",
      names: titled,
      rights: [
        right("connection.use", "connection", "exampledata-machine"),
        right("data_store.insert", "data_store", "findings-machine"),
        // A title the reader may not be told: the definition's name stands.
        right("knowledge_base.use", "knowledge_base", "handbook")
      ]
    });
    expect(lines).toEqual([
      "Runs as its own account “Monthly check” and may use Exampledata and handbook and add rows to Findings of the month."
    ]);
    expect(lines.join("\n")).not.toMatch(/-machine|asset_|cw_/u);
  });

  it("groups the assets one kind of right reaches and words each right", async () => {
    expect(await ask("en", RIGHTS)).toEqual([
      "Runs as its own account “Monthly check” and may use Exampledata and Handbook, add rows to Findings, change and delete rows in Open items, and start the workflow “Check month”."
    ]);
  });

  it("words an action named like an Object property as using, and shows no code", async () => {
    for (const action of ["constructor", "__proto__"]) {
      const lines = await ask("en", [right(action, "connection", "Exampledata")]);
      expect(lines, action).toEqual([
        "Runs as its own account “Monthly check” and may use Exampledata."
      ]);
    }
  });

  it("shows no id, workspace or step of a right", async () => {
    const lines = (await ask("en", RIGHTS)).join("\n");
    expect(lines).not.toMatch(/asset_|cw_|connection\.use|read/u);
  });

  it("says nothing of an account a definition names under runAs", async () => {
    expect(await ask("en", RIGHTS, "shared-runner")).toEqual([]);
  });
});
