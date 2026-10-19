import { checkDatasetContracts } from "./dataset-contracts";
import { workflowValueSchema } from "./dataset-schema";
import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  AppError,
  createServicePrincipalId,
  type ClientInstanceId,
  type JsonObject,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunMode,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import type { WorkflowDefinitionRevision } from "./definition-source";
import { jsonBytes, jsonObjectSchema, unstorableTextPaths } from "./json";
import type { WorkflowRunLimits } from "./limits";
import { secretOperationSteps, type WorkflowOperationCalls } from "./operation-step";
import { workflowRunPrincipal } from "./run-identity";

/** What a start is checked against: the instance, its operations and the bounds of a run. */
interface StartCheckOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  operationCalls: WorkflowOperationCalls;
  limits: WorkflowRunLimits;
  definitions: import("./definition-source").WorkflowDefinitionSource;
}

/** A start that passed its check: what the run is written from. */
export interface PreparedStart {
  published: WorkflowDefinitionRevision;
  trigger: Extract<WorkflowStep, { type: "trigger" }>;
  input: JsonObject;
  checkpoint?: import("@work-shape/catalyst-core").NewWorkflowRun["checkpoint"];
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
    given: unknown,
    mode?: WorkflowRunMode
  ): Promise<PreparedStart> {
    const { manifest } = published;
    await checkDatasetContracts(manifest, options.definitions, operationCalls.registry);
    const [trigger] = manifest.steps;
    if (trigger?.type !== "trigger") {
      throw new AppError("CONFLICT", `The Workflow '${manifest.id}' has no trigger`, {
        reason: "no_trigger"
      });
    }
    const schema = compileJsonSchema(workflowValueSchema(manifest.inputs, manifest.types));
    if (!schema.ok) {
      throw new AppError("CONFLICT", "The Workflow's inputs are a schema that cannot be checked", {
        reason: "inputs_unreadable"
      });
    }
    const runInput = jsonObjectSchema.safeParse(given ?? {});
    const issues = runInput.success ? schema.validate(runInput.data) : [];
    if (runInput.success && issues.length === 0) {
      // The run stores its input as JSON, which holds no NUL character and no half of a
      // surrogate pair: such a value is the caller's to mend, under the field that has it.
      for (const path of unstorableTextPaths(runInput.data)) {
        issues.push({
          path,
          message: "must not hold a NUL character or half of a surrogate pair"
        });
      }
    }
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
    const principal =
      mode === "test" && manifest.runAs === undefined
        ? { id: createServicePrincipalId(), name: manifest.id, displayLabel: manifest.name }
        : await workflowRunPrincipal(
            stores.apiAccess,
            clientInstanceId,
            manifest,
            stores.configAssets
          );
    if (!principal) {
      if (manifest.runAs === undefined)
        throw new AppError(
          "CONFLICT",
          "The Workflow's own account is missing or disabled. Publish it again.",
          { reason: "principal_inactive" }
        );
      const account = await stores.apiAccess.findServicePrincipalByName({
        clientInstanceId,
        name: manifest.runAs
      });
      throw new AppError(
        "CONFLICT",
        `This Workflow runs as the technical account '${account?.displayLabel ?? manifest.runAs}', which is missing or disabled. Choose an active account in the Workflow definition. An administrator manages accounts under Settings > API access.`,
        {
          reason: "principal_inactive",
          runAs: manifest.runAs,
          ...(account ? { principalDisplayLabel: account.displayLabel } : {})
        }
      );
    }
    return { published, trigger, input: runInput.data, principal };
  };
}
