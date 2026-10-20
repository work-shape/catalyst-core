import { z } from "zod";
import { named, stepId, type StepModule } from "./module";

// Reserved like `condition`.
export const parallelStep = {
  schema: (step) =>
    z.strictObject({
      ...named,
      type: z.literal("parallel"),
      branches: z.array(
        z.strictObject({ id: stepId, name: z.string().min(1), steps: z.array(step) })
      ),
      concurrency: z.number().int().min(1).optional()
    })
} satisfies StepModule<"parallel">;
