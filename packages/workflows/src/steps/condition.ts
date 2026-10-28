import { WORKFLOW_CONDITION_OPERATORS } from "@work-shape/catalyst-core";
import { z } from "zod";
import { jsonValueSchema } from "../json";
import { named, referenceSchema, type StepModule } from "./module";

export const conditionStep = {
  schema: (step) =>
    z.strictObject({
      ...named,
      type: z.literal("condition"),
      when: z.strictObject({
        ref: referenceSchema,
        op: z.enum(WORKFLOW_CONDITION_OPERATORS),
        value: jsonValueSchema
      }),
      then: z.array(step),
      else: z.array(step).optional()
    })
} satisfies StepModule<"condition">;
