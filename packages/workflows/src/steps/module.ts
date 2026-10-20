import {
  WORKFLOW_ERROR_CODES,
  workflowInputValueSchema,
  type WorkflowStep,
  type WorkflowStepType
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { WorkflowDefinitionIssue } from "../definition-issue";
import { jsonObjectSchema } from "../json";

// What one step type brings to a definition: its file form, what of it this engine reads and
// does not run, and what must hold of one step of it. A step type is one file in this folder
// and its entries in `index.ts`; what the authoring skill says of it is `<type>.reference.ts`,
// entered in `reference.ts`.

/** Every step type the file form holds, the reserved blocks among them. */
export type WorkflowFileStepType = WorkflowStep["type"];

/** The step of one type: `StepOf<"loop">` is a loop step. */
export type StepOf<Type extends WorkflowFileStepType> = {
  [Step in WorkflowStep as Step["type"]]: Step;
}[Type];

export interface StepModule<Type extends WorkflowFileStepType> {
  /** The file form of the step. `step` is the schema of any step, for the steps it holds. */
  schema: (step: z.ZodType<WorkflowStep>) => z.ZodType<StepOf<Type>>;
  /** What the step holds that this engine reads and does not run. `at` is its path. */
  unsupported?: (step: StepOf<Type>, at: string) => WorkflowDefinitionIssue[];
  /** What must hold of the step itself before a run is started. `id` is its id. */
  structural?: (step: StepOf<Type>, id: string) => WorkflowDefinitionIssue[];
}

/** What the authoring skill says of a step type: one sentence on what it does, one per field. */
export interface StepReference<Type extends WorkflowStepType> {
  does: string;
  fields: Record<Exclude<keyof StepOf<Type>, "type" | "id" | "name" | "description">, string>;
}

/** The id of a step: part of a step run's key, which separates with `.` and `[`. */
const STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/u;

export const referenceSchema = z.strictObject({ step: z.string().min(1), path: z.string() });
export const inputMappingSchema = z.record(z.string().min(1), workflowInputValueSchema);
export const stepId = z
  .string()
  .regex(STEP_ID, "A step id is lowercase letters, digits, '_' and '-'");

/** What every step carries: its id, and what a person calls it and reads about it. */
export const named = { id: stepId, name: z.string().min(1), description: z.string().optional() };
export const declared = { inputSchema: jsonObjectSchema, outputSchema: jsonObjectSchema };

export const notSupported = (path: string, what: string): WorkflowDefinitionIssue => ({
  path,
  code: WORKFLOW_ERROR_CODES.notSupported,
  message: `This engine does not run ${what} yet (${WORKFLOW_ERROR_CODES.notSupported})`
});
