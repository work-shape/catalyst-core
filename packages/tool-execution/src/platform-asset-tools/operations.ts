import {
  callableOperationsPageSchema,
  OPERATIONS_AUDIENCES,
  type CallableOperationsPage,
  type CallableOperationView,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";

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

/**
 * One operation a step or an action may call, as far as the person the agent acts for may see
 * it: the shape `operations.list_callable` answers over HTTP, of which this tool is the
 * projection.
 */
export type PlatformCallableOperation = CallableOperationView;

/** What carries out the tool that lists callable operations. */
export interface PlatformOperationsCalls {
  listOperations(
    context: ToolExecutionContext,
    audience: PlatformOperationsAudience,
    input?: PlatformOperationsQuery
  ): Promise<CallableOperationsPage>;
}

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
      "List the operations a Workflow step may call, as far as the person may see them: the name a step writes under 'operation', title, description, source, whether it reads or changes and is available now, and its input and output JSON Schema.",
      "With 'for: app' it lists the Connection operations an App's connection action may call, named 'connection.<connection>.<operation>'; the action file writes the two parts as 'connection' and 'operation', with the listed effect.",
      "At most 200 a page: pass 'nextCursor' back as 'cursor' with the same filters until it is absent before you conclude an operation does not exist. Filter by exact 'name' or by 'prefix', such as 'connection.crm.'. 'truncated' without 'nextCursor' means a source left operations out; it proves no absence."
    ].join(" "),
    inputSchema: z.object({
      for: z
        .enum(OPERATIONS_AUDIENCES)
        .optional()
        .describe("'workflow' (the default) or 'app' for an App's connection action."),
      cursor: z.string().min(1).optional().describe("The previous page's nextCursor."),
      name: z.string().min(1).optional().describe("An exact full operation name."),
      prefix: z
        .string()
        .min(1)
        .optional()
        .describe("Only operation names starting with this prefix.")
    }),
    outputSchema: callableOperationsPageSchema,
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
