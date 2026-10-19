import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  unknownToJsonValue,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import type { JsonValue, WorkflowRunError } from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";

/** A terminal Child Agent Run answers its step; an open one leaves the step waiting. */
export async function agentStepOutcome(
  stores: PlatformStores,
  run: WorkflowRun,
  step: WorkflowStepRun
): Promise<
  | { kind: "done"; output: JsonValue }
  | { kind: "failed"; systemic: boolean; error: WorkflowRunError }
  | undefined
> {
  const child = await stores.childAgentRuns.readWorkflowAgentRun({
    clientInstanceId: run.clientInstanceId,
    stepRunId: step.id
  });
  if (!child || !["completed", "failed", "cancelled"].includes(child.status)) return undefined;
  if (child.status !== "completed")
    return {
      kind: "failed",
      systemic: false,
      error: {
        code: child.error?.code ?? "agent_cancelled",
        message:
          child.error?.code === "confirmation_unattended"
            ? "The agent step asked for confirmation while unattended"
            : child.error?.code === "output_invalid"
              ? child.error.message
              : "The agent step failed"
      }
    };
  const definition = await stores.workflowRuns.readRunDefinition({
    clientInstanceId: run.clientInstanceId,
    id: run.id
  });
  const declared = definition && indexWorkflowSteps(definition).get(step.stepId)?.step;
  const messages = await stores.conversations.listMessages({
    clientInstanceId: run.clientInstanceId,
    conversationId: child.conversationId
  });
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  try {
    const value: unknown = JSON.parse(last?.text ?? "");
    const schema =
      declared?.type === "agent" ? compileJsonSchema(declared.outputSchema) : undefined;
    if (!schema?.ok || schema.validate(value).length) throw new Error("invalid");
    return { kind: "done", output: unknownToJsonValue(value) };
  } catch {
    return {
      kind: "failed",
      systemic: false,
      error: { code: "output_invalid", message: "Agent output does not fit its output schema" }
    };
  }
}

/** The child and its waiting step commit together under the Workflow run's lock. */
export async function startAgentStep(
  tx: PlatformStores,
  run: WorkflowRun,
  stepRun: WorkflowStepRun,
  end: {
    input: import("@work-shape/catalyst-core").JsonObject;
    principal: import("@work-shape/catalyst-core").WorkflowRunPrincipal;
  },
  title: string,
  retainedUntil: string
): Promise<void> {
  await tx.childAgentRuns.startWorkflowAgentRun({
    clientInstanceId: run.clientInstanceId,
    runId: run.id,
    stepRunId: stepRun.id,
    principal: end.principal,
    task: JSON.stringify(end.input),
    title,
    correlationId: run.correlationId,
    retainedUntil
  });
  await tx.workflowRuns.markChildWaiting({
    clientInstanceId: run.clientInstanceId,
    id: stepRun.id
  });
}
