import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_WRITE_OPERATIONS,
  knowledgeWorkflowSourceSchema,
  workflowDatasetReferenceSchema,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationResource
} from "@work-shape/catalyst-core";
import type { KnowledgeRuntime } from "./runtime";

// KBW-1: the write side of a Knowledge Base that keeps documents, for a Workflow. `ingest`
// puts documents into the calling Workflow's source and ends once every item has ended;
// `withdraw` takes items of it out of search at once. Both run only as a step of a Workflow
// run: the source is the run's Workflow, and nobody names another's.

/** How long an ingest pass may take before its run counts as interrupted: indexing included. */
const INGEST_TIMEOUT_MS = 72 * 60 * 60 * 1_000;
const WITHDRAW_TIMEOUT_MS = 60_000;

/**
 * The call's own input check leaves the items alone: each is checked by the pass, so one bad
 * item fails that item and never the step (KBW-0's item schema is that check).
 */
const ingestInputSchema = z.union([
  z.strictObject({ items: z.array(z.unknown()), complete: z.boolean().optional() }),
  z.strictObject({ dataset: workflowDatasetReferenceSchema, complete: z.boolean().optional() })
]);

/** What a step of a test run answers: an empty pass. */
const INGEST_EXAMPLE = {
  accepted: 0,
  done: 0,
  failed: 0,
  failures: { $dataset: "simulated", rowCount: 0, bytes: 0 },
  withdrawn: 0
};

/** The calling Workflow, from the run of the step that calls. */
async function callingWorkflow(
  runtime: KnowledgeRuntime,
  context: OperationExecutionContext,
  operation: string
) {
  const { origin } = context;
  if (origin.kind !== "workflow")
    throw new AppError(
      "VALIDATION_FAILED",
      context.runtime.locale === "de"
        ? `\`${operation}\` läuft nur als Schritt eines Workflow Runs.`
        : `\`${operation}\` runs only as a step of a Workflow Run.`,
      { reason: "workflow_origin_required" },
      { exposeMessage: true }
    );
  const run = await runtime.stores.workflowRuns.readRun({
    clientInstanceId: runtime.clientInstanceId,
    id: origin.workflowRunId
  });
  if (!run) throw new AppError("NOT_FOUND", "The Workflow run is not available");
  const source = knowledgeWorkflowSourceSchema.safeParse({
    id: `workflow:${run.workflow}`,
    kind: "workflow",
    workflowId: run.workflow
  });
  if (!source.success)
    throw new AppError("VALIDATION_FAILED", "The Workflow's id cannot name a source", {
      reason: "knowledge_workflow_source_invalid"
    });
  return { run, origin, workflowId: run.workflow };
}

/** The operations a Workflow writes to a Knowledge Base with. */
export type KnowledgeWritePart = "ingest" | "withdraw";

export function writeOperation(
  runtime: KnowledgeRuntime,
  target: { assetId: string; name: string; resource: OperationResource },
  part: KnowledgeWritePart
): OperationDefinition | undefined {
  const sources = runtime.sources;
  if (!sources) return undefined;
  const contract = KNOWLEDGE_WRITE_OPERATIONS[part];
  const name = `knowledge.${target.name}.${part}`;
  const base = {
    name,
    description: contract.description,
    effect: contract.effect,
    action: contract.right,
    auth: "principal" as const,
    scope: "config_assets:write" as const,
    resource: () => target.resource,
    module: "knowledge"
  };
  if (part === "withdraw")
    return {
      ...base,
      // What it takes out of search a later `ingest` of the same item puts back.
      changeClass: "reversible",
      timeoutMs: WITHDRAW_TIMEOUT_MS,
      inputSchema: KNOWLEDGE_WRITE_OPERATIONS.withdraw.inputSchema,
      outputSchema: KNOWLEDGE_WRITE_OPERATIONS.withdraw.outputSchema,
      async execute(input, context) {
        const { workflowId } = await callingWorkflow(runtime, context, name);
        const { itemIds } = KNOWLEDGE_WRITE_OPERATIONS.withdraw.inputSchema.parse(input);
        const withdrawn = await sources.withdraw(
          { knowledgeBaseId: target.assetId, workflowId, itemIds },
          context.runtime.signal ?? new AbortController().signal
        );
        return { withdrawn };
      }
    };
  return {
    ...base,
    // Documents it puts in are withdrawn again by `withdraw` or a later complete pass.
    changeClass: "reversible",
    batch: true,
    completion: {
      mode: "async",
      stillRunning: "Übernahme läuft weiter",
      example: INGEST_EXAMPLE
    },
    timeoutMs: INGEST_TIMEOUT_MS,
    inputSchema: ingestInputSchema,
    outputSchema: KNOWLEDGE_WRITE_OPERATIONS.ingest.outputSchema,
    async execute(input, context) {
      const { run, origin, workflowId } = await callingWorkflow(runtime, context, name);
      const parsed = ingestInputSchema.parse(input);
      await sources.ingest(
        {
          knowledgeBaseId: target.assetId,
          workflowId,
          workflowRunId: run.id,
          stepRunId: origin.stepRunId,
          operationRunId: context.runId,
          items: "dataset" in parsed ? { dataset: parsed.dataset } : { inline: parsed.items },
          complete: parsed.complete ?? false
        },
        context.runtime.signal ?? new AbortController().signal
      );
      return {};
    }
  };
}
