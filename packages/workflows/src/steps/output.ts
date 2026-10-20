import { z } from "zod";
import { inputMappingSchema, named, type StepModule } from "./module";

export const outputStep = {
  schema: () => z.strictObject({ ...named, type: z.literal("output"), input: inputMappingSchema })
} satisfies StepModule<"output">;
