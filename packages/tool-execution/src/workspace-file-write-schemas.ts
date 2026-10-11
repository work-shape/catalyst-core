import { z } from "zod";
import type { JsonObject } from "@vivd-catalyst/core";
import { DEFAULT_LIMITS } from "./workspace-tool-schemas";

/**
 * The most bytes of text one `workspace.write_file` call stores. A call above it is refused
 * and told to write the file in a command or to split it. It bounds what one model answer puts
 * into the object store and into the conversation, which keeps the call's input. A fixed
 * constant: no deployment has asked for another value.
 */
export const WORKSPACE_WRITE_FILE_MAX_BYTES = 256 * 1024;

/**
 * The most edits one `workspace.edit_file` call takes. Every edit is searched in the file, so
 * this bounds the searches of one call. A call above it is refused and told to send the edits
 * in several calls. A fixed constant, for the same reason.
 */
export const WORKSPACE_EDIT_MAX_EDITS = 50;

// Validation accepts more than the two limits above, so that the tool itself can refuse with
// the limit and the next step. Input beyond these bounds is refused as invalid input.
const TEXT_INPUT_BOUND_CHARS = 16 * WORKSPACE_WRITE_FILE_MAX_BYTES;
const EDITS_INPUT_BOUND = 20 * WORKSPACE_EDIT_MAX_EDITS;

const pathDescription = "File path relative to /workspace.";
const contentDescription = "The whole text of the file.";
const oldTextDescription =
  "Exact text to replace, with the spaces, tabs and line breaks the file has.";
const newTextDescription = "The text that takes its place.";

const pathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
const textSchema = z.string().max(TEXT_INPUT_BOUND_CHARS);

export const workspaceWriteFileInputSchema = z
  .object({
    path: pathSchema.describe(pathDescription),
    content: textSchema.describe(contentDescription)
  })
  .strict();

export const workspaceWriteFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** False when the call replaced a file. */
  created: z.boolean()
});

export const workspaceEditFileInputSchema = z
  .object({
    path: pathSchema.describe(pathDescription),
    edits: z
      .array(
        z
          .object({
            oldText: textSchema.describe(oldTextDescription),
            newText: textSchema.describe(newTextDescription)
          })
          .strict()
      )
      .min(1)
      .max(EDITS_INPUT_BOUND)
  })
  .strict();

export const workspaceEditFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  editsApplied: z.number().int().positive()
});

const pathJsonSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: DEFAULT_LIMITS.maxPathLength,
  description: pathDescription
};

// Override required: validation is wider than the limits, and the model is shown the limits.
export const workspaceWriteFileInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: pathJsonSchema,
    content: { type: "string", description: contentDescription }
  }
};

export const workspaceEditFileInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path", "edits"],
  properties: {
    path: pathJsonSchema,
    edits: {
      type: "array",
      minItems: 1,
      maxItems: WORKSPACE_EDIT_MAX_EDITS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["oldText", "newText"],
        properties: {
          oldText: { type: "string", minLength: 1, description: oldTextDescription },
          newText: { type: "string", description: newTextDescription }
        }
      }
    }
  }
};
