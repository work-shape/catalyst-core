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
    current = current.sequence.container ? index.get(current.sequence.container) : undefined;
  }
  return total;
}

/**
 * Histories replay their prefix until EW-CAN-RESUME carries a resume position and outputs.
 * Refuse replayed changes, dynamic loop tails and concurrent ancestors before publish or a draft test run.
 */
export async function workflowContinuationIssues(
  manifest: WorkflowManifest,
  registry?: Pick<OperationRegistry, "resolve">
): Promise<WorkflowDefinitionIssue[]> {
  const index = indexWorkflowSteps(manifest);
  const issues: WorkflowDefinitionIssue[] = [];
  const changing = async (step: WorkflowStep): Promise<boolean> => {
    // Agent steps are currently refused by the runtime. Count them as changing here
    // as soon as they can run: their tools may write or send during prefix replay.
    if (step.type === "workflow" || step.type === "notify") return true;
    if (step.type === "operation")
      return (await registry?.resolve(step.operation))?.effect !== "reading";
    const lists =
      step.type === "loop"
        ? [step.steps]
        : step.type === "condition"
          ? [step.then, step.else ?? []]
          : step.type === "parallel"
            ? step.branches.map((branch) => branch.steps)
            : [];
    for (const children of lists)
      for (const child of children) if (await changing(child)) return true;
    return false;
  };
  for (const [id, entry] of index) {
    if (entry.step.type !== "loop" || !entry.step.continueAsNew) continue;
    let current: typeof entry | undefined = entry;
    while (current) {
      if (current !== entry && current.step.type === "loop" && (current.step.concurrency ?? 1) > 1)
        issues.push({
          path: `steps.${current.step.id}.concurrency`,
          message: `Loop '${current.step.id}' cannot use concurrency above 1 while enclosing continueAsNew loop '${id}': a continuation checkpoint cannot record unfinished sibling items. / Schleife '${current.step.id}' darf keine concurrency über 1 verwenden, wenn sie die continueAsNew-Schleife '${id}' umschließt: Ein Fortsetzungspunkt kann den Fortschritt noch laufender Geschwisterelemente nicht speichern.`
        });
      for (const step of current.sequence.steps.slice(0, current.position)) {
        if (!current.sequence.container && (await changing(step)))
          issues.push({
            path: `steps.${step.id}`,
            message: `Step '${step.id}' cannot precede continueAsNew loop '${id}' at its level or an enclosing level: writes, sends, notifications, child Workflow starts and loops containing them would run again in every history. / Schritt '${step.id}' darf nicht vor der continueAsNew-Schleife '${id}' auf derselben oder einer umschließenden Ebene stehen: Schreibzugriffe, Versand, Benachrichtigungen, Starts von Kind-Workflows und Schleifen mit diesen Schritten würden in jedem Fortsetzungslauf erneut ausgeführt.`
          });
      }
      for (const step of current.sequence.steps.slice(current.position + 1)) {
        if (step.type === "loop" || step.type === "parallel" || step.type === "condition")
          issues.push({
            path: `steps.${step.id}`,
            message: `${step.type === "loop" ? "Loop" : "Block"} '${step.id}' cannot follow continueAsNew loop '${id}' at its level or an enclosing level: dynamic loop items cannot be reserved in the history budget. / Schleife '${step.id}' darf nicht nach der continueAsNew-Schleife '${id}' auf derselben oder einer umschließenden Ebene stehen: Dynamische Schleifenelemente können nicht im Schrittbudget des Fortsetzungslaufs reserviert werden.`
          });
      }
      current = current.sequence.container ? index.get(current.sequence.container) : undefined;
    }
  }
  return issues;
}
