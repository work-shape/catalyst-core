import { formatMoment } from "../../shared/locale-format";
import { placedSteps, type CanvasText } from "./workflow-canvas-model";
import { failureHappened } from "./workflow-model";
import type { WorkflowRunView, WorkflowStepRunView, WorkflowStepView } from "./workflow-views";

/**
 * What "Fix with the agent" puts into the composer of the conversation about the Workflow:
 * which run failed, at which step, and why, in the sentence the run's page says. A step that
 * failed says why itself; without one the run says it. A step the drawn steps do not hold, as
 * in an earlier revision, goes unnamed, never by its id.
 */
export function fixWithAgentPrompt(
  run: Pick<WorkflowRunView, "createdAt" | "failure">,
  stepRuns: readonly WorkflowStepRunView[],
  steps: readonly WorkflowStepView[] | undefined,
  { t, locale }: CanvasText
): string {
  const failedStep = stepRuns.find((stepRun) => stepRun.failure !== undefined);
  const failure = failedStep?.failure ?? run.failure ?? { reason: "other" };
  const step =
    failedStep === undefined || steps === undefined
      ? undefined
      : placedSteps(steps).get(failedStep.stepId)?.step.name;
  const values = {
    date: formatMoment(run.createdAt, locale),
    reason: failureHappened(failure, t)
  };
  return step === undefined
    ? t("workflows.fix.prompt", values)
    : t("workflows.fix.promptAtStep", { ...values, step });
}
