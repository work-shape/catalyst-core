import { z } from "zod";
import {
  AppError,
  isAppError,
  SUBJECT_TOOL_PREFIX,
  type JsonObject,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

// The tools an agent reads and saves the draft of an asset with. Each is a projection of an
// operation of the API under the name the agent calls it by: the same implementation carries
// both, with the rights, the checks and the audit of the person the agent acts for. A tool
// names no asset. The server binds it to the subject of the conversation it is called in, so
// whatever a model sends, it reaches that asset and no other. A further tool is one more row
// of `PLATFORM_ASSET_TOOLS` and one more method of the port.

/** One row per tool: its name for the agent, and the operation of the API it projects. */
export const PLATFORM_ASSET_TOOLS = {
  get: { name: `${SUBJECT_TOOL_PREFIX}get`, operation: "assets.get", effect: "reading" },
  validate: {
    name: `${SUBJECT_TOOL_PREFIX}validate`,
    operation: "assets.validate",
    effect: "reading"
  },
  put: { name: `${SUBJECT_TOOL_PREFIX}put`, operation: "assets.put", effect: "changing" },
  operations: {
    name: `${SUBJECT_TOOL_PREFIX}operations`,
    operation: "operations.list_callable",
    effect: "reading"
  }
} as const;

/** The names of the tools the server binds to the subject of a conversation. */
export const PLATFORM_ASSET_TOOL_NAMES: readonly string[] = Object.values(PLATFORM_ASSET_TOOLS).map(
  (tool) => tool.name
);

/** One thing a save of a definition is refused for. `path` is dotted, empty for the whole. */
interface PlatformAssetIssue {
  path: string;
  message: string;
  code?: string;
}

/** The asset of a conversation as its agent reads it. */
interface PlatformAssetRead {
  kind: string;
  name: string;
  config: JsonObject;
  /** The revision `config` is. A save names it as `expectedRevision`. */
  revision: number;
  /** The revision that runs. Missing while nothing is published. */
  publishedRevision?: number;
  /** Which of the two `config` is: the draft, or the published revision where no draft differs. */
  shows: "draft" | "published";
}

type PlatformAssetWrite =
  | { saved: true; revision: number; publishedRevision?: number }
  | { saved: false; issues: PlatformAssetIssue[] }
  | { saved: false; conflict: "REVISION_CONFLICT"; message: string };

/** One operation a step may call, as far as the person the agent acts for may see it. */
export interface PlatformCallableOperation {
  name: string;
  effect: "reading" | "changing";
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}

/**
 * What carries the tools out: the asset operations of the instance, on the subject of the
 * conversation the call came from. Every method asks the right of the person of `context`
 * as the operation of the API does, and throws its refusal. A conversation without a subject
 * is refused by each.
 */
export interface PlatformAssetCalls {
  get(context: ToolExecutionContext): Promise<PlatformAssetRead>;
  validate(
    context: ToolExecutionContext,
    config: Record<string, unknown>
  ): Promise<{ issues: PlatformAssetIssue[] }>;
  put(
    context: ToolExecutionContext,
    input: { config: Record<string, unknown>; expectedRevision: number }
  ): Promise<PlatformAssetWrite>;
  listOperations(
    context: ToolExecutionContext
  ): Promise<{ operations: PlatformCallableOperation[]; truncated: boolean }>;
}

/**
 * The port as the tools hold it. The tools are built before the process has the workflow of
 * its assets, which is bound once it exists. A process that never binds one, such as a worker
 * without the API's asset operations, answers each call as not available there.
 */
export interface PlatformAssetBinding {
  bind(calls: PlatformAssetCalls): void;
  readonly calls: PlatformAssetCalls;
}

export function createPlatformAssetBinding(): PlatformAssetBinding {
  let bound: PlatformAssetCalls | undefined;
  const required = (): PlatformAssetCalls => {
    if (!bound) {
      throw new AppError(
        "CONFLICT",
        "The asset of this conversation cannot be read or saved from this process",
        { reason: "asset_tools_unbound" },
        { exposeMessage: true }
      );
    }
    return bound;
  };
  return {
    bind(calls) {
      bound = calls;
    },
    calls: {
      get: (context) => required().get(context),
      validate: (context, config) => required().validate(context, config),
      put: (context, input) => required().put(context, input),
      listOperations: (context) => required().listOperations(context)
    }
  };
}

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional()
});
const configSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "The whole definition as the read answered it under 'config', with your changes: for a Workflow { name, manifest }, where 'manifest' is workflow.yaml as an object."
  );
const jsonObjectSchema = z.record(z.string(), z.unknown());

const readOutputSchema = z.object({
  kind: z.string(),
  name: z.string(),
  config: jsonObjectSchema,
  revision: z.number().int(),
  publishedRevision: z.number().int().optional(),
  shows: z.enum(["draft", "published"])
});
const validateOutputSchema = z.object({ valid: z.boolean(), issues: z.array(issueSchema) });
const putOutputSchema = z.union([
  z.object({
    saved: z.literal(true),
    revision: z.number().int(),
    publishedRevision: z.number().int().optional()
  }),
  z.object({ saved: z.literal(false), issues: z.array(issueSchema) }),
  z.object({
    saved: z.literal(false),
    conflict: z.literal("REVISION_CONFLICT"),
    message: z.string()
  })
]);
const operationsOutputSchema = z.object({
  operations: z.array(
    z.object({
      name: z.string(),
      effect: z.enum(["reading", "changing"]),
      inputSchema: jsonObjectSchema.optional(),
      outputSchema: jsonObjectSchema.optional()
    })
  ),
  truncated: z.boolean()
});

