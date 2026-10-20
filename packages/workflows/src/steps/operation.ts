import { workflowPaginateSchema, workflowStepDatasetSchema } from "@work-shape/catalyst-core";
import { z } from "zod";
import { WORKFLOW_OPERATION_NOT_CALLABLE } from "../definition-issue";
import { workflowOperationTimeoutSchema } from "../operation-wait";
import { inputMappingSchema, named, type StepModule, type StepOf } from "./module";

/** The operations that read and change the platform's own assets: `assets.put` and its kin. */
const PLATFORM_ASSET_OPERATION_PREFIX = "assets.";

/**
 * Why a step of a Workflow may not call this operation, or nothing where it may. A step calls
 * what the Workflow does with data: a Connection, a Data Store, a Knowledge Base, an App's
 * action, another Workflow. The operations of the platform's own assets are none of that. A
 * run acts as a service principal, and a change to an agent, a skill, an App or a Workflow is
 * made by a person or by an agent for one, under the rights, drafts and confirmations of that
 * path. So no step names one, whatever its principal holds, and a save refuses it by name.
 */
export function stepOperationRefusal(
  operation: string
): { code: typeof WORKFLOW_OPERATION_NOT_CALLABLE; message: string } | undefined {
  return operation.startsWith(PLATFORM_ASSET_OPERATION_PREFIX)
    ? {
        code: WORKFLOW_OPERATION_NOT_CALLABLE,
        message: `The operation '${operation}' works on the platform's own assets, which a step of a Workflow may not call`
      }
    : undefined;
}

export const operationStep = {
  schema: () =>
    z.strictObject({
      ...named,
      type: z.literal("operation"),
      operation: z.string().min(1),
      input: inputMappingSchema,
      dataset: workflowStepDatasetSchema.optional(),
      paginate: workflowPaginateSchema.optional(),
      timeout: workflowOperationTimeoutSchema.optional()
    }),
  unsupported: (step: StepOf<"operation">, at: string) =>
    step.paginate && !step.dataset
      ? [{ path: `${at}.paginate`, message: "paginate needs dataset.at" }]
      : [],
  structural: (step: StepOf<"operation">, id: string) => {
    const refused = stepOperationRefusal(step.operation);
    return refused ? [{ path: `steps.${id}.operation`, ...refused }] : [];
  }
} satisfies StepModule<"operation">;
