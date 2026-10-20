import { z } from "zod";
import { agentOutputSchemaSupported } from "../agent-schema";
import { namesDatasetType } from "../json";
import {
  declared,
  inputMappingSchema,
  named,
  notSupported,
  type StepModule,
  type StepOf
} from "./module";

export const agentStep = {
  schema: () =>
    z.strictObject({
      ...named,
      ...declared,
      type: z.literal("agent"),
      instructions: z.string().min(1),
      input: inputMappingSchema
    }),
  unsupported: (step: StepOf<"agent">, at: string) =>
    namesDatasetType(step.inputSchema)
      ? [notSupported(`${at}.inputSchema`, "a dataset in an agent input (EW-14)")]
      : [],
  structural: (step: StepOf<"agent">, id: string) =>
    agentOutputSchemaSupported(step.outputSchema)
      ? []
      : [
          {
            path: `steps.${id}.outputSchema`,
            message:
              "An agent output schema supports named objects, arrays, strings, numbers, booleans, enums and required fields, without references or recursion"
          }
        ]
} satisfies StepModule<"agent">;
