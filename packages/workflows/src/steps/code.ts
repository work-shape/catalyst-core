import { z } from "zod";
import { codeEntry, codeFileIssue } from "../code-step";
import { declared, inputMappingSchema, named, type StepModule, type StepOf } from "./module";

export const codeStep = {
  schema: () =>
    z.strictObject({
      ...named,
      ...declared,
      type: z.literal("code"),
      entry: z.string().min(1).optional(),
      file: z.string().min(1).optional(),
      input: inputMappingSchema
    }),
  structural: (step: StepOf<"code">, id: string) => {
    let issue =
      (step.entry === undefined) === (step.file === undefined)
        ? "A code step names exactly one entry (or the deprecated file alias)"
        : codeFileIssue(codeEntry(step));
    if (
      !issue &&
      step.file !== undefined &&
      (step.file.length > 200 ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u.test(step.file))
    ) {
      issue =
        "The deprecated file alias names a script under steps/ using letters, digits, underscores, hyphens and dots";
    }
    return issue
      ? [{ path: `steps.${id}.${step.entry === undefined ? "file" : "entry"}`, message: issue }]
      : [];
  }
} satisfies StepModule<"code">;
