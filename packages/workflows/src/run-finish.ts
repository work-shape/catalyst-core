import { indexWorkflowSteps, type WorkflowStepIndex } from "./definition";
import { principalActor } from "./run-identity";
import type { PlatformStores, WorkflowRun, WorkflowStepRun } from "@work-shape/catalyst-core";
import type { createRunEnd } from "./run-end";

/** Audit an engine end, or drain a loop toward a safe deadline checkpoint. */
export function createRunFinisher(options: {
  clientInstanceId: WorkflowRun["clientInstanceId"];
  endRun: ReturnType<typeof createRunEnd>;
  fillLoop(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    step: WorkflowStepRun
  ): Promise<void>;
}) {
  const { clientInstanceId, endRun, fillLoop } = options;
  return async function finishRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: Parameters<typeof endRun>[2]
  ): Promise<void> {
    if (end.status === "limit_reached" && end.error?.code === "duration_limit") {
      const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
      const index = indexWorkflowSteps(definition ?? { steps: [] });
      for (const open of await tx.workflowRuns.listOpenStepRuns({ clientInstanceId, id: run.id })) {
        const step = index.get(open.stepId)?.step;
        if (step?.type === "loop" && step.continueAsNew) {
          await fillLoop(tx, run, index, open);
          return;
        }
      }
    }
    const audit = { actor: principalActor(run), correlationId: run.correlationId };
    if (!(await endRun(tx, run, end, audit))) return;
    await tx.audit.appendAuditEvent({
      clientInstanceId,
      type: "workflow_run.ended",
      status: end.status === "done" || end.status === "continued" ? "success" : "failed",
      ...audit,
      subject: run.id,
      metadata: {
        workflow: run.workflow,
        definitionRevisionId: run.definitionRevisionId,
        status: end.status,
        stepRunCount: run.stepRunCount,
        ...(end.error ? { errorCode: end.error.code } : {})
      }
    });
  };
}
