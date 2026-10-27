import {
  AppError,
  CONNECTION_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_OPERATION_PREFIX,
  WORKFLOW_OUTSIDE_TRIGGER,
  isAuthenticatedServicePrincipal,
  isOutsideCall,
  parseConnectionOperationName,
  type AuthenticatedIdentity,
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
 * Whether a publish is a signed-in person's act: a person in the app, an agent in their chat or
 * a session an embedding host issued for them. Not a personal API key (nor an actor rebuilt for
 * one, as its Inbox confirmation is), a Service Principal's credential or a run.
 */
function publishesAsPerson(actor: AuthenticatedIdentity): boolean {
  return !isAuthenticatedServicePrincipal(actor) && !isOutsideCall(actor, { kind: "user" });
}

/** The reason a publish of a Workflow outside clients may start is refused to a credential. */
export const WORKFLOW_OUTSIDE_SWITCH_PERSON_ONLY = "outside_switch_person_only";

/**
 * The refusal of a publish of a revision outside clients may start, made by a credential: a
 * personal API key (from the CLI, `config push --publish`, an App published with it, or its
 * person's Inbox confirmation of such a call), a Service Principal's credential or a run.
 * Nothing for a person signed in to Catalyst, an agent in their chat included, or for a
 * revision with the switch off, so a key turns the switch off as it publishes anything else.
 *
 * A key's publish with the switch on is refused even where the published revision has it on
 * already: the new revision could read a Data Store that a scheduled Workflow the key also
 * published fills from a Connection kept from outside clients, and Data Stores count as open
 * (connections-and-secrets.md, Workflows started from outside).
 */
export function workflowOutsideSwitchRefusal(
  manifest: Pick<WorkflowManifest, "id" | "steps">,
  actor: AuthenticatedIdentity
): AppError | undefined {
  if (!startsFromOutside(manifest) || publishesAsPerson(actor)) return undefined;
  return new AppError(
    "FORBIDDEN",
    `The Workflow '${manifest.id}' can be started by outside clients, so only a person signed in to Catalyst publishes it: publish it in Catalyst, or turn off starts by outside clients (CLI, MCP) in its settings before publishing it with an API key`,
    { reason: WORKFLOW_OUTSIDE_SWITCH_PERSON_ONLY, workflow: manifest.id },
    { exposeMessage: true }
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
  return (await scanOutsideBlockers(manifest, deps)).blockers;
}

/** Keeps operation provenance internal: enforcement needs blockers, disclosure needs readers. */
async function scanOutsideBlockers(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  deps: Parameters<typeof workflowOutsideBlockers>[1]
) {
  const operationWorkflows = new Map<string, Set<string>>();
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
      const sources = operationWorkflows.get(name) ?? new Set<string>();
      sources.add(definition.id);
      operationWorkflows.set(name, sources);
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
  return { blockers: [...found.values()], operationWorkflows };
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

/** Who reads a refusal: what the publisher may read, by kind and name. */
type OutsideReader = Parameters<typeof workflowOutsideBlockers>[1] & {
  readable(
    kind: Exclude<WorkflowOutsideBlocker["kind"], "operation">,
    name: string
  ): Promise<boolean>;
};

/**
 * What blocks the definition from answering an outside client, in words for its publisher.
 * Assets are named only where the publisher may read them (`readable`), operations only where
 * the publisher may read a definition that names them. All others are counted. Empty where
 * nothing blocks it.
 */
async function outsideBlockerParts(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  deps: OutsideReader
): Promise<string[]> {
  const { blockers, operationWorkflows } = await scanOutsideBlockers(manifest, deps);
  if (blockers.length === 0) return [];
  const visible = await Promise.all(
    blockers.map(async (blocker) => {
      if (blocker.kind !== "operation") return deps.readable(blocker.kind, blocker.name);
      const sources = operationWorkflows.get(blocker.name) ?? new Set<string>();
      if (sources.has(manifest.id)) return true;
      return (await Promise.all([...sources].map((name) => deps.readable("workflow", name)))).some(
        Boolean
      );
    })
  );
  const parts: string[] = [];
  const labels = [
    ["connection", "Connection", "Connections"],
    ["knowledge_base", "Knowledge Base", "Knowledge Bases"],
    ["workflow", "unpublished child Workflow", "unpublished child Workflows"],
    ["operation", "operation", "operations"]
  ] as const;
  for (const [kind, one, many] of labels) {
    const named = blockers.filter((blocker, index) => blocker.kind === kind && visible[index]);
    const hidden = blockers.filter(
      (blocker, index) => blocker.kind === kind && !visible[index]
    ).length;
    if (named.length > 0) {
      parts.push(
        `the ${named.length === 1 ? one : many} ${named.map(({ name }) => `'${name}'`).join(", ")}`
      );
    }
    if (hidden > 0) {
      parts.push(
        hidden === 1
          ? `${kind === "operation" || kind === "workflow" ? "an" : "a"} ${one} you may not read`
          : `${hidden} ${many} you may not read`
      );
    }
  }
  return parts;
}

/**
 * What a publish is refused for: a revision outside clients may start that reads data not
 * exposed to them, named as `outsideBlockerParts` names it. The start asks again, since a
 * Connection or a child changes later.
 */
export async function workflowOutsideIssues(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  deps: OutsideReader
): Promise<WorkflowDefinitionIssue[]> {
  if (!startsFromOutside(manifest)) return [];
  const parts = await outsideBlockerParts(manifest, deps);
  if (parts.length === 0) return [];
  const [trigger] = manifest.steps;
  return [
    {
      code: WORKFLOW_OUTSIDE_NOT_EXPOSED,
      path: trigger ? `steps.${trigger.id}.triggers` : "steps",
      message: `Outside clients may start it, and it reads data they may not have: ${parts.join("; ")}. Expose the operations it calls to outside clients on the Connection's page, or turn off starts by outside clients`
    }
  ];
}

/** The reason a credential's publish of a Workflow that reaches closed data is refused. */
export const WORKFLOW_REACH_PERSON_ONLY = "reach_person_only";

/**
 * The refusal of a publish by a credential (a personal API key, a Service Principal's
 * credential or a run, as `workflowOutsideSwitchRefusal` names them) of a revision whose reach,
 * child Workflows included, is not open to outside clients by the scan a start from outside
 * asks, whatever its switch says. Such a Workflow can read a Connection kept from outside
 * clients or a Knowledge Base and copy it into a Data Store that an outside Workflow reads, so
 * publishing it is a signed-in person's act (WF-OUT). Nothing for a person, or for a revision
 * whose reach is open to outside clients: a key publishes that as before.
 */
export async function workflowReachRefusal(
  manifest: Pick<WorkflowManifest, "id" | "steps" | "tools">,
  actor: AuthenticatedIdentity,
  deps: OutsideReader
): Promise<AppError | undefined> {
  if (publishesAsPerson(actor)) return undefined;
  const parts = await outsideBlockerParts(manifest, deps);
  if (parts.length === 0) return undefined;
  return new AppError(
    "FORBIDDEN",
    `The Workflow '${manifest.id}' reads data that is not exposed to outside clients (${parts.join("; ")}), so only a person signed in to Catalyst publishes it: publish it in Catalyst, or have the operations it calls exposed to outside clients on the Connection's page`,
    { reason: WORKFLOW_REACH_PERSON_ONLY, workflow: manifest.id },
    { exposeMessage: true }
  );
}
