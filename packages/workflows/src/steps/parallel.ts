import { z } from "zod";
import { named, stepId, type StepModule, type StepOf } from "./module";

export const parallelStep = {
  schema: (step) =>
    z.strictObject({
      ...named,
      type: z.literal("parallel"),
      branches: z.array(
        z.strictObject({ id: stepId, name: z.string().min(1), steps: z.array(step) })
      ),
      concurrency: z.number().int().min(1).optional()
    }),
  structural: (step: StepOf<"parallel">, id: string) => {
    const seen = new Set<string>();
    return step.branches.flatMap((branch) => {
      if (seen.has(branch.id))
        return [
          {
            path: `steps.${id}.branches`,
            message: `Branch id '${branch.id}' is used more than once`
          }
        ];
      seen.add(branch.id);
      return [];
    });
  }
} satisfies StepModule<"parallel">;
