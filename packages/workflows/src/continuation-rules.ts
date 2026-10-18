import type { OperationRegistry, WorkflowManifest, WorkflowStep } from "@work-shape/catalyst-core";
import {
  indexWorkflowSteps,
  workflowLoopTailSteps,
  type WorkflowDefinitionIssue,
  type WorkflowStepIndex
} from "./definition";

/** Minimum slots for the prefix, loop containers, one item and the enclosing tails. */
export function workflowLoopMinimumSteps(index: WorkflowStepIndex, loopId: string): number {
  let current = index.get(loopId);
  let total = workflowLoopTailSteps(index, loopId);
  // Nested and earlier loops may be empty: count their containers, never invent items.
  // Runtime admission reserves the dynamic work once the referenced collections exist.
  if (current?.step.type === "loop") total += current.step.steps.length;
  while (current) {
    total += current.position + 1;
    current = current.sequence.loop ? index.get(current.sequence.loop) : undefined;
  }
  return total;
}

/**
 * Histories replay their prefix until EW-CAN-RESUME carries a resume position and outputs.
 * Refuse replayed changes and dynamic loop tails before publish or a draft test run.
 */
export async function workflowContinuationIssues(
  manifest: WorkflowManifest,
  registry?: Pick<OperationRegistry, "resolve">
): Promise<WorkflowDefinitionIssue[]> {
  const index = indexWorkflowSteps(manifest);
  const issues: WorkflowDefinitionIssue[] = [];
  const changing = async (step: WorkflowStep): Promise<boolean> => {
    if (step.type === "workflow" || step.type === "notify") return true;
    if (step.type === "operation")
      return (await registry?.resolve(step.operation))?.effect !== "reading";
    if (step.type === "loop") {
      for (const child of step.steps) if (await changing(child)) return true;
    }
    return false;
  };
  for (const [id, entry] of index) {
    if (entry.step.type !== "loop" || !entry.step.continueAsNew) continue;
    let current: typeof entry | undefined = entry;
    while (current) {
      for (const step of current.sequence.steps.slice(0, current.position)) {
        if (await changing(step))
          issues.push({
            path: `steps.${step.id}`,
            message: `Step '${step.id}' cannot precede continueAsNew loop '${id}' at its level or an enclosing level: writes, sends, notifications, child Workflow starts and loops containing them would run again in every history. / Schritt '${step.id}' darf nicht vor der continueAsNew-Schleife '${id}' auf derselben oder einer umschließenden Ebene stehen: Schreibzugriffe, Versand, Benachrichtigungen, Starts von Kind-Workflows und Schleifen mit diesen Schritten würden in jedem Fortsetzungslauf erneut ausgeführt.`
          });
      }
      for (const step of current.sequence.steps.slice(current.position + 1)) {
        if (step.type === "loop")
          issues.push({
            path: `steps.${step.id}`,
            message: `Loop '${step.id}' cannot follow continueAsNew loop '${id}' at its level or an enclosing level: dynamic loop items cannot be reserved in the history budget. / Schleife '${step.id}' darf nicht nach der continueAsNew-Schleife '${id}' auf derselben oder einer umschließenden Ebene stehen: Dynamische Schleifenelemente können nicht im Schrittbudget des Fortsetzungslaufs reserviert werden.`
          });
      }
      current = current.sequence.loop ? index.get(current.sequence.loop) : undefined;
    }
  }
  return issues;
}
