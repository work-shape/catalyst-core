import {
  AppError,
  WORKFLOW_RUN_MAX_DEPTH,
  auditActorFromIdentity,
  isWorkflowRunEnded,
  workflowStartOperationName,
  type ClientInstanceId,
  type OperationSource,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { jsonObjectSchema } from "./json";
import type { WorkflowDefinitionSource } from "./definition-source";
import type { StartWorkflowRunInput } from "./run-open";
import type { PreparedStart } from "./run-start";
import type { RunOrigin } from "./scheduled-start";

/** A start must record its durable run promptly; overdue Operation Runs can be recovered. */
const WORKFLOW_START_OPERATION_TIMEOUT_MS = 30_000;

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
}): OperationSource {
  const { clientInstanceId, stores, definitions } = options;
  async function resolve(name: string) {
    const match = /^workflow\.([a-z][a-z0-9_-]{0,62})\.start$/u.exec(name);
    const workflow = match?.[1];
    if (!workflow) return undefined;
    const published = await definitions.read(workflow);
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: workflow
    });
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
      inputJsonSchema: published?.manifest.inputs ?? { type: "object" },
      outputJsonSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      // The executable input check belongs to prepareStart. Keeping the call schema
      // structural lets an interrupted start recover its persisted run after republishing.
      inputSchema: jsonObjectSchema,
      outputSchema: z.object({ id: z.string() }),
      resource: () => ({
        kind: "workflow",
        id: asset?.id ?? workflow,
        name: workflow,
        ...(asset ? { assetId: asset.id } : {})
      }),
      async execute(
        input: unknown,
        context: import("@work-shape/catalyst-core").OperationExecutionContext
      ) {
        const first = await stores.workflowRuns.findRunByOperation({
          clientInstanceId,
          operationRunId: context.runId
        });
        if (first) return { id: first.id };
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
              input,
              startedBy: context.actor,
              operationRunId: context.runId,
              correlationId: context.correlationId
            },
            call?.target === "test" ? "test" : "live"
          );
          return { id: run.id };
        }
        const existing = await stores.workflowRuns.findChildRun({ clientInstanceId, id: step.id });
        if (existing) return { id: existing.id };
        if (!published) throw new AppError("NOT_FOUND", "There is no published child Workflow");
        const [trigger] = published.manifest.steps;
        if (trigger?.type !== "trigger" || !trigger.triggers.some((t) => t.kind === "parent")) {
          throw new AppError("CONFLICT", "The child Workflow does not accept a parent", {
            reason: "no_parent_trigger"
          });
        }
        const prepared = await options.prepare(published, input);
        const run = await stores.transaction(async (tx) => {
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
          if (parent.depth >= WORKFLOW_RUN_MAX_DEPTH) {
            throw new AppError("CONFLICT", "A child run cannot start below three levels", {
              reason: "depth_limit"
            });
          }
          return options.open(
            tx,
            prepared,
            {
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
              deadlineAt: parent.deadlineAt
            },
            parent.mode
          );
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
      for (const workflow of await definitions.list()) {
        const operation = await resolve(workflowStartOperationName(workflow.id));
        if (operation) operations.push(operation);
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
  const child = await stores.workflowRuns.findChildRun({
    clientInstanceId: run.clientInstanceId,
    id: step.id
  });
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
