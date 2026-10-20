import { workflowLoopOptionsSchema } from "@work-shape/catalyst-core";
import { z } from "zod";
import { named, notSupported, referenceSchema, type StepModule, type StepOf } from "./module";

export const loopStep = {
  schema: (step) =>
    z.strictObject({
      ...named,
      type: z.literal("loop"),
      items: referenceSchema,
      itemName: z.string().min(1).optional(),
      itemLabel: z.string().min(1).optional(),
      ...workflowLoopOptionsSchema.shape,
      steps: z.array(step).min(1)
    }),
  // Collection is the paging slice, separate from the loop's failures dataset.
  unsupported: (step: StepOf<"loop">, at: string) =>
    step.collect !== undefined ? [notSupported(`${at}.collect`, "'collect' (EW-13)")] : []
} satisfies StepModule<"loop">;
