import { z } from "zod";
import { PROJECT_FOLDER_WRITE_CHANGES, type JsonObject } from "@work-shape/catalyst-core";
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

/**
 * The most text one call of either tool may carry, in string units: `content`, or every
 * `oldText` and `newText` of a call together. It is checked when the input is validated, before
 * the input is hashed and before anything is built from it, so it bounds the memory one call
 * takes. It is four times the write limit, so that a call somewhat above a limit still reaches
 * the tool and is refused there with the limit and the next step.
 */
export const WORKSPACE_FILE_TOOL_INPUT_MAX_CHARS = 4 * WORKSPACE_WRITE_FILE_MAX_BYTES;
// For the same reason validation takes more edits than the tool applies.
const EDITS_INPUT_BOUND = 4 * WORKSPACE_EDIT_MAX_EDITS;

const pathDescription = "File path relative to /workspace.";
const contentDescription = "The whole text of the file.";
const oldTextDescription =
  "Exact text to replace, with the spaces, tabs and line breaks the file has.";
const newTextDescription = "The text that takes its place.";
const replacesVersionDescription =
  "For a file of the project folder (project/...): the version workspace.read_file answered, which this write replaces. 0 for a new file. Where the file changed since, the write is kept beside it as a conflict copy.";

const pathSchema = z.string().min(1).max(DEFAULT_LIMITS.maxPathLength);
const textSchema = z.string().max(WORKSPACE_FILE_TOOL_INPUT_MAX_CHARS);
const replacesVersionSchema = z.number().int().min(0).describe(replacesVersionDescription);

/** What a write in the project folder did (PRJ-2): the turn shows it with an Undo. */
export const projectFileToolChangeSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  version: z.number().int().positive(),
  change: z.enum(PROJECT_FOLDER_WRITE_CHANGES),
  previousVersion: z.number().int().positive().optional(),
  /** For a conflict copy: the file that changed in the meantime. */
  changed: z.object({ path: z.string(), version: z.number().int().positive() }).optional()
});

export const workspaceWriteFileInputSchema = z
  .object({
    path: pathSchema.describe(pathDescription),
    content: textSchema.describe(contentDescription),
    replacesVersion: replacesVersionSchema.optional()
  })
  .strict();

export const workspaceWriteFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** False when the call replaced a file. */
  created: z.boolean(),
  project: projectFileToolChangeSchema.optional()
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
      .max(EDITS_INPUT_BOUND),
    replacesVersion: replacesVersionSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    let chars = 0;
    for (const edit of input.edits) {
      chars += edit.oldText.length + edit.newText.length;
    }
    if (chars > WORKSPACE_FILE_TOOL_INPUT_MAX_CHARS) {
      context.addIssue({
        code: "custom",
        path: ["edits"],
        message: `The edits hold ${chars} characters of oldText and newText together, and one call takes at most ${WORKSPACE_FILE_TOOL_INPUT_MAX_CHARS} (WORKSPACE_FILE_TOOL_INPUT_MAX_CHARS). Send the edits in several calls, or change the file with a command in workspace.exec.`
      });
    }
  });

export const workspaceEditFileOutputSchema = z.object({
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  editsApplied: z.number().int().positive(),
  project: projectFileToolChangeSchema.optional()
});

const pathJsonSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: DEFAULT_LIMITS.maxPathLength,
  description: pathDescription
};

const replacesVersionJsonSchema: JsonObject = {
  type: "integer",
  minimum: 0,
  description: replacesVersionDescription
};

// Override required: validation is wider than the limits, and the model is shown the limits.
export const workspaceWriteFileInputJsonSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: pathJsonSchema,
    content: { type: "string", description: contentDescription },
    replacesVersion: replacesVersionJsonSchema
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
    },
    replacesVersion: replacesVersionJsonSchema
  }
};
