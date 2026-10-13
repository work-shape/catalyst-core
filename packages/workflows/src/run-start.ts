import { compileJsonSchema } from "@vivd-catalyst/connections";
import {
  AppError,
  type ClientInstanceId,
  type JsonObject,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStep
} from "@vivd-catalyst/core";
import type { WorkflowDefinitionRevision } from "./definition-source";
import { jsonBytes, jsonObjectSchema } from "./json";
import type { WorkflowRunLimits } from "./limits";
import { secretOperationSteps, type WorkflowOperationCalls } from "./operation-step";
import { workflowRunPrincipal } from "./run-identity";

/** What a start is checked against: the instance, its operations and the bounds of a run. */
interface StartCheckOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  operationCalls: WorkflowOperationCalls;
  limits: WorkflowRunLimits;
}

/** A start that passed its check: what the run is written from. */
export interface PreparedStart {
  published: WorkflowDefinitionRevision;
  trigger: Extract<WorkflowStep, { type: "trigger" }>;
  input: JsonObject;
  principal: WorkflowRun["principal"];
}

/** The check every start of a run passes, by hand or by a schedule, before a run exists. */
export function createStartCheck(options: StartCheckOptions) {
  const { clientInstanceId, stores, operationCalls, limits } = options;
  /**
   * What every start checks before a run exists: the input against the definition, the
   * operations of the steps, and the principal the run acts as. It throws the refusal.
   */
  return async function prepareStart(
    published: WorkflowDefinitionRevision,
    given: unknown
  ): Promise<PreparedStart> {
    const { manifest } = published;
    const [trigger] = manifest.steps;
    if (trigger?.type !== "trigger") {
      throw new AppError("CONFLICT", `The Workflow '${manifest.id}' has no trigger`, {
        reason: "no_trigger"
      });
    }
    const schema = compileJsonSchema(manifest.inputs);
    if (!schema.ok) {
      throw new AppError("CONFLICT", "The Workflow's inputs are a schema that cannot be checked", {
        reason: "inputs_unreadable"
      });
    }
    const runInput = jsonObjectSchema.safeParse(given ?? {});
    const issues = runInput.success ? schema.validate(runInput.data) : [];
    if (!runInput.success || issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", "The input does not fit the Workflow's inputs", {
        reason: "input_invalid",
        issues: issues.map((issue) => ({ path: issue.path, message: issue.message }))
      });
    }
    if (jsonBytes(runInput.data) > limits.stepDataMaxBytes) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The input of a run is at most ${limits.stepDataMaxBytes} bytes`,
        { reason: "input_invalid" }
      );
    }
    const secret = await secretOperationSteps(manifest, operationCalls.registry);
    if (secret.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The definition of the Workflow '${manifest.id}' cannot be run: ${secret[0]?.message ?? ""}`,
        { reason: "operation_secret", issues: secret }
      );
    }
    const principal = await workflowRunPrincipal(stores.apiAccess, clientInstanceId, manifest);
    if (!principal) {
      throw new AppError(
        "CONFLICT",
        `The instance has no active service principal named '${manifest.runAs}', which the Workflow '${manifest.id}' runs as`,
        { reason: "principal_inactive" }
      );
    }
    return { published, trigger, input: runInput.data, principal };
  };
}
