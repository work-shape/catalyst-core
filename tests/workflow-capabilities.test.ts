import { describe, expect, it, vi } from "vitest";
import { workflowCapabilitiesSchema } from "@work-shape/catalyst-api-contract";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  asAgentRunId,
  asClientInstanceId,
  asToolCallId,
  createOperationRegistry,
  createPlatformId,
  NoopAuditRecorder,
  type ActorAccess,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type ConnectorTypeDefinition,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import {
  createWorkflowCapabilitiesRoute,
  instancePlatformDocsSkill,
  instanceWorkflowCapabilitiesPage,
  type InstanceWorkflowCapabilities
} from "@work-shape/catalyst-client-assembly";
import { registerModuleOperations } from "@work-shape/catalyst-server";
import { WORKFLOW_TEST_TOOL_NAMES } from "@work-shape/catalyst-tool-execution";
import type { WorkflowCapabilities } from "@work-shape/catalyst-workflows";
import { connection, fixtureConnectorType } from "./support/connections";

// Acceptance check 150 (WF-FIT): `workflows.capabilities` lists the image's packages, every
// ceiling with its key, per Connection the operations a Workflow reaches, and what is not
// offered; the page "What a Workflow can do" shows the instance's values.

const clientInstanceId = asClientInstanceId("workflow-capabilities");

/** A catalog type whose operations only read, as a database type is before it may write. */
const readingType: ConnectorTypeDefinition = { ...fixtureConnectorType, type: "warehouse" };
/** A catalog type with an operation that changes data. */
const changingType: ConnectorTypeDefinition = {
  type: "ledger",
  description: "Books entries. For tests.",
  settingsSchema: fixtureConnectorType.settingsSchema,
  authSchemes: fixtureConnectorType.authSchemes,
  secretFields: fixtureConnectorType.secretFields,
  target: fixtureConnectorType.target,
  test: fixtureConnectorType.test,
  execute: fixtureConnectorType.execute,
  limits: fixtureConnectorType.limits,
  catalog: [
    {
      name: "book",
      description: "Books an entry.",
      inputSchema: { type: "object" },
      proposedEffect: "changing"
    }
  ]
};

const instance: InstanceWorkflowCapabilities = {
  config: workflowsConfigSchema.parse({
    stepSlots: 6,
    codeSteps: { memoryBytes: 2 * 1024 ** 3, timeoutSeconds: 300 },
    source: { files: 500 }
  }),
  codeSteps: "available",
  packages: {
    packages: [
      { name: "pandas", version: "2.2.3" },
      { name: "openpyxl", version: "3.1.5" }
    ]
  },
  connectorTypes: [readingType, changingType]
};

function record(name: string, config: ReturnType<typeof connection>): ConfigAssetRecord {
  return {
    id: `asset_${name}`,
    clientInstanceId,
    kind: "connection",
    name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: `revision_${name}`,
    revision: 1,
    config,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z"
  };
}

const connections = [
  record(
    "erp",
    connection("erp", {
      displayName: "ERP",
      connectorType: "ledger",
      operations: [
        { name: "orders_list", effect: "reading", exposure: ["workflow"], enabled: true },
        { name: "orders_create", effect: "changing", exposure: ["workflow"], enabled: false },
        { name: "orders_delete", effect: "changing", exposure: ["agent"], enabled: true }
      ]
    })
  ),
  record("hr", connection("hr", { displayName: "HR" }))
];

const user: AuthenticatedUser = {
  id: "builder",
  externalUserId: "builder",
  displayLabel: "Builder",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};

/** Access that holds `workflow.write` where `writes` says and `connection.use` on `uses`. */
function accessOf(options: {
  writesInstance?: boolean;
  writesSomewhere?: boolean;
  uses: readonly string[];
}): ActorAccess {
  return {
    scopeOf: () => "all",
    authorize: (action, resource) =>
      action === "workflow.write"
        ? options.writesInstance === true
          ? { allowed: true, source: "grant" }
          : { allowed: false, reason: "no_grant" }
        : action === "connection.use" && options.uses.includes(resource?.name ?? "")
          ? { allowed: true, source: "grant" }
          : { allowed: false, reason: "no_grant" },
    authorizeTransfer: () => ({ allowed: false, reason: "no_grant" }),
    require: () => undefined,
    holdsGrantAt: (action) => action === "workflow.write" && options.writesSomewhere === true,
    denials: () => []
  };
}

async function capabilitiesOperation() {
  const listActiveConfigAssets = vi.fn().mockResolvedValue(connections);
  const registry = createOperationRegistry();
  registerModuleOperations(registry, [
    createWorkflowCapabilitiesRoute(
      {
        clientInstanceId,
        stores: {
          configAssets: { listActiveConfigAssets }
        }
      },
      instance
    )
  ]);
  const binding = await registry.resolve("workflows.capabilities");
  if (!binding) throw new Error("workflows.capabilities is not registered");
  const contextOf = (access: ActorAccess): OperationExecutionContext => ({
    actor: user,
    origin: {
      kind: "agent",
      agentName: "builder",
      agentRunId: asAgentRunId("agent-run"),
      conversationId: createPlatformId<"ConversationId">("conversation"),
      toolCallId: asToolCallId("tool-call"),
      toolName: "workflows.capabilities"
    },
    runId: createPlatformId<"OperationRunId">("oprun"),
    correlationId: "correlation",
    runtime: {},
    access,
    audit: new NoopAuditRecorder()
  });
  return {
    authorize: (access: ActorAccess) =>
      binding.authorize?.({}, { ...contextOf(access), resource: undefined }),
    read: async (access: ActorAccess) =>
      workflowCapabilitiesSchema.parse(await binding.execute({}, contextOf(access)))
  };
}

