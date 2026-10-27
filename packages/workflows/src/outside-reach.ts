import {
  AppError,
  CONNECTION_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_OPERATION_PREFIX,
  WORKFLOW_OUTSIDE_TRIGGER,
  parseConnectionOperationName,
  type ClientInstanceId,
  type ConfigAssetStore,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { indexWorkflowSteps } from "./definition";
import { WORKFLOW_OUTSIDE_NOT_EXPOSED, type WorkflowDefinitionIssue } from "./definition-issue";
import type { WorkflowDefinitionSource } from "./definition-source";
import { workflowOperationNames } from "./needed-rights";

// A Workflow started from outside (an API key, a Service Principal's credential, the CLI or
// the platform MCP server) answers a computer the instance does not control. Its run acts as
// its own principal under exposure `workflow`, so without this rule a Workflow would hand a key
// what a Connection's admin kept from outside clients: the Connection's data would be laundered
// through the Workflow (connections-and-secrets.md, Exposure to outside clients).
//
// The rule: a Workflow is started from outside only where its trigger says `outside`, and only
// while every Connection operation a run of it may call, through a child Workflow too, is
// exposed to `outside`. The Connection's admin stays the one who decides whether its data
// leaves the instance; the Workflow's publisher decides only whether the Workflow does.

export { WORKFLOW_OUTSIDE_TRIGGER };

/** Whether the definition's trigger lets an outside client start it. */
export function startsFromOutside(manifest: Pick<WorkflowManifest, "steps">): boolean {
  const [trigger] = manifest.steps;
  return (
    trigger?.type === "trigger" &&
    trigger.triggers.some(({ kind }) => kind === WORKFLOW_OUTSIDE_TRIGGER)
  );
}

/**
 * What keeps a run of the definition from answering an outside client: a Connection whose
 * operation it calls is not exposed to `outside`, a Knowledge Base it reads (its documents may
 * come from a Connection, directly or through a Workflow), a child Workflow that is not
 * published, or any other operation it calls. Each is named once.
 */
export interface WorkflowOutsideBlocker {
  kind: "connection" | "knowledge_base" | "workflow" | "operation";
  name: string;
}

/**
 * The operations a run started from outside may call besides Connection operations and child
 * starts, each asked below: a Data Store's (the publisher's data, under the
 * switch the publisher turns on) and sending mail (nothing comes back). Every other name is
 * closed, so an operation added later is closed until it is named here.
 */
const OPEN_OPERATION_PREFIXES = [DATA_STORE_OPERATION_PREFIX] as const;
const OPEN_OPERATIONS = new Set(["mail.send"]);

const connectionExposureSchema = z.object({
  operations: z.array(z.object({ name: z.string(), exposure: z.array(z.string()) }))
});

/** `workflow.<id>.start`: the id of the Workflow it starts, or nothing for any other name. */
function startedWorkflow(name: string): string | undefined {
  const match = /^workflow\.([a-z][a-z0-9_-]{0,62})\.start$/u.exec(name);
  return name.startsWith(WORKFLOW_OPERATION_PREFIX) ? match?.[1] : undefined;
}

/** `knowledge.<id>.<operation>`: the Knowledge Base any of its operations names. */
function knowledgeBaseOf(name: string): string | undefined {
  if (!name.startsWith(KNOWLEDGE_OPERATION_PREFIX)) return undefined;
  const [, knowledgeBase] = name.split(".");
  return knowledgeBase || undefined;
}

/**
 * Everything that keeps the published definition from answering an outside client, read now:
 * its operation steps, its agent steps' tools and its child Workflows' published revisions,
 * however deep. Empty where it may answer one. Asked at every start from outside and at every
 * child start of such a run, so a Connection changed or a child published since is asked again.
 */
export async function workflowOutsideBlockers(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  deps: {
    clientInstanceId: ClientInstanceId;
    configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
    definitions: Pick<WorkflowDefinitionSource, "read">;
  }
): Promise<WorkflowOutsideBlocker[]> {
  const found = new Map<string, WorkflowOutsideBlocker>();
  const block = (kind: WorkflowOutsideBlocker["kind"], name: string) =>
    found.set(`${kind}\u0000${name}`, { kind, name });
  const seen = new Set<string>();
  const exposures = new Map<string, Promise<Map<string, readonly string[]> | undefined>>();
  const exposuresOf = (connection: string) => {
    let pending = exposures.get(connection);
    if (!pending) {
      pending = deps.configAssets
        .getConfigAsset({
          clientInstanceId: deps.clientInstanceId,
          kind: CONNECTION_ASSET_KIND,
          name: connection
        })
        .then((asset) => {
          if (!asset || asset.status !== "active" || asset.scope.kind !== "instance") return;
          const parsed = connectionExposureSchema.safeParse(asset.config);
          return parsed.success
            ? new Map(parsed.data.operations.map((entry) => [entry.name, entry.exposure]))
            : undefined;
        });
      exposures.set(connection, pending);
    }
    return pending;
  };

  async function visit(definition: Pick<WorkflowManifest, "id" | "steps" | "tools">) {
    if (seen.has(definition.id)) return;
    seen.add(definition.id);
    const children = new Set<string>();
    for (const { step } of indexWorkflowSteps(definition).values()) {
      if (step.type === "workflow") children.add(step.workflow);
    }
    for (const name of workflowOperationNames(definition)) {
      const child = startedWorkflow(name);
      if (child !== undefined) {
        children.add(child);
        continue;
      }
      const operation = parseConnectionOperationName(name);
      if (operation) {
        // An operation that is gone or unreadable counts as closed: the rule never guesses open.
        const exposure = (await exposuresOf(operation.connection))?.get(operation.operation);
        if (!exposure?.includes("outside")) block("connection", operation.connection);
        continue;
      }
      const knowledgeBase = knowledgeBaseOf(name);
      if (knowledgeBase !== undefined) {
        // A Knowledge Base's documents may come from a Connection's source or from a Workflow
        // that read one, kept in the Knowledge Base's own store where its definition does not
        // say: every operation of one is closed.
        block("knowledge_base", knowledgeBase);
        continue;
      }
      if (
        OPEN_OPERATIONS.has(name) ||
        OPEN_OPERATION_PREFIXES.some((prefix) => name.startsWith(prefix))
      ) {
        continue;
      }
      // An App's action (under `bridge`), an API operation that reads runs or sources as the
      // Workflow's account, a tool of the release: none is asked of `outside`, so all are closed.
      block("operation", name);
    }
    for (const child of children) {
      const revision = await deps.definitions.read(child, deps.configAssets);
      if (!revision) {
        block("workflow", child);
        continue;
      }
      await visit(revision.manifest);
    }
  }

  await visit(manifest);
  return [...found.values()];
}

/**
 * The refusal of a start from outside that a blocker stops. It names no Connection: the caller
 * may use the Workflow and still not be one who may see the Connections it calls.
 */
export function workflowOutsideRefusal(workflow: string): AppError {
  return new AppError(
    "FORBIDDEN",
    `The Workflow '${workflow}' reads data that is not exposed to outside clients, so it is not started from outside`,
    { reason: "no_grant", action: "connection_exposure:outside" },
    { exposeMessage: true }
  );
}

/** The refusal of a dataset input from outside whose run answers no outside client. */
export function workflowOutsideDatasetRefusal(): AppError {
  return new AppError(
    "FORBIDDEN",
    "The dataset comes from a run whose data is not exposed to outside clients",
    { reason: "no_grant", action: "connection_exposure:outside" },
    { exposeMessage: true }
  );
}

/** The refusal of a start from outside of a Workflow whose trigger does not admit one. */
export function workflowNotOutsideRefusal(workflow: string): AppError {
  return new AppError(
    "CONFLICT",
    `The Workflow '${workflow}' is not started from outside: whoever may publish it turns on starts by outside clients in its settings`,
    { reason: "no_outside_trigger" },
    { exposeMessage: true }
  );
}

/**
 * What a publish is refused for: a revision outside clients may start that reads data not
 * exposed to them, with what blocks it by name. A Connection is named only where the publisher
 * may read it (`readable`): a child Workflow's account may use Connections the publisher may
 * not see, and those are counted. The start asks again, since a Connection or a child changes
 * later.
 */
export async function workflowOutsideIssues(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  deps: Parameters<typeof workflowOutsideBlockers>[1] & {
    readable(connection: string): Promise<boolean>;
  }
): Promise<WorkflowDefinitionIssue[]> {
  if (!startsFromOutside(manifest)) return [];
  const blockers = await workflowOutsideBlockers(manifest, deps);
  if (blockers.length === 0) return [];
  const namesOf = (kind: WorkflowOutsideBlocker["kind"]) =>
    blockers.flatMap((blocker) => (blocker.kind === kind ? [blocker.name] : []));
  const listed = (names: readonly string[], one: string, many: string) =>
    names.length === 0
      ? []
      : [`${names.length === 1 ? one : many} ${names.map((name) => `'${name}'`).join(", ")}`];
  const connections = namesOf("connection");
  const shown = await Promise.all(connections.map((name) => deps.readable(name)));
  const hidden = shown.filter((readable) => !readable).length;
  const parts = [
    ...listed(
      connections.filter((_name, index) => shown[index]),
      "the Connection",
      "the Connections"
    ),
    ...(hidden === 0
      ? []
      : [
          hidden === 1 ? "a Connection you may not read" : `${hidden} Connections you may not read`
        ]),
    ...listed(namesOf("knowledge_base"), "the Knowledge Base", "the Knowledge Bases"),
    ...listed(
      namesOf("workflow"),
      "the unpublished child Workflow",
      "the unpublished child Workflows"
    ),
    ...listed(namesOf("operation"), "the operation", "the operations")
  ];
  const [trigger] = manifest.steps;
  return [
    {
      code: WORKFLOW_OUTSIDE_NOT_EXPOSED,
      path: trigger ? `steps.${trigger.id}.triggers` : "steps",
      message: `Outside clients may start it, and it reads data they may not have: ${parts.join("; ")}. Expose the operations it calls to outside clients on the Connection's page, or turn off starts by outside clients`
    }
  ];
}
