import type {
  WorkflowInputValue,
  WorkflowLiteralOrReference,
  WorkflowManifest
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";
import type { WorkflowDefinitionSource } from "./definition-source";

/**
 * The input by which a child Workflow names the revision of its rules. It is a convention, not a
 * field of the manifest: a child that declares it says that a run under other rules is another
 * run, so the parent's run key must hold the value the parent passes in it.
 */
export const WORKFLOW_RULES_REVISION_INPUT = "rulesRevision";

/** The code of the warning for a run key without the child's rules revision. */
const WORKFLOW_KEY_WITHOUT_RULES_REVISION = "child_key_without_rules_revision";

/** What a check of a definition says beside its issues, and that refuses nothing. */
export interface WorkflowDefinitionWarning {
  code: string;
  message: string;
}

function sameSource(left: WorkflowLiteralOrReference, right: WorkflowInputValue): boolean {
  // A text joined from parts is no source a key part can repeat.
  if (right.text !== undefined) return false;
  if (left.ref && right.ref)
    return left.ref.step === right.ref.step && left.ref.path === right.ref.path;
  return left.ref === undefined && right.ref === undefined && left.value === right.value;
}

/** Whether the child declares the rules revision input, and its fixed value where it has one. */
function declaredRevision(inputs: WorkflowManifest["inputs"]): {
  declared: boolean;
  fixed?: unknown;
} {
  const { properties } = inputs;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties))
    return { declared: false };
  const property = properties[WORKFLOW_RULES_REVISION_INPUT];
  if (typeof property !== "object" || property === null || Array.isArray(property))
    return { declared: false };
  return { declared: true, fixed: property.const };
}

/**
 * A warning for each keyed `workflow` step whose child declares `rulesRevision` and whose key
 * holds neither the source the step maps into it nor the child's fixed value. A run of the
 * child that is done under the key would answer the step with what it found under other
 * rules. It reads the mapping, the key and the child's published inputs; what a script holds
 * as its revision is not read, so a revision kept only in a script is not checked.
 */
export async function childRulesRevisionWarnings(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">
): Promise<WorkflowDefinitionWarning[]> {
  const warnings: WorkflowDefinitionWarning[] = [];
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type !== "workflow" || step.key === undefined) continue;
    const child = await definitions.read(step.workflow);
    if (!child) continue;
    const { declared, fixed } = declaredRevision(child.manifest.inputs);
    if (!declared) continue;
    const mapped = step.input[WORKFLOW_RULES_REVISION_INPUT];
    const held = step.key.some(
      (part) =>
        (mapped !== undefined && sameSource(part, mapped)) ||
        (fixed !== undefined && part.ref === undefined && part.value === fixed)
    );
    if (held) continue;
    warnings.push({
      code: WORKFLOW_KEY_WITHOUT_RULES_REVISION,
      message: `The key of step '${step.id}' does not hold the '${WORKFLOW_RULES_REVISION_INPUT}' it passes to '${step.workflow}': a run of the child that is done under this key answers with what it found under other rules. Put the same reference or value in the key.`
    });
  }
  return warnings;
}
