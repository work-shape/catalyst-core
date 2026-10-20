import { z } from "zod";
import { codeFileIssue } from "../code-step";
import { declared, inputMappingSchema, named, type StepModule, type StepOf } from "./module";

export const codeStep = {
  schema: () =>
    z.strictObject({
      ...named,
      ...declared,
      type: z.literal("code"),
      file: z.string().min(1),
      input: inputMappingSchema
    }),
  structural: (step: StepOf<"code">, id: string) => {
    const file = codeFileIssue(step.file);
    return file ? [{ path: `steps.${id}.file`, message: file }] : [];
  }
} satisfies StepModule<"code">;
