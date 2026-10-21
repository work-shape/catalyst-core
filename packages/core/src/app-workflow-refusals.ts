import { AppError, type AppErrorCode } from "./errors";

/**
 * Why an App cannot start a Workflow its `workflow` action names, as `details.reason` of the
 * error and as the reason the run of a failed call keeps. Each has the error code it is
 * answered with. Spec: apps-and-pages.md, Named actions; the drafts-together design, DP-0.
 */
const APP_WORKFLOW_REFUSALS = {
  /** No published Workflow of the name stands where the App may reach it. */
  workflow_unavailable: "NOT_FOUND",
  /** The action's mapping does not fit the inputs the Workflow's published revision declares. */
  workflow_input_invalid: "VALIDATION_FAILED"
} as const satisfies Record<string, AppErrorCode>;

export type AppWorkflowRefusal = keyof typeof APP_WORKFLOW_REFUSALS;

/** What a refusal names beside the Workflow: the action, the input and what is wrong with it. */
interface AppWorkflowRefusalFacts {
  action?: string;
  input?: string;
  /** The mapping leaves a required input out, or fills one the Workflow does not declare. */
  fault?: "missing" | "undeclared";
}

const APP_WORKFLOW_REFUSAL_SENTENCES: Record<
  AppWorkflowRefusal,
  (workflow: string, about: AppWorkflowRefusalFacts) => string
> = {
  workflow_unavailable: (workflow) =>
    `The Workflow '${workflow}' is not available: it is not published, or not where the App reaches it (its own workspace or the instance). Publish the Workflow first.`,
  workflow_input_invalid: (workflow, { action, input, fault }) =>
    fault === "missing"
      ? `The action '${action}' leaves out '${input}', which the published Workflow '${workflow}' requires. Map it in the action's input.mapping.`
      : `The action '${action}' maps '${input}', which the published Workflow '${workflow}' does not declare as an input.`
};

/**
 * The error of an App that cannot start a Workflow. It carries the reason, the Workflow's name
 * and, where the refusal is about them, the action and the input. Nothing of a value.
 */
export function appWorkflowRefusalError(
  reason: AppWorkflowRefusal,
  workflow: string,
  about: AppWorkflowRefusalFacts = {}
): AppError {
  return new AppError(
    APP_WORKFLOW_REFUSALS[reason],
    APP_WORKFLOW_REFUSAL_SENTENCES[reason](workflow, about),
    { reason, workflow, ...about },
    { exposeMessage: true }
  );
}
