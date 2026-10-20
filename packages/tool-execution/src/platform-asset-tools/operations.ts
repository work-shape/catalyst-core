import {
  OPERATION_EFFECTS,
  OPERATIONS_AUDIENCES,
  type JsonObject,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";
import { jsonObjectSchema } from "./shapes";

const { operations } = PLATFORM_ASSET_TOOLS;

/**
 * Who would call the listed operations: a step of a Workflow, or a `connection` action of an
 * App. Each is offered the operations exposed to its own surface.
 */
export type PlatformOperationsAudience = (typeof OPERATIONS_AUDIENCES)[number];

/** Filters and the continuation of one callable-operation page. */
export interface PlatformOperationsQuery {
  cursor?: string;
  name?: string;
  prefix?: string;
}

/** One operation a step or an action may call, as far as the person the agent acts for may see it. */
export interface PlatformCallableOperation {
  name: string;
  effect: (typeof OPERATION_EFFECTS)[number];
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}

/** What carries out the tool that lists callable operations. */
export interface PlatformOperationsCalls {
  listOperations(
    context: ToolExecutionContext,
    audience: PlatformOperationsAudience,
    input?: PlatformOperationsQuery
  ): Promise<{ operations: PlatformCallableOperation[]; nextCursor?: string; truncated: boolean }>;
}

const operationsOutputSchema = z.object({
  operations: z.array(
    z.object({
      name: z.string(),
      effect: z.enum(OPERATION_EFFECTS),
      inputSchema: jsonObjectSchema.optional(),
      outputSchema: jsonObjectSchema.optional()
    })
  ),
  nextCursor: z.string().optional(),
  truncated: z.boolean()
});

/** The tool that lists the operations a Workflow step or an App action may call. */
export function createOperationsTool(calls: PlatformOperationsCalls): AnyToolDefinition {
  return defineTool({
    name: operations.name,
    title: { en: "List callable operations", de: "Aufrufbare Operationen auflisten" },
    summary: {
      en: "Lists a page of operations a Workflow step or an App action may call; filter by name or prefix.",
      de: "Listet eine Seite aufrufbarer Operationen für Workflow-Schritte oder App-Aktionen; nach Name oder Präfix filtern."
    },
    group: "platform",
    icon: "guide",
    effect: operations.effect,
    description: [
      "List the operations a step of a Workflow may call, as far as the person you act for may see them: the name a step writes under 'operation', whether the operation reads or changes, and its input and output as JSON Schema where it has one.",
      "With 'for: app' it lists instead the operations of Connections that an App's connection action may call, each named 'connection.<connection>.<operation>': the action file writes the two parts as 'connection' and 'operation', and the effect as it is listed.",
      "Each page holds at most 200 operations. Pass 'nextCursor' back as 'cursor', keeping 'for', 'name' and 'prefix' unchanged, until 'nextCursor' is absent. Filter by exact 'name' or by 'prefix', such as 'connection.crm.' or 'data_store.orders.', to find one Connection's or store's operations directly. Do this before concluding an operation does not exist. 'truncated' without 'nextCursor' means a source left operations out; it does not prove absence."
    ].join(" "),
    inputSchema: z.object({
      for: z
        .enum(OPERATIONS_AUDIENCES)
        .optional()
        .describe(
          "Who calls the operations: 'workflow' for a step of a Workflow (the default), 'app' for an App's connection action."
        ),
      cursor: z.string().min(1).optional().describe("The previous page's nextCursor."),
      name: z.string().min(1).optional().describe("An exact full operation name."),
      prefix: z
        .string()
        .min(1)
        .optional()
        .describe("Only operation names starting with this prefix.")
    }),
    outputSchema: operationsOutputSchema,
    async execute(input, context) {
      const listed = await calls.listOperations(context, input.for ?? "workflow", input);
      return toolSuccess(listed, {
        auditSummary: {
          action: operations.name,
          metadata: {
            for: input.for ?? "workflow",
            operationCount: listed.operations.length,
            truncated: listed.truncated
          }
        }
      });
    }
  });
}