const BOUND =
  "It works on the asset this conversation is about and takes no name of one: the server decides which asset that is.";

/**
 * The tools of the subject of a conversation. They are offered to an agent only in a
 * conversation that has a subject, whatever the agent's definition lists.
 */
export function createPlatformAssetTools(calls: PlatformAssetCalls): AnyToolDefinition[] {
  const { get, validate, put, operations } = PLATFORM_ASSET_TOOLS;
  return [
    defineTool({
      name: get.name,
      effect: get.effect,
      description: [
        "Read the definition of the asset this conversation is about: its config and the revision it is at.",
        "Answers the draft where one differs from the published revision, and says which of the two it shows. 'publishedRevision' is the revision that runs; it is missing while nothing is published.",
        "Read before you change anything, and send the 'revision' you read as 'expectedRevision' when you save.",
        BOUND
      ].join(" "),
      inputSchema: z.object({}),
      outputSchema: readOutputSchema,
      async execute(_input, context) {
        const read = await calls.get(context);
        return toolSuccess(read, {
          auditSummary: {
            action: get.name,
            subject: read.name,
            metadata: { kind: read.kind, revision: read.revision, shows: read.shows }
          }
        });
      }
    }),
    defineTool({
      name: validate.name,
      effect: validate.effect,
      description: [
        "Check a definition without saving it. Answers what a save of it would be refused for: each issue with the path of the value, a sentence and, where the check names one, a code.",
        "The checks are the ones a save runs. An empty list means a save of this config passes them.",
        BOUND
      ].join(" "),
      inputSchema: z.object({ config: configSchema }),
      outputSchema: validateOutputSchema,
      async execute(input, context) {
        const { issues } = await calls.validate(context, input.config);
        return toolSuccess(
          { valid: issues.length === 0, issues },
          { auditSummary: { action: validate.name, metadata: { issueCount: issues.length } } }
        );
      }
    }),
    defineTool({
      name: put.name,
      effect: put.effect,
      description: [
        "Save a definition as the draft of the asset this conversation is about.",
        "A draft save changes nothing that runs: it publishes nothing and starts nothing, and the published revision stays what it is until a person publishes the draft. That is why it runs on your call without a confirmation, unless an administrator set it stricter.",
        "Send the whole config and, as 'expectedRevision', the revision you read. Answers the new draft revision; or the issues the definition is refused for, with nothing saved; or REVISION_CONFLICT where somebody saved since you read: read again, apply your change to what is there now and save with the new revision.",
        BOUND
      ].join(" "),
      inputSchema: z.object({
        config: configSchema,
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe("The 'revision' the last read of the asset answered.")
      }),
      outputSchema: putOutputSchema,
      // Runs on the agent's own call: a draft save changes nothing that runs. Without a mode
      // the instance default for changes would apply, and an agent cannot wait for a person.
      permission: { mode: "allow" },
      async execute(input, context) {
        const written = await calls.put(context, input);
        return toolSuccess(written, {
          auditSummary: {
            action: put.name,
            metadata: written.saved
              ? { saved: true, revision: written.revision }
              : {
                  saved: false,
                  ...("issues" in written
                    ? { issueCount: written.issues.length }
                    : { conflict: written.conflict })
                }
          }
        });
      }
    }),
    defineTool({
      name: operations.name,
      effect: operations.effect,
      description: [
        "List the operations a step of a Workflow may call, as far as the person you act for may see them: the name a step writes under 'operation', whether the operation reads or changes, and its input and output as JSON Schema where it has one.",
        "The list is of the instance, not of one asset. 'truncated' says that there are more operations than the list holds."
      ].join(" "),
      inputSchema: z.object({}),
      outputSchema: operationsOutputSchema,
      async execute(_input, context) {
        const listed = await calls.listOperations(context);
        return toolSuccess(listed, {
          auditSummary: {
            action: operations.name,
            metadata: { operationCount: listed.operations.length, truncated: listed.truncated }
          }
        });
      }
    })
  ];
}

const refusalDetailsSchema = z.object({
  reason: z.string().optional(),
  issues: z
    .array(
      z.object({
        message: z.string(),
        path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
        code: z.string().optional()
      })
    )
    .optional()
});

/**
 * What a refused save tells its agent, where the refusal is one the agent can act on: the
 * issues of a definition that does not hold, or the conflict of a stale revision. Any other
 * refusal, a missing right among them, is nothing here and stays the error it is.
 */
export function platformAssetWriteRefusal(
  error: unknown
): Extract<PlatformAssetWrite, { saved: false }> | undefined {
  if (!isAppError(error)) return undefined;
  if (error.code === "REVISION_CONFLICT") {
    return { saved: false, conflict: "REVISION_CONFLICT", message: error.message };
  }
  if (error.code !== "VALIDATION_FAILED") return undefined;
  const details = refusalDetailsSchema.safeParse(error.details);
  const issues = details.success ? (details.data.issues ?? []) : [];
  const reason = details.success ? details.data.reason : undefined;
  return {
    saved: false,
    issues:
      issues.length > 0
        ? issues.map((issue) => ({
            path: Array.isArray(issue.path) ? issue.path.join(".") : (issue.path ?? ""),
            message: issue.message,
            ...(issue.code === undefined ? {} : { code: issue.code })
          }))
        : [{ path: "", message: error.message, ...(reason === undefined ? {} : { code: reason }) }]
  };
}
