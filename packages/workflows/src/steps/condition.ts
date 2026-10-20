import { z } from "zod";
import { jsonValueSchema } from "../json";
import { named, referenceSchema, type StepModule } from "./module";

// Reserved: read so that a file written for a later engine is refused by name
// (`workflowBlockIssues`); what it holds is not read further.
export const conditionStep = {
  schema: (step) =>
    z.strictObject({
      ...named,
      type: z.literal("condition"),
      when: z.strictObject({ ref: referenceSchema, op: z.string().min(1), value: jsonValueSchema }),
      then: z.array(step),
      else: z.array(step).optional()
    })
} satisfies StepModule<"condition">;
