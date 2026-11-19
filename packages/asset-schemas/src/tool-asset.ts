import { z } from "zod";
import { localizedStringSchema } from "./schemas";

// A tool an instance adds without a release (TOOL-1, platform-access.md, section 3a): an asset
// of kind `tool`. It holds no code. Its one type, `result`, checks the agent's input against a
// declared JSON Schema and writes it as the conversation's structured result of one display
// kind. Its operation is `tool.<name>.call`.

/** The kind's id, as the asset store keeps it. */
export const TOOL_ASSET_KIND = "tool";

/** The prefix of every operation of one tool asset: `tool.<name>.call`. */
export const TOOL_OPERATION_PREFIX = "tool.";

/** The name of a tool: lowercase letters, digits and `_`, starting with a letter. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
export const TOOL_NAME_MAX_LENGTH = 48;
export const TOOL_NAME_RULE =
  "A tool's name is lowercase letters, digits and _, starts with a letter and is at most 48 characters long";

/** A display kind: lowercase words joined by `.`, `_` or `-`, such as `review.document_check`. */
export const TOOL_RESULT_KIND_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/u;

/** How long the agent's description of a tool is at most. */
export const TOOL_DESCRIPTION_MAX_CHARS = 4_000;

/** How large a tool's input schema is at most, as JSON, in bytes. */
export const TOOL_INPUT_SCHEMA_MAX_BYTES = 32 * 1024;

/** How deeply a tool's input schema nests at most, counting objects and arrays. */
export const TOOL_INPUT_SCHEMA_MAX_DEPTH = 24;

/** What a call of a `result` tool answers the agent where the tool names no sentence. */
export const TOOL_RESULT_DEFAULT_REPLY = "Done.";

/** The types of tool. `result` hands the agent's finished result to the panel. */
export const TOOL_TYPES = ["result"] as const;

export const toolNameSchema = z
  .string()
  .max(TOOL_NAME_MAX_LENGTH, TOOL_NAME_RULE)
  .regex(TOOL_NAME_PATTERN, TOOL_NAME_RULE);

function depthOf(value: unknown): number {
  let deepest = 0;
  const open: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  for (let next = open.pop(); next; next = open.pop()) {
    if (typeof next.value !== "object" || next.value === null) continue;
    const depth = next.depth + 1;
    if (depth > deepest) deepest = depth;
    if (depth > TOOL_INPUT_SCHEMA_MAX_DEPTH) return depth;
    for (const item of Object.values(next.value)) open.push({ value: item, depth });
  }
  return deepest;
}

/**
 * A tool's input schema: a JSON Schema of an object, bounded in size and depth. Whether it
 * compiles is asked where the kind is checked, in the platform's schema checker.
 */
export const toolInputSchemaSchema = z
  .record(z.string(), z.unknown())
  .superRefine((schema, context) => {
    if (schema.type !== "object") {
      context.addIssue({
        code: "custom",
        message: 'The input schema must describe an object: give it `type: "object"`'
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
    if (bytes > TOOL_INPUT_SCHEMA_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `The input schema is ${bytes} bytes as JSON; it may be at most ${TOOL_INPUT_SCHEMA_MAX_BYTES}`
      });
    }
    if (depthOf(schema) > TOOL_INPUT_SCHEMA_MAX_DEPTH) {
      context.addIssue({
        code: "custom",
        message: `The input schema nests deeper than ${TOOL_INPUT_SCHEMA_MAX_DEPTH} levels`
      });
    }
  });

export const toolResultSchema = z
  .object({
    /** The display kind the panel draws the result with. */
    kind: z
      .string()
      .max(120)
      .regex(
        TOOL_RESULT_KIND_PATTERN,
        "A result kind is lowercase words joined by '.', '_' or '-', such as review.document_check"
      ),
    /** The resource a new call replaces in its conversation. The tool's name where left out. */
    key: z
      .string()
      .max(80)
      .regex(/^[a-z][a-z0-9_-]*$/u, "A result key is lowercase letters, digits, _ and -")
      .optional(),
    /** The panel's heading. */
    title: z.string().trim().min(1).max(120),
    schemaVersion: z.number().int().min(1).max(1_000).optional(),
    /** The sentence the agent is answered with. */
    reply: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export const toolAssetConfigSchema = z
  .object({
    name: toolNameSchema,
    type: z.enum(TOOL_TYPES),
    /** What people read: the agent page and Studio. */
    title: localizedStringSchema,
    summary: localizedStringSchema.optional(),
    /** What the agent reads: when to call it and what it hands over. */
    description: z.string().trim().min(1).max(TOOL_DESCRIPTION_MAX_CHARS),
    icon: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/u)
      .max(40)
      .optional(),
    input: toolInputSchemaSchema,
    result: toolResultSchema
  })
  .strict();

export type ToolAssetConfig = z.infer<typeof toolAssetConfigSchema>;

/** The operation a published tool contributes. */
export function toolCallOperationName(tool: string): string {
  return `${TOOL_OPERATION_PREFIX}${tool}.call`;
}

/** The tool a name `tool.<name>.call` names, or nothing for any other name. */
export function toolOfOperationName(name: string): string | undefined {
  if (!name.startsWith(TOOL_OPERATION_PREFIX) || !name.endsWith(".call")) return undefined;
  const tool = name.slice(TOOL_OPERATION_PREFIX.length, -".call".length);
  return tool.length <= TOOL_NAME_MAX_LENGTH && TOOL_NAME_PATTERN.test(tool) ? tool : undefined;
}
