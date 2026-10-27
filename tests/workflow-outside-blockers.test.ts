import { describe, expect, it } from "vitest";
import type {
  ConfigAssetKind,
  ConfigAssetRecord,
  JsonObject,
  WorkflowManifest
} from "@work-shape/catalyst-core";
import { workflowOutsideBlockers, workflowOutsideIssues } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";

// What keeps a Workflow from being started from outside, read from its definition: the scan
// is closed by default. A Connection operation is open where it is exposed to `outside`, a
// Data Store's operations and mail where they are named; a Knowledge Base (its documents may
// come from a Connection, directly or through a Workflow), an App's action or an API operation
// that reads runs as the Workflow's account is closed (connections-and-secrets.md, Workflows
// started from outside). Fails without the allowlist: `workflows.list_step_runs` and a
// Knowledge Base's `extract_fields` passed.

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
  "knowledge_base/uploads": { sources: [] }
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
  it("opens a Connection operation exposed to outside, a Data Store and mail", async () => {
    await expect(
      workflowOutsideBlockers(
        manifest(["connection.crm.echo", "data_store.leads.query", "mail.send"]),
        deps
      )
    ).resolves.toEqual([]);
  });

  it("closes what is not exposed, every Knowledge Base and every other operation", async () => {
    const blockers = await workflowOutsideBlockers(
      manifest([
        "connection.crm.write",
        "connection.gone.read",
        "knowledge.uploads.search",
        "knowledge.uploads.extract_fields",
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
        { kind: "knowledge_base", name: "uploads" },
        { kind: "operation", name: "workflows.list_step_runs" },
        { kind: "operation", name: "app.report.refresh" },
        { kind: "operation", name: "custom.tool" },
        { kind: "workflow", name: "unpublished" }
      ])
    );
    expect(blockers).toHaveLength(7);
  });

  // A child Workflow's account may use Connections its parent's publisher may not see: the
  // refusal names only those the publisher may read and counts the rest. Fails without the
  // check: it named 'payroll' to a publisher who may not read it.
  it("names to a publisher only the Connections they may read", async () => {
    const child: WorkflowManifest = {
      ...manifest(["connection.payroll.read", "connection.hr.read"]),
      id: "payroll-sync",
      name: "Payroll sync",
      inputs: { type: "object" },
      outputs: { type: "object" }
    };
    const [issue] = await workflowOutsideIssues(
      manifest(["connection.crm.write", "workflow.payroll-sync.start"]),
      {
        ...deps,
        definitions: {
          read: (id) =>
            Promise.resolve(
              id === child.id ? { revisionId: "rev-child", manifest: child } : undefined
            )
        },
        readable: (kind, name) => Promise.resolve(kind === "connection" && name === "crm")
      }
    );
    expect(issue?.code).toBe("outside_not_exposed");
    expect(issue?.message).toContain("the Connection 'crm'; 2 Connections you may not read");
    expect(issue?.message).not.toContain("payroll");
    expect(issue?.message).not.toContain("hr'");
  });

  it("counts hidden Knowledge Bases, unpublished children and operations of unreadable children", async () => {
    const child: WorkflowManifest = {
      ...manifest([
        "knowledge.private-documents.search",
        "workflow.private-child.start",
        "app.private-report.refresh",
        "private.tool"
      ]),
      id: "private-definition",
      name: "Private definition",
      inputs: { type: "object" },
      outputs: { type: "object" }
    };
    const root = manifest([
      "knowledge.uploads.search",
      "workflow.public-child.start",
      "workflow.private-definition.start",
      "public.tool"
    ]);
    const dependencies = {
      ...deps,
      definitions: {
        read: (id: string) =>
          Promise.resolve(id === child.id ? { revisionId: "child", manifest: child } : undefined)
      },
      readable: (kind: string, name: string) =>
        Promise.resolve(
          (kind === "knowledge_base" && name === "uploads") ||
            (kind === "workflow" && name === "public-child")
        )
    };
    const [issue] = await workflowOutsideIssues(root, dependencies);
    expect(issue?.message).toContain(
      "the Knowledge Base 'uploads'; a Knowledge Base you may not read"
    );
    expect(issue?.message).toContain(
      "the unpublished child Workflow 'public-child'; an unpublished child Workflow you may not read"
    );
    expect(issue?.message).toContain("the operation 'public.tool'; 2 operations you may not read");
    for (const secret of [
      "private-documents",
      "private-child",
      "private-report",
      "private.tool",
      "private-definition"
    ]) {
      expect(issue?.message).not.toContain(secret);
    }
    // Once the child is readable its operations may be named, without lending asset read rights.
    const [readable] = await workflowOutsideIssues(root, {
      ...dependencies,
      readable: (kind, name) => Promise.resolve(kind === "workflow" && name === child.id)
    });
    expect(readable?.message).toContain("'app.private-report.refresh'");
    expect(readable?.message).toContain("'private.tool'");
    expect(readable?.message).not.toContain("private-documents");
    expect(readable?.message).not.toContain("private-child");
  });

  it("names a repeated operation when any definition naming it is readable, in either traversal order", async () => {
    const children = ["hidden", "visible"].map((id): WorkflowManifest => ({
      ...manifest(["shared.operation", "shared.operation"]),
      id,
      name: id,
      inputs: { type: "object" },
      outputs: { type: "object" }
    }));
    for (const order of [children, [...children].reverse()]) {
      const [issue] = await workflowOutsideIssues(
        manifest(order.map(({ id }) => `workflow.${id}.start`)),
        {
          ...deps,
          definitions: {
            read: (id) => {
              const child = children.find((child) => child.id === id);
              return Promise.resolve(child ? { revisionId: id, manifest: child } : undefined);
            }
          },
          readable: (kind, name) => Promise.resolve(kind === "workflow" && name === "visible")
        }
      );
      expect(issue?.message).toContain("the operation 'shared.operation'");
      expect(issue?.message).not.toContain("operations you may not read");
    }
  });
});
