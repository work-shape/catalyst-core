import {
  AppError,
  WORKFLOW_RUN_KEY_MAX_LENGTH,
  WORKFLOW_RUN_MAX_DEPTH,
  WORKFLOW_START_KEY_INPUT,
  auditActorFromIdentity,
  isWorkflowRunEnded,
  type AuthenticatedIdentity,
  workflowRunKeySchema,
  workflowStartOperationName,
  type ClientInstanceId,
  type JsonObject,
  type OperationResolutionStores,
  type OperationSource,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { jsonObjectSchema } from "./json";
import { workflowDefinitionPages, type WorkflowDefinitionSource } from "./definition-source";
import { runKeyRefusal, type StartWorkflowRunInput } from "./run-open";
import type { PreparedStart } from "./run-start";
import type { RunOrigin } from "./scheduled-start";
import { assertRunLinkIsAcyclic } from "./child-run-links";
import { workflowResource } from "./workflow-resource";
import { childDefinition } from "./child-definition";

/** A start must record its durable run promptly; overdue Operation Runs can be recovered. */
const WORKFLOW_START_OPERATION_TIMEOUT_MS = 30_000;

/**
 * The input of `workflow.<id>.start`: the Workflow's inputs, and beside them the run key under
 * `WORKFLOW_START_KEY_INPUT`, which no Workflow declares as an input.
 */
function splitStartInput(input: unknown): { inputs: unknown; key?: string } {
  const object = jsonObjectSchema.safeParse(input);
  if (!object.success || !Object.hasOwn(object.data, WORKFLOW_START_KEY_INPUT)) {
    return { inputs: input };
  }
  const { [WORKFLOW_START_KEY_INPUT]: given, ...inputs } = object.data;
  const key = workflowRunKeySchema.safeParse(given);
  if (!key.success) throw runKeyRefusal();
  return { inputs, key: key.data };
}

/** The schema of the start's input as callers read it: the Workflow's inputs and the key. */
function startInputJsonSchema(inputs: JsonObject | undefined): JsonObject {
  const base = inputs ?? { type: "object" };
  const properties = jsonObjectSchema.safeParse(base.properties);
  return {
    ...base,
    properties: {
      ...(properties.success ? properties.data : {}),
      [WORKFLOW_START_KEY_INPUT]: {
        type: "string",
        minLength: 1,
        maxLength: WORKFLOW_RUN_KEY_MAX_LENGTH,
        description:
          "The run key. A run of this Workflow that is open or done and holds it answers the start, which then starts nothing."
      }
    }
  };
}

/** Starts go through the operation path; only a workflow step owns the run it starts. */
export function createWorkflowStartSource(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  definitions: WorkflowDefinitionSource;
  now(): Date;
  start(input: StartWorkflowRunInput, mode: WorkflowRun["mode"]): Promise<WorkflowRun>;
  prepare(
    revision: NonNullable<Awaited<ReturnType<WorkflowDefinitionSource["read"]>>>,
    input: unknown
  ): Promise<PreparedStart>;
  open(
    tx: PlatformStores,
    prepared: PreparedStart,
    origin: RunOrigin,
    mode: WorkflowRun["mode"]
  ): Promise<WorkflowRun | undefined>;
  /** Whether the person testing may write a Workflow, by their own rights, not the principal's. */
  mayWrite?(
    actor: AuthenticatedIdentity,
    resource: ReturnType<typeof workflowResource>
  ): Promise<boolean>;
}): OperationSource {
  const { clientInstanceId, stores, definitions } = options;
  async function resolve(name: string, readers?: OperationResolutionStores) {
    const match = /^workflow\.([a-z][a-z0-9_-]{0,62})\.start$/u.exec(name);
    const workflow = match?.[1];
    if (!workflow) return undefined;
    const published = await definitions.read(workflow, readers?.configAssets);
    const asset = await (readers?.configAssets ?? stores.configAssets).getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: workflow
    });
    /**
     * The revision a parent's step starts: the published one, and in a test run the child's
     * draft where the person testing may write the child (DP-4). A draft never runs live.
     */
    const childRevision = async (parentRunId: string, actor: AuthenticatedIdentity) => {
      const parent = await stores.workflowRuns.readRun({ clientInstanceId, id: parentRunId });
      return childDefinition({
        definitions,
        published,
        mode: parent?.mode,
        actor,
        resource: workflowResource(workflow, asset),
        mayWrite: options.mayWrite
      });
    };
    return {
      name,
      effect: "changing" as const,
      changeClass: "reversible" as const,
      repeatsUnderKey: true as const,
      draftTarget: "test" as const,
      scope: "config_assets:write" as const,
      auth: "principal" as const,
      action: "workflow.use",
      module: "workflows",
      timeoutMs: WORKFLOW_START_OPERATION_TIMEOUT_MS,
      inputJsonSchema: startInputJsonSchema(published?.manifest.inputs),
      outputJsonSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      // The executable input check belongs to prepareStart. Keeping the call schema
      // structural lets an interrupted start recover its persisted run after republishing.
      inputSchema: jsonObjectSchema,
      outputSchema: z.object({ id: z.string() }),
      resource: () => workflowResource(workflow, asset),
      async execute(
        input: unknown,
        context: import("@work-shape/catalyst-core").OperationExecutionContext
      ) {
        const first = await stores.workflowRuns.findRunByOperation({
          clientInstanceId,
          operationRunId: context.runId
        });
        if (first) return { id: first.id };
        const { inputs, key } = splitStartInput(input);
        const origin = context.origin;
        const step =
          origin.kind === "workflow"
            ? await stores.workflowRuns.getStepRun({ clientInstanceId, id: origin.stepRunId })
            : undefined;
        if (
          origin.kind !== "workflow" ||
          step?.stepType !== "workflow" ||
          step.runId !== origin.workflowRunId
        ) {
          const call = await stores.operationRuns.get({ clientInstanceId, id: context.runId });
          const run = await options.start(
            {
              workflow,
              input: inputs,
              ...(key === undefined ? {} : { key }),
              startedBy: context.actor,
              operationRunId: context.runId,
              correlationId: context.correlationId,
              ...(origin.kind === "workflow" && step?.runId === origin.workflowRunId
                ? { datasetInputRunId: step.runId }
                : {})
            },
            call?.target === "test" ? "test" : "live"
          );
          return { id: run.id };
        }
        const existing = await stores.workflowRuns.findChildRun({ clientInstanceId, id: step.id });
        if (existing) return { id: existing.id };
        // A retried attempt of a step whose start a key answered: the run it links to.
        if (step.linkedRunId) return { id: step.linkedRunId };
        const revision = await childRevision(step.runId, context.actor);
        if (!revision) throw new AppError("NOT_FOUND", "There is no published child Workflow");
        const [trigger] = revision.manifest.steps;
        if (trigger?.type !== "trigger" || !trigger.triggers.some((t) => t.kind === "parent")) {
          throw new AppError("CONFLICT", "The child Workflow does not accept a parent", {
            reason: "no_parent_trigger"
          });
        }
        const prepared = await options.prepare(revision, inputs);
        const run = await stores.transaction(async (tx) => {
          // Keyed starts may link existing runs. Serialize their guard reads through the
          // link write, before either run row lock; disjoint row pairs can close a cycle.
          // Unkeyed starts only create children, which have no outgoing waits.
          if (key !== undefined) await tx.workflowRuns.lockRunLinks({ clientInstanceId });
          // The parent lock serializes starts with cancellation and competing attempts.
          const parent = await tx.workflowRuns.lockRun({ clientInstanceId, id: step.runId });
          if (
            !parent ||
            isWorkflowRunEnded(parent.status) ||
            Date.parse(parent.deadlineAt) <= options.now().getTime()
          ) {
            throw new AppError("CONFLICT", "The parent run has ended", { reason: "parent_ended" });
          }
          const first = await tx.workflowRuns.findChildRun({ clientInstanceId, id: step.id });
          if (first) return first;
          const linked = (await tx.workflowRuns.getStepRun({ clientInstanceId, id: step.id }))
            ?.linkedRunId;
          if (linked) return { id: linked };
          if (parent.depth >= WORKFLOW_RUN_MAX_DEPTH) {
            throw new AppError("CONFLICT", "A child run cannot start below three levels", {
              reason: "depth_limit"
            });
          }
          const run = await options.open(
            tx,
            prepared,
            {
              ...(key === undefined ? {} : { runKey: key }),
              trigger: "parent",
              startedBy: parent.startedBy,
              operationRunId: context.runId,
              correlationId: parent.correlationId,
              actor: auditActorFromIdentity(context.actor),
              parentRunId: parent.id,
              parentStepRunId: step.id,
              rootRunId: parent.rootRunId,
              depth: parent.depth + 1,
              ...(step.iteration
                ? {
                    itemIndex: step.iteration.index,
                    ...(step.iteration.label === undefined
                      ? {}
                      : { itemLabel: step.iteration.label })
                  }
                : {}),
              deadlineAt: parent.deadlineAt,
              // The child takes the slots of its root, which its parent was opened under.
              parentLimits: parent.limits
            },
            parent.mode
          );
          // A run of another step or start holds the key: the step links to it and does not
          // own it. The holder is locked, so its end comes after this link and wakes the step.
          if (run && run.parentStepRunId !== step.id) {
            await assertRunLinkIsAcyclic(tx.workflowRuns, parent, run);
            await tx.workflowRuns.linkStepRun({
              clientInstanceId,
              id: step.id,
              linkedRunId: run.id
            });
          }
          return run;
        });
        if (!run) throw new AppError("INTERNAL", "The child run could not be opened");
        return { id: run.id };
      }
    };
  }
  return {
    resolve,
    async list() {
      const operations = [];
      for await (const page of workflowDefinitionPages(definitions)) {
        for (const workflow of page) {
          const operation = await resolve(workflowStartOperationName(workflow.id));
          if (operation) operations.push(operation);
        }
      }
      return { operations, truncated: [] };
    }
  };
}

/** A terminal child supplies the parent's step result, never its preview. */
export async function childStepOutcome(
  stores: PlatformStores,
  run: WorkflowRun,
  step: WorkflowStepRun
) {
  // The run the step owns, or the run a key answered its start with and it links to.
  const child =
    (await stores.workflowRuns.findChildRun({
      clientInstanceId: run.clientInstanceId,
      id: step.id
    })) ??
    (step.linkedRunId === undefined
      ? undefined
      : await stores.workflowRuns.readRun({
          clientInstanceId: run.clientInstanceId,
          id: step.linkedRunId
        }));
  if (!child || !isWorkflowRunEnded(child.status)) return undefined;
  if (child.status !== "done")
    return {
      kind: "failed" as const,
      systemic: false,
      error: {
        code: child.error?.code ?? `child_${child.status}`,
        message: `The child Workflow ended as ${child.status}`
      }
    };
  const output = await stores.workflowRuns.readRunOutput({
    clientInstanceId: run.clientInstanceId,
    id: child.id
  });
  if (!output)
    return {
      kind: "failed" as const,
      systemic: false,
      error: { code: "child_output_unavailable", message: "The child run's output is unavailable" }
    };
  return { kind: "done" as const, output: output.value };
}
