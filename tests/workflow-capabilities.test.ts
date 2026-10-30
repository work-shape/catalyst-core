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
  platformDocsSkill,
  type InstanceWorkflowCapabilities
} from "@work-shape/catalyst-client-assembly";
import { registerModuleOperations } from "@work-shape/catalyst-server";
import { WORKFLOW_TEST_TOOL_NAMES } from "@work-shape/catalyst-tool-execution";
import {
  createWorkflowAuthoringSkill,
  workflowCapabilityValueText,
  type WorkflowCapabilities
} from "@work-shape/catalyst-workflows";
import { connection, fixtureConnectorType } from "./support/connections";

// Events, Workflows And Guardrails acceptance check 150 (WF-FIT): `workflows.capabilities`
// lists the image's packages, every ceiling with its key, per Connection the operations a
// Workflow reaches, and what is not offered, Postgres reach from a code step among it; the
// page "What a Workflow can do" shows the same values; the Build Agent answers one of four
// before its first write. Fails without the change: no such operation, page or answer.

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
  it("shows the instance's own values in the docs the instance ships", () => {
    const page = instanceWorkflowCapabilitiesPage(instance);
    const docs = instancePlatformDocsSkill(page).resources?.find(
      (resource) => resource.path === "references/automate/workflow-capabilities.md"
    )?.content;
    expect(docs).toContain("# What a Workflow can do");
    expect(docs).toContain(
      "| Memory of one code step | 2 GiB | `workflows.codeSteps.memoryBytes` |"
    );
    expect(docs).toContain(
      "| Run time of one code step | 300 s | `workflows.codeSteps.timeoutSeconds` |"
    );
    expect(docs).toContain("- `pandas` 2.2.3");
    expect(docs).toContain("A code step does not reach a postgres Connection's database.");
    expect(docs).toContain("Connections of type warehouse only read");
    // The release's defaults are gone from the instance's page.
    expect(docs).not.toContain("| Memory of one code step | 512 MiB |");
  });

  it("is the release's defaults in the product docs, every ceiling and its key with them", () => {
    const docs = platformDocsSkill.resources?.find(
      (resource) => resource.path === "references/automate/workflow-capabilities.md"
    )?.content;
    const defaults = workflowsConfigSchema.parse({});
    expect(docs).toContain(
      `| Memory of one code step | ${workflowCapabilityValueText({ value: defaults.codeSteps.memoryBytes, unit: "bytes", about: "" })} | \`workflows.codeSteps.memoryBytes\` |`
    );
    expect(docs).toContain("`workflows.source.treeBytes`");
    expect(docs).toContain("A code step does not reach a postgres Connection's database.");
  });
});

describe("the fit check of the Build Agent", () => {
  const skill = createWorkflowAuthoringSkill([]).content;

  it("is read with workflows.capabilities, a tool offered beside the Workflow test tools", () => {
    expect(WORKFLOW_TEST_TOOL_NAMES).toContain("workflows.capabilities");
    expect(skill).toContain("call `workflows.capabilities`");
  });

  it("gives one of four answers before the first write, naming the switch or the reason", () => {
    const fit = skill.indexOf("## Before the first write: does it fit?");
    expect(fit).toBeGreaterThan(-1);
    expect(fit).toBeLessThan(skill.indexOf("## How you work on a definition"));
    const section = skill.slice(fit, skill.indexOf("## How you work on a definition"));
    for (const answer of [
      "**It fits.**",
      "**It fits once someone switches something on.**",
      "**It belongs in another kind.**",
      "**It is not a fit yet.**"
    ]) {
      expect(section).toContain(answer);
    }
    expect(section).toContain(
      "a changing\n   operation of a Connection that an administrator switches on"
    );
    expect(section).toContain("a\n   database only the customer's network reaches");
    expect(section).toContain("never promise what it does not list");
  });
});
