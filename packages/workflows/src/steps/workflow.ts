import { workflowLiteralOrReferenceSchema } from "@work-shape/catalyst-core";
import { z } from "zod";
import { inputMappingSchema, named, type StepModule } from "./module";

export const workflowStep = {
  schema: () =>
    z.strictObject({
      ...named,
      type: z.literal("workflow"),
      workflow: z.string().min(1),
      input: inputMappingSchema,
      key: z.array(workflowLiteralOrReferenceSchema).optional()
    })
} satisfies StepModule<"workflow">;