const keyed = (capabilities: Pick<WorkflowCapabilities, "ceilings" | "source">) =>
  Object.fromEntries(
    [...capabilities.ceilings, ...capabilities.source].flatMap((entry) =>
      entry.key === undefined ? [] : [[entry.key, entry.value]]
    )
  );

describe("workflows.capabilities", () => {
  it("is open to whoever writes a Workflow somewhere, and to no one else", async () => {
    const operation = await capabilitiesOperation();
    expect(await operation.authorize(accessOf({ writesInstance: true, uses: [] }))).toEqual({
      allowed: true
    });
    expect(await operation.authorize(accessOf({ writesSomewhere: true, uses: [] }))).toEqual({
      allowed: true
    });
    expect(await operation.authorize(accessOf({ uses: ["erp"] }))).toMatchObject({
      allowed: false,
      action: "workflow.write"
    });
  });

  it("lists the packages, every ceiling with its key and the instance's values, and the source bounds", async () => {
    const operation = await capabilitiesOperation();
    const capabilities = await operation.read(accessOf({ writesSomewhere: true, uses: [] }));
    expect(capabilities.runtime).toMatchObject({
      codeSteps: "available",
      packageManifest: "available",
      packages: [
        { name: "pandas", version: "2.2.3" },
        { name: "openpyxl", version: "3.1.5" }
      ]
    });
    expect(capabilities.runtime.languages.map(({ language }) => language)).toEqual([
      "python",
      "javascript"
    ]);
    const values = keyed(capabilities);
    expect(values).toMatchObject({
      "workflows.codeSteps.memoryBytes": 2 * 1024 ** 3,
      "workflows.codeSteps.timeoutSeconds": 300,
      "workflows.codeSteps.cpuCount": 0.5,
      "workflows.codeSteps.diskBytes": 2 * 1024 ** 3,
      "workflows.codeSteps.slots": 6,
      "workflows.stepSlots": 6,
      "workflows.limits.duration": "7d",
      "workflows.source.files": 500,
      "workflows.source.fileBytes": 2 * 1024 ** 2
    });
    // Every number of release config `workflows` that bounds a step, a run or a dataset.
    for (const key of Object.keys(instance.config.codeSteps)) {
      expect(values).toHaveProperty([`workflows.codeSteps.${key}`]);
    }
    for (const key of Object.keys(instance.config.limits)) {
      expect(values).toHaveProperty([`workflows.limits.${key}`]);
    }
    for (const key of ["fileBytes", "files", "treeBytes", "historyBytes"]) {
      expect(values).toHaveProperty([`workflows.source.${key}`]);
    }
  });

  it("names per Connection the asker may use the operations a Workflow reaches, and no other Connection", async () => {
    const operation = await capabilitiesOperation();
    const capabilities = await operation.read(accessOf({ writesSomewhere: true, uses: ["erp"] }));
    expect(capabilities.reach).toEqual({
      codeSteps: "none",
      connections: [
        {
          name: "erp",
          title: "ERP",
          connectorType: "ledger",
          enabled: true,
          operations: [
            { name: "orders_list", effect: "reading", enabled: true },
            { name: "orders_create", effect: "changing", enabled: false }
          ],
          otherOperations: 1
        }
      ],
      changingConnectorTypes: ["ledger"]
    });
    const none = await operation.read(accessOf({ writesSomewhere: true, uses: [] }));
    expect(none.reach.connections).toEqual([]);
  });

  it("lists Postgres reach from a code step, no network and a reading-only type under not offered", async () => {
    const operation = await capabilitiesOperation();
    const { notOffered } = await operation.read(accessOf({ writesSomewhere: true, uses: [] }));
    const ids = notOffered.map(({ id }) => id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "code_step_http",
        "code_step_postgres",
        "inbound_network",
        "gpu",
        "customer_network",
        "changing_warehouse"
      ])
    );
    expect(ids).not.toContain("changing_ledger");
    expect(ids).not.toContain("code_steps");
  });
});

describe("the page What a Workflow can do", () => {
  it("shows the instance's own values in the docs the instance ships, not the release's defaults", () => {
    const page = instanceWorkflowCapabilitiesPage(instance);
    const docs = instancePlatformDocsSkill(page).resources?.find(
      (resource) => resource.path === "references/automate/workflow-capabilities.md"
    )?.content;
    expect(docs).toContain("| 2 GiB | `workflows.codeSteps.memoryBytes` |");
    expect(docs).toContain("| 300 s | `workflows.codeSteps.timeoutSeconds` |");
    expect(docs).not.toContain("| 512 MiB | `workflows.codeSteps.memoryBytes` |");
  });
});

it("offers workflows.capabilities to the Build Agent beside the Workflow test tools", () => {
  expect(WORKFLOW_TEST_TOOL_NAMES).toContain("workflows.capabilities");
});
