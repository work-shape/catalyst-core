import {
  workflowValuePreview,
  type JsonValue,
  type PlatformStores,
  type OperationRegistry,
  type WorkflowManifest,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { workflowStepSchemas } from "./dataset-contracts";
import type { WorkflowDefinitionSource } from "./definition-source";
import type { ReferenceScope, TextSchemas } from "./references";

/**
 * Keeps the cut preview of a step's resolved input for its run page. An input holding a
 * dataset row keeps none: the row would outlive its dataset in the step run.
 */
export async function recordStepInput(
  store: PlatformStores["workflowRuns"],
  scope: ReferenceScope,
  input: JsonValue
): Promise<void> {
  if (scope.readDatasetRow) return;
  await store.recordStepRunInput({
    clientInstanceId: scope.run.clientInstanceId,
    id: scope.stepRun.id,
    preview: workflowValuePreview(input)
  });
}

/** Lazily reads the schemas needed by a composed text or a referenced Markdown field. */
export function stepTextSchemas(
  definitions: Pick<WorkflowDefinitionSource, "read">,
  registry: Pick<OperationRegistry, "resolve">
) {
  return (attempt: { definition: WorkflowManifest; stepRun: WorkflowStepRun }) =>
    async (): Promise<TextSchemas> => {
      const schemas = await workflowStepSchemas(attempt.definition, definitions, registry);
      const step = attempt.stepRun.stepId;
      return {
        input: schemas.input(step),
        reference: (reference) => schemas.reference(step, reference)
      };
    };
}
